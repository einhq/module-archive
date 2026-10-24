/**
 * What grouping reads about staged files and the places they may be at.
 *
 * `readSignals` reads a page of up to `SIGNAL_PAGE` file ids in three rounds of lookups by id:
 * each file's children (its `position`, `regions/`, `people/`, `location` and `sidecar`); the GPS
 * fixes, beside the children of those `regions/` and `people/` directories; and the region, link
 * and sidecar nodes themselves, for each region's `personId`, each link's target and each
 * sidecar's phone folder. The only paths it resolves are the distinct people the `people/` tags
 * name, once each, and the sidecars an edited copy shares through a softlink; nothing is searched
 * and no attr index is needed, so the cost follows the inbox, not the archive. `readLocations` is
 * the one query, over the locations.
 */
import type { Access, NodeChild, NodeId, NodeQuery, NodeQueryEntry, NodeVFS } from '@ein/client';
import { LOCATIONS_ROOT } from '@archive/paths';
import { NODE_TYPE_PERSON } from '@archive/people/types';
import { REGION_TYPE, REGIONS_DIR } from '@archive/media/regions';
import { LOCATION_LINK_NAME, POSITION_CHILD } from '@archive/location/location-link';
import { SIDECAR_CHILD, sidecarOf } from '@archive/media/paired-sidecar';

/** File ids read per round of lookups. */
const SIGNAL_PAGE = 1000;

/** `<file>/people/<slug>`: a person in the picture, without a box. */
export const PEOPLE_DIR = 'people';

type Geo = { lat: number; lng: number };

type FileSignals = {
  /** The GPS fix, from the file's own `position` child. */
  point?: Geo;
  /** That child's id, for the reverse geocode it carries. */
  positionId?: NodeId;
  /** Person ids: the faces' `personId`s and the boxless `people/` tags, each once. */
  persons: NodeId[];
  /** Where the file's `location` link points. */
  location?: string;
  /** The phone folder a Google Photos upload came from, as its paired Takeout sidecar says. */
  localFolder?: string;
};

/** Every row a query matches, a page at a time. */
const queryAll = async (vfs: NodeVFS, access: Access, query: Omit<NodeQuery, 'after'>): Promise<NodeQueryEntry[]> => {
  const rows: NodeQueryEntry[] = [];
  let after: NodeQuery['after'];
  while (true) {
    const page = await vfs.query(access, { ...query, after });
    if (page.length === 0) return rows;
    rows.push(...page);
    const last = page[page.length - 1];
    after = { value: last.sortValue, id: last.id };
  }
};

/** The id of the child named `name` under each node that has one. */
const childNamed = (links: Map<NodeId, { id: NodeId; name: string }[]>, name: string): Map<NodeId, NodeId> => {
  const found = new Map<NodeId, NodeId>();
  for (const [parent, children] of links) {
    const child = children.find((entry) => entry.name === name);
    if (child) found.set(parent, child.id);
  }
  return found;
};

/** The point of each of `ids` (files, locations) that has a `position` child with one. */
export const pointsOf = async (vfs: NodeVFS, access: Access, ids: NodeId[]): Promise<Map<NodeId, Geo>> => {
  const positions = childNamed(await vfs.getChildLinksByIds(access, ids), POSITION_CHILD);
  const points = await vfs.getPoints(access, [...positions.values()]);
  const out = new Map<NodeId, Geo>();
  for (const [id, positionId] of positions) {
    const point = points.get(positionId);
    if (point) out.set(id, point);
  }
  return out;
};

/** A location directly under the locations root, with its point and the name it is shown by. */
export type LocationPoint = Geo & { path: string; id: NodeId; name: string };

/** Every location `access` can read that has a point: one query and two batched lookups. */
export const readLocations = async (vfs: NodeVFS, access: Access): Promise<LocationPoint[]> => {
  const prefix = `${LOCATIONS_ROOT}/`;
  const rows = (await queryAll(vfs, access, { types: ['location'], limit: SIGNAL_PAGE }))
    .filter((row) => row.absPath.startsWith(prefix) && !row.absPath.slice(prefix.length).includes('/'));
  const points = await pointsOf(vfs, access, rows.map((row) => row.id));
  return rows.flatMap((row) => {
    const point = points.get(row.id);
    const attrs = row.node.attrs as { name?: unknown; displayName?: unknown };
    const name = typeof attrs.name === 'string' && attrs.name
      ? attrs.name
      : typeof attrs.displayName === 'string' && attrs.displayName
      ? attrs.displayName
      : row.absPath.slice(prefix.length);
    return point ? [{ path: row.absPath, id: row.id, name, ...point }] : [];
  });
};

/**
 * The signals of each of `ids` (file node ids), read `SIGNAL_PAGE` at a time. Every id is in the
 * answer, with no persons when none are known.
 */
export const readSignals = async (vfs: NodeVFS, access: Access, ids: NodeId[]): Promise<Map<NodeId, FileSignals>> => {
  const signals = new Map<NodeId, FileSignals>(ids.map((id) => [id, { persons: [] }]));
  // The person a `people/` tag names, by the path it links to: read once per person, across pages.
  const personIdOf = new Map<string, NodeId | undefined>();
  const resolvePersons = async (paths: Iterable<string>): Promise<void> => {
    const missing = [...new Set(paths)].filter((path) => !personIdOf.has(path));
    const found = await Promise.all(missing.map((path) => vfs.get(access, path).then((node) => node.type === NODE_TYPE_PERSON ? node.id : undefined, () => undefined)));
    missing.forEach((path, index) => personIdOf.set(path, found[index]));
  };

  const unique = [...signals.keys()];
  for (let offset = 0; offset < unique.length; offset += SIGNAL_PAGE) {
    const page = unique.slice(offset, offset + SIGNAL_PAGE);
    const children = await vfs.getChildLinksByIds(access, page);
    const positions = childNamed(children, POSITION_CHILD);
    const regionDirs = childNamed(children, REGIONS_DIR);
    const peopleDirs = childNamed(children, PEOPLE_DIR);
    const locationLinks = childNamed(children, LOCATION_LINK_NAME);
    const sidecars = childNamed(children, SIDECAR_CHILD);

    const [points, held] = await Promise.all([
      vfs.getPoints(access, [...positions.values()]),
      regionDirs.size + peopleDirs.size > 0 ? vfs.getChildLinksByIds(access, [...regionDirs.values(), ...peopleDirs.values()]) : new Map<NodeId, NodeChild[]>(),
    ]);
    const heldBy = (dirs: Map<NodeId, NodeId>): Map<NodeId, NodeId[]> =>
      new Map([...dirs].map(([fileId, dirId]) => [fileId, (held.get(dirId) ?? []).map((child) => child.id)]));
    const regionsOf = heldBy(regionDirs);
    const tagsOf = heldBy(peopleDirs);

    for (const [fileId, positionId] of positions) {
      const entry = signals.get(fileId)!;
      entry.positionId = positionId;
      const point = points.get(positionId);
      if (point) entry.point = point;
    }

    // Regions carry the person; tag links and location links name theirs by path.
    const nodeIds = [...[...regionsOf.values()].flat(), ...[...tagsOf.values()].flat(), ...locationLinks.values(), ...sidecars.values()];
    if (nodeIds.length === 0) continue;
    const nodes = await vfs.getNodesByIds<{ personId?: string | null }>(access, nodeIds);
    // A shared sidecar is a softlink to the original's, read once by path.
    const sharedSidecars = new Map<string, Record<string, unknown> | undefined>();
    for (const sidecarId of sidecars.values()) {
      const target = nodes.get(sidecarId)?.props.softlink;
      if (target && !sharedSidecars.has(target)) {
        sharedSidecars.set(target, await vfs.get(access, target).then((node) => node.attrs as Record<string, unknown>, () => undefined));
      }
    }
    await resolvePersons([...tagsOf.values()].flat().flatMap((tagId) => nodes.get(tagId)?.props.softlink ?? []));
    for (const fileId of page) {
      const entry = signals.get(fileId)!;
      const persons = new Set<NodeId>();
      for (const regionId of regionsOf.get(fileId) ?? []) {
        const region = nodes.get(regionId);
        if (region?.type !== REGION_TYPE) continue;
        if (region.attrs.personId) persons.add(region.attrs.personId);
      }
      for (const tagId of tagsOf.get(fileId) ?? []) {
        const personId = personIdOf.get(nodes.get(tagId)?.props.softlink ?? '');
        if (personId) persons.add(personId);
      }
      entry.persons = [...persons];
      const location = nodes.get(locationLinks.get(fileId) ?? '')?.props.softlink;
      if (location) entry.location = location;
      const sidecarNode = nodes.get(sidecars.get(fileId) ?? '');
      const sidecarAttrs = sidecarNode?.props.softlink ? sharedSidecars.get(sidecarNode.props.softlink) : sidecarNode?.attrs as Record<string, unknown> | undefined;
      const sidecar = sidecarAttrs && sidecarOf(sidecarAttrs);
      if (sidecar?.kind === 'takeout' && sidecar.localFolder) entry.localFolder = sidecar.localFolder;
    }
  }
  return signals;
};
