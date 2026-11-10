/**
 * Every camera's faces: what the media service sees on each camera under /dev, matched to the
 * archive's people.
 *
 * A camera is a device with a `stream` endpoint. Its smallest stream is given to EMS as a watch,
 * `ein-<device>-<endpoint>`, at the address its driver names (`streamSource`); every minute the
 * watches are stated again, as after EMS started anew, and those of cameras gone are stopped.
 * What a watch tells:
 *
 * - **a face**, within a second or so of its coming: voted on by every stored face that belongs to
 *   someone, as a photo's face is (`matchFace`), and appended to the camera's `faces` log as that
 *   person's name, or `unknown`: `dev.<device>.faces`, which automations take.
 * - **the face gone**: its best crop filed as a picture under the camera's archive node
 *   (`/archive/cameras/<camera>/faces/<day>/<time>-<track>.jpg`, the node made and linked to the
 *   device when the camera has none), where the archive finds the face and assigns it like any
 *   photo's: to a person, or to a new unnamed one in `/archive/people/unknown`, named there.
 *
 * Everything runs as the administrator, the service's account.
 */

import type { DeviceAttrs, EndpointAttrs } from '@ein/api';
import { ADMIN_ACCESS, type Command, shq } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import { basename, dirname } from '@std/path';
import { deleteWatch, listWatches, putWatch, type WatchEvent, watchEvents, type WatchSpec } from '@ems/client';
import { CAMERAS_ROOT, NODE_TYPE_CAMERA, slugifyCameraName } from '@archive/camera/camera';
import { CAMERA_DEVICE_LINK } from '@archive/location/track';
import { matchFace } from '@archive/media/face-assign';

/** The prefix of the watches this service states, so the others on the same EMS are left alone. */
const WATCH_PREFIX = 'ein-';
/** The event log a camera's faces are told on. */
export const FACES_ENDPOINT = 'faces';
/** What the log says of a face no person won. */
export const UNKNOWN_FACE = 'unknown';

const RESTATE_EVERY_MS = 60_000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Frames a second EMS looks at. */
const FACES_FPS = 3;

/** One stream to watch: the camera's device, its endpoint, and the watch's id. */
type Wanted = { device: string; endpoint: string; id: string; spec: WatchSpec };

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The watch id of a camera's stream. */
export const watchId = (device: string, endpoint: string): string => `${WATCH_PREFIX}${device}-${endpoint}`;

/** Each device with a stream, and its smallest one: the fewest pixels, which costs EMS the least to read. */
const cameras = async (cmd: Command): Promise<{ device: string; endpoint: string }[]> => {
  const out = [];
  for (const child of await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => [])) {
    if (child.node.type !== 'device') continue;
    const streams = (await cmd.sys.vfs.children<EndpointAttrs>(ADMIN_ACCESS, devicePath(child.name)).catch(() => []))
      .filter((endpoint) => endpoint.node.type === 'stream' && !endpoint.node.attrs.retired);
    const pixels = (attrs: EndpointAttrs) => (attrs.width ?? Infinity) * (attrs.height ?? 1);
    const smallest = streams.sort((a, b) => pixels(a.node.attrs) - pixels(b.node.attrs))[0];
    if (smallest) out.push({ device: child.name, endpoint: smallest.name });
  }
  return out;
};

/** The archive's camera that links the device, made and linked when there is none. Answers its path. */
const cameraNodeOf = async (cmd: Command, device: string): Promise<string> => {
  const links = (await cmd.sys.vfs.findLinks(ADMIN_ACCESS, [devicePath(device)])).filter((link) => basename(link.absPath) === CAMERA_DEVICE_LINK);
  const linked = links.find((link) => dirname(dirname(link.absPath)) === CAMERAS_ROOT);
  if (linked) return dirname(linked.absPath);
  const label = (await cmd.sys.vfs.get<DeviceAttrs>(ADMIN_ACCESS, devicePath(device))).attrs.label || device;
  const path = `${CAMERAS_ROOT}/${slugifyCameraName(label)}`;
  const existing = await cmd.sys.vfs.get(ADMIN_ACCESS, path).catch(() => undefined);
  if (existing && existing.type !== NODE_TYPE_CAMERA) throw new Error(`${path} is a ${existing.type}, not a camera`);
  const steps = [...(existing ? [] : [`camera-create ${shq(path)} --name ${shq(label)}`]), `camera-device ${shq(path)} ${shq(device)}`];
  for (const step of steps) {
    const result = await cmd.execute(step);
    if (result.code !== 0) throw new Error(`${step}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return path;
};

/** A day and a time of day, in this machine's time zone, as a picture's folder and name take them. */
const dayAndTime = (at: Date): { day: string; time: string } => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at).map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}${parts.minute}${parts.second}` };
};

/** A face's crop filed as a picture under the camera's archive node. Answers its path. */
const fileFace = async (cmd: Command, camera: string, at: Date, track: number, jpeg: Uint8Array): Promise<string> => {
  const vfs = cmd.sys.vfs;
  const { day, time } = dayAndTime(at);
  await vfs.ensure(ADMIN_ACCESS, 'directory', camera, FACES_ENDPOINT);
  await vfs.ensure(ADMIN_ACCESS, 'directory', `${camera}/${FACES_ENDPOINT}`, day);
  const folder = `${camera}/${FACES_ENDPOINT}/${day}`;
  let name = `${time}-${track}.jpg`;
  for (let n = 2; await vfs.exists(ADMIN_ACCESS, `${folder}/${name}`); n++) name = `${time}-${track}-${n}.jpg`;
  await vfs.create(ADMIN_ACCESS, 'file', folder, name, { attrs: { mimetype: 'image/jpeg' } });
  const handle = await vfs.open(ADMIN_ACCESS, `${folder}/${name}`, { mode: 'w' });
  try {
    await handle.write(jpeg);
  } finally {
    await handle.close();
  }
  return `${folder}/${name}`;
};

/** What a face is called on the camera's log: the person's name, or `unknown`. */
const faceName = async (cmd: Command, embedding: number[]): Promise<string> => {
  const match = embedding.length > 0 ? await matchFace(cmd.sys.vfs, ADMIN_ACCESS, embedding) : undefined;
  if (!match) return UNKNOWN_FACE;
  const person = (await cmd.sys.vfs.getNodesByIds<{ name?: string }>(ADMIN_ACCESS, [match.personId])).get(match.personId);
  return person?.attrs.name || UNKNOWN_FACE;
};

/**
 * Watch every camera until `stopped` resolves: the watches stated now and every minute, each one's
 * events followed and acted on. `log` hears what went wrong, once until it goes right again.
 */
export const watchCameras = async (cmd: Command, stopped: Promise<void>, log: (line: string) => void): Promise<void> => {
  const devices = cmd.sys.devices;
  if (!devices) throw new Error('this EiN keeps no devices');
  const following = new Map<string, AbortController>();
  const said = new Set<string>();
  const once = (key: string, line: string) => {
    if (!said.has(key)) log(line);
    said.add(key);
  };

  const onEvent = async (wanted: Wanted, event: WatchEvent) => {
    if (event.type === 'face') {
      const name = await faceName(cmd, event.embedding);
      await devices.ensureEndpoint(ADMIN_ACCESS, wanted.device, FACES_ENDPOINT, 'log', { label: 'Faces', events: true }, 0o640);
      await devices.append(ADMIN_ACCESS, wanted.device, FACES_ENDPOINT, name, { at: new Date(event.at) });
    } else if (event.type === 'face.end' && event.crop) {
      const camera = await cameraNodeOf(cmd, wanted.device);
      const jpeg = Uint8Array.from(atob(event.crop.data), (char) => char.charCodeAt(0));
      await fileFace(cmd, camera, new Date(event.at), event.track, jpeg);
    }
  };

  /** One watch's events, followed again after a pause that doubles while it keeps failing. */
  const follow = async (wanted: Wanted, abort: AbortController) => {
    let backoff = MIN_BACKOFF_MS;
    while (!abort.signal.aborted) {
      try {
        await putWatch(cmd, wanted.id, wanted.spec);
        for await (const event of watchEvents(cmd, wanted.id, abort.signal)) {
          backoff = MIN_BACKOFF_MS;
          said.delete(`follow ${wanted.id}`);
          await onEvent(wanted, event).catch((error) => log(`${wanted.device}: ${event.type}: ${message(error)}`));
        }
      } catch (error) {
        once(`follow ${wanted.id}`, `${wanted.device}: ${message(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  };

  const restate = async () => {
    const wanted: Wanted[] = [];
    for (const { device, endpoint } of await cameras(cmd)) {
      try {
        const source = await devices.streamSource(ADMIN_ACCESS, device, endpoint);
        wanted.push({ device, endpoint, id: watchId(device, endpoint), spec: { source, faces: { fps: FACES_FPS }, motion: true, crops: true } });
        said.delete(`source ${device}`);
      } catch (error) {
        once(`source ${device}`, `${device}: not watched: ${message(error)}`);
      }
    }
    const ids = new Set(wanted.map((each) => each.id));
    for (const [id, abort] of following) {
      if (ids.has(id)) continue;
      abort.abort();
      following.delete(id);
    }
    try {
      for (const watch of await listWatches(cmd)) {
        if (watch.id.startsWith(WATCH_PREFIX) && !ids.has(watch.id)) await deleteWatch(cmd, watch.id);
      }
      for (const each of wanted) await putWatch(cmd, each.id, each.spec);
      said.delete('ems');
    } catch (error) {
      once('ems', `the media service: ${message(error)}`);
    }
    for (const each of wanted) {
      if (following.has(each.id)) continue;
      const abort = new AbortController();
      following.set(each.id, abort);
      void follow(each, abort);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    await restate().catch((error) => log(`cameras: ${message(error)}`));
    timer = setTimeout(loop, RESTATE_EVERY_MS);
  };
  await loop();
  await stopped;
  clearTimeout(timer);
  for (const abort of following.values()) abort.abort();
};
