/**
 * A device's home bases: the berths, yards and houses where arriving ends a trip.
 *
 * A home base is a softlink in the device's `homes/` directory, named by the location's slug:
 * `<device>/homes/<slug>` → `/archive/locations/<slug>`. A device that lists none has its owners'
 * homes instead: each residence of a person who owned it, for the part of the residence that falls
 * while they did.
 */

import { basename, resolve } from '@std/path';
import type { Command } from '@ein/client';
import type { DeviceHome, DeviceHomes } from '@archive/device/api';
import { POSITION_CHILD } from '@archive/location/location-link';
import { comparableDate, readRelationDir } from '@archive/people/genealogy';
import { HOMES_DIR, readResidences } from '@archive/people/residence';
import { OWNERS_DIR } from '@archive/device/device';

const DEVICE_HOMES_DIR = 'homes';

const NODE_TYPE_LOCATION = 'location';

/** `homes/` link name → the location it points at, resolved. */
const homeLinks = async (cmd: Command, device: string): Promise<Map<string, string>> => {
  const dir = `${device}/${DEVICE_HOMES_DIR}`;
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

/** The device's own home bases, or its owners' residences when it lists none. */
export const readDeviceHomes = async (cmd: Command, device: string): Promise<DeviceHomes> => {
  const own: DeviceHome[] = [];
  for (const location of new Set((await homeLinks(cmd, device)).values())) {
    const place = await describe(cmd, location);
    if (place) own.push({ location, source: 'device', ...place });
  }
  if (own.length > 0) return { device, homes: own };

  const homes: DeviceHome[] = [];
  const places = new Map<string, Awaited<ReturnType<typeof describe>>>();
  for (const owner of await readRelationDir(cmd.sys.vfs, cmd.access, device, OWNERS_DIR)) {
    if (!owner.target) continue;
    const person = resolve(`${device}/${OWNERS_DIR}`, owner.target);
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
  return { device, homes };
};

/** Make `location` one of the device's home bases. False when it was one already. */
export const addDeviceHome = async (cmd: Command, device: string, location: string): Promise<boolean> => {
  const node = await cmd.sys.vfs.get(cmd.access, location);
  if (node.type !== NODE_TYPE_LOCATION) throw new Error(`${location}: not a location (${node.type})`);
  const links = await homeLinks(cmd, device);
  if ([...links.values()].includes(location)) return false;

  // The directory is shared as the device is, so whoever reads the device reads its homes.
  const { mode, gid, acl } = (await cmd.sys.vfs.get(cmd.access, device)).props;
  await cmd.sys.vfs.ensure(cmd.access, 'directory', device, DEVICE_HOMES_DIR, { props: { mode, gid, ...(acl?.length ? { acl } : {}) } });
  let name = basename(location);
  for (let n = 2; links.has(name); n++) name = `${basename(location)}-${n}`;
  await cmd.sys.vfs.create(cmd.access, 'softlink', `${device}/${DEVICE_HOMES_DIR}`, name, {
    props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: location },
  });
  return true;
};

/** Take `location` off the device's home bases, and `homes/` with the last one. False when it was not one. */
export const removeDeviceHome = async (cmd: Command, device: string, location: string): Promise<boolean> => {
  const dir = `${device}/${DEVICE_HOMES_DIR}`;
  const names = [...(await homeLinks(cmd, device))].filter(([, target]) => target === location).map(([name]) => name);
  for (const name of names) await cmd.sys.vfs.unlink(cmd.access, `${dir}/${name}`, dir, { readlink: true });
  if (names.length > 0 && (await cmd.sys.vfs.childCount(cmd.access, dir, { all: true })) === 0) await cmd.sys.vfs.unlink(cmd.access, dir, device);
  return names.length > 0;
};
