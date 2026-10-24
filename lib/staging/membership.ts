/**
 * Which suggested groups hold a category's staged files, and taking files out of them: what every
 * decision, move and edit that changes a group's members goes through. A group keeps its member
 * key right as members leave and join, so the organizer never takes such a change for a person's
 * hand edit.
 */
import type { GroupSnapshot } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { basename, dirname } from '@std/path';
import { AUTO_ORIGIN, type AutoAlbumMeta, COVER_LINK_NAME, deleteAutoAlbum, freeLinkName, isMemberKey, linkSpec, toggleMembers } from '@archive/staging/auto-album';
import { withCategoryLock } from '@archive/staging/lock';
import { idsAt } from '@archive/staging/nodes-at';
import { groupsDirOf } from '@archive/staging/paths';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Links one lookup of the files' suggestions returns at most. */
const LINK_LIMIT = 100_000;

/**
 * The directory of the suggested groups of the category `file` is staged in, or undefined for a
 * file that is not staged in a category.
 */
export const suggestionsOf = (file: string): string | undefined => groupsDirOf(file);

/** Whether `target` is one of `paths` or lies under one. */
const atOrUnder = (target: string, paths: ReadonlySet<string>): boolean => {
  for (let at = target; at !== '/' && at !== '.'; at = dirname(at)) if (paths.has(at)) return true;
  return false;
};

/** The suggested groups directly in `albumsPath` holding a member link at or under one of `paths`, with those links by name. */
const groupsLinking = async (vfs: Vfs, access: Access, paths: string[], albumsPath: string): Promise<Map<string, Map<string, string>>> => {
  const found = new Map<string, Map<string, string>>();
  for (const link of await vfs.findLinksUnder(access, paths, LINK_LIMIT)) {
    const album = dirname(link.absPath);
    if (dirname(album) !== albumsPath || basename(link.absPath) === COVER_LINK_NAME) continue;
    const links = found.get(album) ?? new Map<string, string>();
    links.set(basename(link.absPath), link.target);
    found.set(album, links);
  }
  return found;
};

/**
 * The suggested groups in `albumsPath` that `paths` (files, or folders of them) leave, as they are
 * now: each group's node, the member links that will leave it with their targets' ids, its cover
 * when it shows one of them, and whether nothing will be left in it. Reads only.
 */
export const snapshotGroups = async (vfs: Vfs, access: Access, paths: string[], albumsPath: string): Promise<GroupSnapshot[]> => {
  const found = await groupsLinking(vfs, access, paths, albumsPath);
  if (found.size === 0) return [];
  const ids = await idsAt(vfs, access, [...new Set([...found.values()].flatMap((links) => [...links.values()]))]);
  const leaving = new Set(paths);
  const snapshots: GroupSnapshot[] = [];
  for (const [path, links] of found) {
    const node = await vfs.get<{ origin?: string }>(access, path);
    if (node.type !== 'album' || node.attrs.origin !== AUTO_ORIGIN) continue;
    const children = await vfs.children(access, path);
    const cover = children.find((child) => child.name === COVER_LINK_NAME)?.node.props.softlink;
    const members = children.filter((child) => child.name !== COVER_LINK_NAME && child.node.props.softlink);
    snapshots.push({
      path,
      id: node.id,
      attrs: node.attrs,
      props: { uid: node.props.uid, gid: node.props.gid, mode: node.props.mode },
      links: [...links].flatMap(([name, target]) => ids.has(target) ? [{ name, target, id: ids.get(target)! }] : []),
      ...(cover !== undefined && atOrUnder(cover, leaving) ? { cover } : {}),
      emptied: members.every((child) => links.has(child.name)),
    });
  }
  return snapshots;
};

/** A member as a suggestion links it: the link's target and that node's id. */
type Member = { target: string; id: string };

/**
 * The member key of a suggestion once the nodes `leaving` (their ids) have left it and `joining`
 * have joined it. A key over ids has theirs XOR-ed out and in, which needs no member read. Any
 * other key is kept: it already disagrees with the members, and that disagreement says a person
 * edited the album.
 */
const keyAfterLeaving = (key: string | undefined, leaving: string[], joining: string[]): string | undefined =>
  isMemberKey(key) ? toggleMembers(key, [...leaving, ...joining]) : key;

/** The suggested groups a leaving changed: those deleted, left empty, and those that lost members. */
type Left = { removed: string[]; changed: string[] };

/**
 * Take `paths` (staged files, or folders of them) out of every suggested album under
 * `albumsPath`: one link lookup for all of them, one read of each album holding any and its
 * links, and one `unlinkMany` of every member link they leave. `replacements` names, for a path,
 * the file that takes its place: one whose suggestions are these (`suggestionsOf`) is linked into
 * each album the path leaves unless the album holds it already, the link owned as the album is. A
 * cover that showed one of `paths` shows its replacement instead, or without one the first member
 * left. One left empty is deleted. The others get the member key `keyAfterLeaving` gives: an album
 * still as the organizer made it keeps a key that matches, so losing a member that left staging,
 * or gaining the copy kept in its place, does not read as a person's edit and pin it, and one a
 * person edited keeps the difference that says so.
 * The caller holds `albumsPath`'s category lock (`leaveSuggestedAlbums` takes it).
 */
export const leaveGroups = async (
  vfs: Vfs,
  access: Access,
  paths: string[],
  albumsPath: string,
  replacements: ReadonlyMap<string, string | undefined> = new Map(),
): Promise<Left> => {
  const left: Left = { removed: [], changed: [] };
  const found = await groupsLinking(vfs, access, paths, albumsPath);
  if (found.size === 0) return left;

  type Holder = {
    path: string;
    /** The member links that leave, by name, and their targets. */
    links: Map<string, string>;
    meta?: AutoAlbumMeta;
    /** The targets of the member links that stay. */
    left: string[];
    /** The names a new link must not take. */
    names: Set<string>;
    owner: { uid: number; gid: number };
    cover?: string;
  };
  const albums: Holder[] = [];
  for (const [path, links] of found) {
    const node = await vfs.get<{ origin?: string; autoAlbum?: AutoAlbumMeta }>(access, path);
    if (node.type !== 'album' || node.attrs.origin !== AUTO_ORIGIN) continue;
    const children = await vfs.children(access, path);
    const staying = children.filter((child) => !links.has(child.name));
    albums.push({
      path,
      links,
      meta: node.attrs.autoAlbum,
      left: staying.filter((child) => child.name !== COVER_LINK_NAME && child.node.props.softlink).map((child) => child.node.props.softlink!),
      names: new Set([COVER_LINK_NAME, ...staying.map((child) => child.name)]),
      owner: { uid: node.props.uid, gid: node.props.gid },
      cover: children.find((child) => child.name === COVER_LINK_NAME)?.node.props.softlink,
    });
  }

  const leavingPaths = new Set(paths);
  /** The leaving path `target` is, or lies under. */
  const sourceOf = (target: string): string | undefined => {
    for (let at = target; at !== '/' && at !== '.'; at = dirname(at)) if (leavingPaths.has(at)) return at;
    return undefined;
  };
  const kept = new Map([...replacements].filter((entry): entry is [string, string] => {
    const [path, replacement] = entry;
    return leavingPaths.has(path) && replacement !== undefined && !atOrUnder(replacement, leavingPaths) && suggestionsOf(replacement) === albumsPath;
  }));
  const ids = await idsAt(vfs, access, [...new Set([...albums.flatMap(({ links }) => [...links.values()]), ...kept.values()])]);
  /** The member that takes the place of `target`, a leaving link's target, when there is one. */
  const replacing = (target: string): Member | undefined => {
    const source = sourceOf(target);
    const replacement = source === undefined ? undefined : kept.get(source);
    return replacement !== undefined && ids.has(replacement) ? { target: replacement, id: ids.get(replacement)! } : undefined;
  };

  const plans = albums.map((album) => {
    const leaving = new Set(album.links.values());
    const joins = new Map<string, Member>();
    for (const target of leaving) {
      const member = replacing(target);
      if (member && !album.left.includes(member.target)) joins.set(member.target, member);
    }
    const coverLeaves = album.cover !== undefined && atOrUnder(album.cover, leaving);
    return {
      album,
      leaving,
      joins: [...joins.values()],
      // A cover showing a file that leaves shows the one kept in its place, else the first member left, else one that joined.
      cover: coverLeaves ? replacing(album.cover!)?.target ?? album.left[0] ?? [...joins.keys()][0] : undefined,
    };
  });

  const unlinked = await vfs.unlinkMany(
    access,
    plans.flatMap(({ album, cover }) => [...album.links.keys(), ...(cover !== undefined ? [COVER_LINK_NAME] : [])].map((name) => `${album.path}/${name}`)),
  );
  const refused = unlinked.find((outcome) => outcome.status === 'rejected');
  if (refused) throw refused.reason;

  for (const { album, leaving, joins, cover } of plans) {
    const specs = [
      ...joins.map((member) => {
        const name = freeLinkName(basename(member.target), album.names);
        album.names.add(name);
        return linkSpec(name, member.target, album.owner);
      }),
      ...(cover !== undefined ? [linkSpec(COVER_LINK_NAME, cover, album.owner)] : []),
    ];
    if (specs.length > 0) await vfs.createTree(access, album.path, specs);

    const memberCount = album.left.length + joins.length;
    if (memberCount === 0) {
      await deleteAutoAlbum(vfs, access, album.path, albumsPath);
      left.removed.push(album.path);
      continue;
    }
    left.changed.push(album.path);
    if (album.meta) {
      const leavingIds = [...leaving].map((target) => {
        const id = ids.get(target);
        if (id === undefined) throw new Error(`not found: ${target}`);
        return id;
      });
      const memberKey = keyAfterLeaving(album.meta.memberKey, leavingIds, joins.map((member) => member.id));
      await vfs.update(access, album.path, { attrs: { autoAlbum: { ...album.meta, ...(memberKey !== undefined ? { memberKey } : {}), memberCount } } });
    }
  }
  return left;
};

/** `leaveGroups` holding `albumsPath`'s category lock. */
export const leaveSuggestedAlbums = (
  vfs: Vfs,
  access: Access,
  paths: string[],
  albumsPath: string,
  replacements: ReadonlyMap<string, string | undefined> = new Map(),
): Promise<Left> => withCategoryLock(albumsPath, () => leaveGroups(vfs, access, paths, albumsPath, replacements));
