/**
 * Every camera's faces and clips: what the media service sees on each camera under /dev, matched
 * to the archive's people, and the video around it.
 *
 * A camera is a device with a `stream` endpoint. Its smallest stream is given to EMS as a watch,
 * `ein-<device>-<endpoint>`, at the address its driver names (`streamSource`), its largest to be
 * recorded for clips; every minute the watches are stated again, as after EMS started anew, and
 * those of cameras gone are stopped. What a watch tells:
 *
 * - **a face**, within a second or so of its coming: voted on by every stored face that belongs to
 *   someone, as a photo's face is (`matchFace`), and appended to the camera's `faces` log as that
 *   person's name, or `unknown` for nobody or an unnamed person: `dev.<device>.faces`, which
 *   automations take.
 * - **the face gone**: its best crop filed as a picture under the camera's archive node
 *   (`/archive/cameras/<camera>/faces/<day>/<time>-<track>.jpg`, the node made and linked to the
 *   device when the camera has none), where the archive finds the face and assigns it like any
 *   photo's: to a person, or to a new unnamed one in `/archive/people/unknown`, named there.
 * - **a clip**, the stream from a little before a face (or motion, as the camera node's `clips`
 *   says) until a little after it: filed as a video beside the faces
 *   (`<camera>/clips/<day>/<time>.mp4`), where the archive's pipeline takes it as any video, and
 *   dropped from EMS. A camera's clips are kept for its `clipDays`, each hour's sweep removing the
 *   days past that.
 *
 * Everything runs as the administrator, the service's account.
 */

import type { DeviceAttrs, EndpointAttrs } from '@ein/api';
import { ADMIN_ACCESS, type Command, shq } from '@ein/client';
import { DEV_PATH, devicePath } from '@ein/paths';
import { basename, dirname } from '@std/path';
import { clipBody, deleteWatch, dropClip, listWatches, putWatch, requestClip, type WatchEvent, watchEvents, type WatchSpec } from '@ems/client';
import type { CameraAttrs } from '@archive/camera/types';
import { CLIP_TRIGGERS, type ClipTrigger, DEFAULT_CLIP_DAYS } from '@archive/camera/api';
import { CAMERAS_ROOT, NODE_TYPE_CAMERA, slugifyCameraName } from '@archive/camera/camera';
import { CAMERA_DEVICE_LINK } from '@archive/location/track';
import { matchFace } from '@archive/media/face-assign';

/** The prefix of the watches this service states, so the others on the same EMS are left alone. */
const WATCH_PREFIX = 'ein-';
/** The event log a camera's faces are told on. */
export const FACES_ENDPOINT = 'faces';
/** What the log says of a face no person won. */
export const UNKNOWN_FACE = 'unknown';
/** The folder of a camera node its clips are filed in, by day. */
export const CLIPS_DIR = 'clips';

const RESTATE_EVERY_MS = 60_000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Frames a second EMS looks at. */
const FACES_FPS = 3;
/** Seconds of a clip before what opened it, and after it ended. */
const CLIP_PRE = 5;
const CLIP_POST = 10;
const SWEEP_EVERY_MS = 3_600_000;

/** One stream to watch: the camera's device, its endpoint, and the watch's id. */
type Wanted = { device: string; endpoint: string; id: string; spec: WatchSpec };
/** A device with streams: the smallest, watched, and the largest, recorded. */
type Camera = { device: string; endpoint: string; largest: string };

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The watch id of a camera's stream. */
export const watchId = (device: string, endpoint: string): string => `${WATCH_PREFIX}${device}-${endpoint}`;

/**
 * Each device with a stream, its smallest one (the fewest pixels, which costs EMS the least to
 * read) and its largest.
 */
const cameras = async (cmd: Command): Promise<Camera[]> => {
  const out = [];
  for (const child of await cmd.sys.vfs.children<DeviceAttrs>(ADMIN_ACCESS, DEV_PATH).catch(() => [])) {
    if (child.node.type !== 'device') continue;
    const streams = (await cmd.sys.vfs.children<EndpointAttrs>(ADMIN_ACCESS, devicePath(child.name)).catch(() => []))
      .filter((endpoint) => endpoint.node.type === 'stream' && !endpoint.node.attrs.retired);
    const pixels = (attrs: EndpointAttrs) => (attrs.width ?? Infinity) * (attrs.height ?? 1);
    streams.sort((a, b) => pixels(a.node.attrs) - pixels(b.node.attrs));
    if (streams.length > 0) out.push({ device: child.name, endpoint: streams[0].name, largest: streams.at(-1)!.name });
  }
  return out;
};

/** The watch of a device's camera: of its smallest stream. Throws for a device with none. */
const cameraWatch = async (cmd: Command, device: string): Promise<string> => {
  const camera = (await cameras(cmd)).find((each) => each.device === device);
  if (!camera) throw new Error(`${device} is not a camera: it has no stream`);
  return watchId(camera.device, camera.endpoint);
};

/** Open a clip of a device's camera now, or lengthen the open one: filed once EMS has cut it. Answers its id. */
export const cameraClip = async (cmd: Command, device: string, post?: number): Promise<string> => await requestClip(cmd, await cameraWatch(cmd, device), post);

/** The archive's camera that links the device, when one does. */
const linkedCamera = async (cmd: Command, device: string): Promise<string | undefined> => {
  const links = (await cmd.sys.vfs.findLinks(ADMIN_ACCESS, [devicePath(device)])).filter((link) => basename(link.absPath) === CAMERA_DEVICE_LINK);
  const linked = links.find((link) => dirname(dirname(link.absPath)) === CAMERAS_ROOT);
  return linked ? dirname(linked.absPath) : undefined;
};

/** What opens a clip of a camera node's device, and how many days its clips are kept: its `clips` and `clipDays`, or the defaults. */
const clipSettings = (attrs: Partial<CameraAttrs> | undefined): { trigger: ClipTrigger; days: number } => ({
  trigger: CLIP_TRIGGERS.find((each) => each === attrs?.clips) ?? 'face',
  days: typeof attrs?.clipDays === 'number' && attrs.clipDays >= 0 ? attrs.clipDays : DEFAULT_CLIP_DAYS,
});

/** The archive's camera that links the device, made and linked when there is none. Answers its path. */
const cameraNodeOf = async (cmd: Command, device: string): Promise<string> => {
  const linked = await linkedCamera(cmd, device);
  if (linked) return linked;
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

/**
 * A file under the camera's archive node, in `<camera>/<kind>/<day>/`, named by the time of day
 * and `tag`, `-2` and on when that is taken, and `ext`. A file whose bytes do not all arrive is removed.
 * Answers its path.
 */
const fileUnder = async (
  cmd: Command,
  camera: string,
  kind: string,
  at: Date,
  tag: string,
  ext: string,
  mimetype: string,
  bytes: Uint8Array | ReadableStream<Uint8Array>,
): Promise<string> => {
  const vfs = cmd.sys.vfs;
  const { day, time } = dayAndTime(at);
  await vfs.ensure(ADMIN_ACCESS, 'directory', camera, kind);
  await vfs.ensure(ADMIN_ACCESS, 'directory', `${camera}/${kind}`, day);
  const folder = `${camera}/${kind}/${day}`;
  let name = `${time}${tag}.${ext}`;
  for (let n = 2; await vfs.exists(ADMIN_ACCESS, `${folder}/${name}`); n++) name = `${time}${tag}-${n}.${ext}`;
  await vfs.create(ADMIN_ACCESS, 'file', folder, name, { attrs: { mimetype } });
  const path = `${folder}/${name}`;
  try {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      if (bytes instanceof Uint8Array) await handle.write(bytes);
      else for await (const chunk of bytes) await handle.write(chunk);
    } finally {
      await handle.close();
    }
  } catch (error) {
    await cmd.execute(`rm ${shq(path)}`);
    throw error;
  }
  return path;
};

/**
 * Each camera's clip days older than its `clipDays` removed: the folders under `<camera>/clips`
 * named for a day before that many days ago.
 */
const sweepClips = async (cmd: Command, now = new Date()): Promise<string[]> => {
  const removed: string[] = [];
  for (const camera of await cmd.sys.vfs.children<CameraAttrs>(ADMIN_ACCESS, CAMERAS_ROOT).catch(() => [])) {
    if (camera.node.type !== NODE_TYPE_CAMERA) continue;
    const { days } = clipSettings(camera.node.attrs);
    if (days === 0) continue;
    const folder = `${CAMERAS_ROOT}/${camera.name}/${CLIPS_DIR}`;
    const oldest = dayAndTime(new Date(now.getTime() - days * 86_400_000)).day;
    for (const day of await cmd.sys.vfs.children(ADMIN_ACCESS, folder).catch(() => [])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.name) || day.name >= oldest) continue;
      const result = await cmd.execute(`rm -r ${shq(`${folder}/${day.name}`)}`);
      if (result.code !== 0) throw new Error(`${folder}/${day.name}: ${result.stderr.trim() || `exit ${result.code}`}`);
      removed.push(`${folder}/${day.name}`);
    }
  }
  return removed;
};

/**
 * What a face is called on the camera's log: the person's name, or `unknown` for nobody and for an
 * unnamed person, whom recognition knows again but the household has not named.
 */
const faceName = async (cmd: Command, embedding: number[]): Promise<string> => {
  const match = embedding.length > 0 ? await matchFace(cmd.sys.vfs, ADMIN_ACCESS, embedding) : undefined;
  if (!match) return UNKNOWN_FACE;
  const person = (await cmd.sys.vfs.getNodesByIds<{ name?: string; unnamed?: boolean }>(ADMIN_ACCESS, [match.personId])).get(match.personId);
  return person && !person.attrs.unnamed && person.attrs.name ? person.attrs.name : UNKNOWN_FACE;
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
      await fileUnder(cmd, camera, FACES_ENDPOINT, new Date(event.at), `-${event.track}`, 'jpg', 'image/jpeg', jpeg);
    } else if (event.type === 'clip') {
      const camera = await cameraNodeOf(cmd, wanted.device);
      await fileUnder(cmd, camera, CLIPS_DIR, new Date(event.start), '', 'mp4', 'video/mp4', await clipBody(cmd, wanted.id, event.clip));
      await dropClip(cmd, wanted.id, event.clip);
    } else if (event.type === 'clip.failed') {
      log(`${wanted.device}: a clip: ${event.reason}`);
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
    for (const { device, endpoint, largest } of await cameras(cmd)) {
      try {
        const source = await devices.streamSource(ADMIN_ACCESS, device, endpoint);
        const camera = await linkedCamera(cmd, device);
        const { trigger } = clipSettings(camera ? (await cmd.sys.vfs.get<CameraAttrs>(ADMIN_ACCESS, camera)).attrs : undefined);
        const clips: WatchSpec['clips'] = trigger === 'off' ? undefined : {
          on: trigger === 'motion' ? ['face', 'motion'] : ['face'],
          pre: CLIP_PRE,
          post: CLIP_POST,
          source: largest === endpoint ? source : await devices.streamSource(ADMIN_ACCESS, device, largest),
        };
        const spec: WatchSpec = { source, faces: { fps: FACES_FPS }, motion: true, crops: true, ...(clips ? { clips } : {}) };
        wanted.push({ device, endpoint, id: watchId(device, endpoint), spec });
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
  let swept = 0;
  const loop = async () => {
    await restate().catch((error) => log(`cameras: ${message(error)}`));
    if (Date.now() - swept >= SWEEP_EVERY_MS) {
      swept = Date.now();
      await sweepClips(cmd).catch((error) => log(`clips: ${message(error)}`));
    }
    timer = setTimeout(loop, RESTATE_EVERY_MS);
  };
  await loop();
  await stopped;
  clearTimeout(timer);
  for (const abort of following.values()) abort.abort();
};
