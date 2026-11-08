/**
 * A track's home bases: the berths, yards and houses where arriving ends a trip.
 *
 * A home base is a softlink in the track's `homes/` directory, named by the location's slug:
 * `<track>/homes/<slug>` → `/archive/locations/<slug>`. A track that lists none has the homes of the
 * owners of the cameras linked to its device instead: each residence of a person who owned such a
 * camera, for the part of the residence that falls while they did.
 */

import { basename, resolve } from '@std/path';
import type { Command } from '@ein/client';
import type { TrackHome, TrackHomes } from '@archive/location/api';
import { POSITION_CHILD } from '@archive/location/location-link';
import { trackCameras } from '@archive/location/track';
import { comparableDate, readRelationDir } from '@archive/people/genealogy';
import { HOMES_DIR, readResidences } from '@archive/people/residence';
import { OWNERS_DIR } from '@archive/camera/camera';

const TRACK_HOMES_DIR = 'homes';

const NODE_TYPE_LOCATION = 'location';

/** `homes/` link name → the location it points at, resolved. */
const homeLinks = async (cmd: Command, track: string): Promise<Map<string, string>> => {
  const dir = `${track}/${TRACK_HOMES_DIR}`;
  const links = new Map<string, string>();
  if (!(await cmd.sys.vfs.exists(cmd.access, dir, { follow: false }))) return links;
  for (const entry of await cmd.sys.vfs.children(cmd.access, dir, { follow: false })) {
    if (entry.node.props.softlink) links.set(entry.name, resolve(dir, entry.node.props.softlink));
  }
  return links;
};

/** The later of two starts and the earlier of two ends; undefined when the spans do not meet. */
const overlap = (a: { from?: string; to?: string }, b: { from?: string; to?: string }): { from?: string; to?: string } | undefined => {
  const later = (x?: string, y?: string) => !x ? y : !y ? x : comparableDate(x) >= comparableDate(y) ? x : y;
  const earlier = (x?: string, y?: string) => !x ? y : !y ? x : comparableDate(x) <= comparableDate(y) ? x : y;
  const from = later(a.from, b.from);
  const to = earlier(a.to, b.to);
  if (from && to && comparableDate(to) < comparableDate(from)) return undefined;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
};

/** The location's name and point, or undefined when it is gone or is not a location. */
const describe = async (cmd: Command, location: string): Promise<{ name: string; lat?: number; lng?: number } | undefined> => {
  let node;
  try {
    node = await cmd.sys.vfs.get(cmd.access, location);
  } catch {
    return undefined;
  }
  if (node.type !== NODE_TYPE_LOCATION) return undefined;
  const name = typeof node.attrs.name === 'string' && node.attrs.name.trim() ? node.attrs.name : basename(location);
  try {
    const shape = await cmd.sys.vfs.get(cmd.access, `${location}/${POSITION_CHILD}`);
    const point = (await cmd.sys.vfs.getPoints(cmd.access, [shape.id])).get(shape.id);
    if (point) return { name, lat: point.lat, lng: point.lng };
  } catch {
    // A location without a position is still a home; it just cannot be arrived at yet.
  }
  return { name };
};

/** The track's own home bases, or the residences of its cameras' owners when it lists none. */
export const readTrackHomes = async (cmd: Command, track: string): Promise<TrackHomes> => {
  const own: TrackHome[] = [];
  for (const location of new Set((await homeLinks(cmd, track)).values())) {
    const place = await describe(cmd, location);
    if (place) own.push({ location, source: 'track', ...place });
  }
  if (own.length > 0) return { track, homes: own };

  const homes: TrackHome[] = [];
  const places = new Map<string, Awaited<ReturnType<typeof describe>>>();
  for (const camera of (await trackCameras(cmd, [track])).get(track) ?? []) {
    for (const owner of await readRelationDir(cmd.sys.vfs, cmd.access, camera.path, OWNERS_DIR)) {
      if (!owner.target) continue;
      const person = resolve(`${camera.path}/${OWNERS_DIR}`, owner.target);
      for (const residence of await readResidences(cmd.sys.vfs, cmd.access, person)) {
        if (!residence.target) continue;
        const span = overlap(owner, residence);
        if (!span) continue;
        const location = resolve(`${person}/${HOMES_DIR}`, residence.target);
        if (!places.has(location)) places.set(location, await describe(cmd, location));
        const place = places.get(location);
        if (place) homes.push({ location, source: 'owner', owner: person, ...span, ...place });
      }
    }
  }
  return { track, homes };
};

/** Make `location` one of the track's home bases. False when it was one already. */
export const addTrackHome = async (cmd: Command, track: string, location: string): Promise<boolean> => {
  const node = await cmd.sys.vfs.get(cmd.access, location);
  if (node.type !== NODE_TYPE_LOCATION) throw new Error(`${location}: not a location (${node.type})`);
  const links = await homeLinks(cmd, track);
  if ([...links.values()].includes(location)) return false;

  // The directory is shared as the track is, so whoever reads the track reads its homes.
  const { mode, gid, acl } = (await cmd.sys.vfs.get(cmd.access, track)).props;
  await cmd.sys.vfs.ensure(cmd.access, 'directory', track, TRACK_HOMES_DIR, { props: { mode, gid, ...(acl?.length ? { acl } : {}) } });
  let name = basename(location);
  for (let n = 2; links.has(name); n++) name = `${basename(location)}-${n}`;
  await cmd.sys.vfs.create(cmd.access, 'softlink', `${track}/${TRACK_HOMES_DIR}`, name, {
    props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: location },
  });
  return true;
};

/** Take `location` off the track's home bases, and `homes/` with the last one. False when it was not one. */
export const removeTrackHome = async (cmd: Command, track: string, location: string): Promise<boolean> => {
  const dir = `${track}/${TRACK_HOMES_DIR}`;
  const names = [...(await homeLinks(cmd, track))].filter(([, target]) => target === location).map(([name]) => name);
  for (const name of names) await cmd.sys.vfs.unlink(cmd.access, `${dir}/${name}`, dir, { readlink: true });
  if (names.length > 0 && (await cmd.sys.vfs.childCount(cmd.access, dir, { all: true })) === 0) await cmd.sys.vfs.unlink(cmd.access, dir, track);
  return names.length > 0;
};
