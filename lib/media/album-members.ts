/**
 * Who is in an album: the one place media's album rules are applied, from the album's side
 * (`albumMembers`) or from its members' (`albumsHolding`).
 *
 * - An album's media are its children — or, for an album imported from the old system, the
 *   children of its lone `files/` directory, which holds everything while the album holds none.
 * - A softlink child is a member too: a file added to an album, and a staging suggestion's
 *   members, are links, not files. The link is
 *   kept as `memberPath`, since removing it (not the file) is what takes a photo out.
 * - The `coverPhoto` link is not a member, nor are the `previous` and `next` links to the albums
 *   beside it in a series.
 * - Only original media count: pictures, video and recordings, not renditions made from them.
 * - Similar photos taken in a row fold onto one, as the album's `mediaStacks` manifest says
 *   (`album-stack`). A group folds only while its front and at least one more member are still in
 *   the album and readable, so a stale manifest never hides a photo.
 */

import { basename, dirname, resolve } from '@std/path';
import { type Command, type ContainerListing, isOriginalMedia } from '@ein/client';
import { NODE_TYPE_ALBUM, NON_MEMBER_LINK_NAMES } from '@archive/media/types';
import { indexAlbumMediaStacks, MEDIA_STACKS_ATTR, parseAlbumMediaStacks } from '@archive/media/media-stacks';

type AlbumNode = Awaited<ReturnType<Command['sys']['vfs']['get']>>;

/** The lone media child of an imported album; descended into, never listed. */
const FILES_DIR_NAME = 'files';

/** Ceiling on how many entries one album contributes. */
const ALBUM_SCAN_LIMIT = 20000;

type AlbumMember = {
  /** The file. */
  path: string;
  /** The link inside the album, when the album links the file rather than holding it. */
  memberPath?: string;
  node: AlbumNode;
  /** The member this one folds onto in a stack, when it is not the one shown. */
  front?: string;
  /** On a stack's front: how many members the stack has. */
  stackCount?: number;
};

type AlbumMembers = {
  album: AlbumNode;
  /** Where the members live: the album, or its `files/` directory. */
  containerPath: string;
  /** Every member, in listing order; the caller orders them. */
  members: AlbumMember[];
  truncated: boolean;
};

/** The album's members, with stacks marked. Throws when `path` is not an album. */
export const albumMembers = async (cmd: Command, path: string): Promise<AlbumMembers> => {
  const vfs = cmd.sys.vfs;
  const album = await vfs.get(cmd.access, path);
  if (album.type !== NODE_TYPE_ALBUM) throw new Error(`${path}: not an album (is ${album.type})`);

  let containerPath = path;
  let entries = await vfs.children(cmd.access, path);
  const holdsMedia = entries.some((entry) => isOriginalMedia(entry.node) || (entry.node.props.softlink && !NON_MEMBER_LINK_NAMES.includes(entry.name)));
  if (!holdsMedia && entries.some((entry) => entry.name === FILES_DIR_NAME && entry.node.type === 'directory')) {
    containerPath = `${path}/${FILES_DIR_NAME}`;
    entries = await vfs.children(cmd.access, containerPath);
  }

  const truncated = entries.length > ALBUM_SCAN_LIMIT;
  const members: AlbumMember[] = [];
  const links: { target: string; memberPath: string }[] = [];
  for (const entry of entries.slice(0, ALBUM_SCAN_LIMIT)) {
    if (entry.node.props.softlink) {
      if (!NON_MEMBER_LINK_NAMES.includes(entry.name)) links.push({ target: resolve(containerPath, entry.node.props.softlink), memberPath: `${containerPath}/${entry.name}` });
      continue;
    }
    if (isOriginalMedia(entry.node)) members.push({ path: `${containerPath}/${entry.name}`, node: entry.node });
  }

  // In parallel: each is a path walk, and an auto album is all links.
  const resolved = await Promise.all(links.map(async (link) => {
    try {
      return { ...link, node: await vfs.get(cmd.access, link.target) };
    } catch {
      // A dangling or unreadable member is skipped, not an error.
      return undefined;
    }
  }));
  for (const link of resolved) {
    if (link && isOriginalMedia(link.node)) members.push({ path: link.target, memberPath: link.memberPath, node: link.node });
  }

  markStacks(album, members);
  return { album, containerPath, members, truncated };
};

/** Mark each member of a live stack with its front, and the front with the stack's size. */
const markStacks = (album: AlbumNode, members: AlbumMember[]): void => {
  const { frontByMemberId } = indexAlbumMediaStacks(parseAlbumMediaStacks(album.attrs[MEDIA_STACKS_ATTR]));
  if (frontByMemberId.size === 0) return;

  const byId = new Map(members.map((member) => [member.node.id, member]));
  const groups = new Map<string, AlbumMember[]>();
  for (const member of members) {
    const frontId = frontByMemberId.get(member.node.id);
    if (!frontId || !byId.has(frontId)) continue;
    groups.set(frontId, [...(groups.get(frontId) ?? []), member]);
  }
  for (const [frontId, group] of groups) {
    if (group.length < 2) continue;
    const front = byId.get(frontId)!;
    front.stackCount = group.length;
    for (const member of group) if (member !== front) member.front = front.path;
  }
};

/** How many link targets one backlink query asks about. */
const LINK_TARGET_CHUNK = 2000;

/** The album among `albums` whose members `dir` holds: the album itself, or its `files/` directory. */
const albumOfDir = (dir: string, albums: ReadonlySet<string>): string | undefined => {
  if (albums.has(dir)) return dir;
  const parent = dirname(dir);
  return basename(dir) === FILES_DIR_NAME && albums.has(parent) ? parent : undefined;
};

/**
 * Which of `albums` hold each of the files at `paths`, by the rules above read from the member's
 * side: the album or its `files/` directory holds the file, or a link to it that is a member.
 * One backlink query per `LINK_TARGET_CHUNK` files, and no read per file. A path in no album is
 * left out of the answer.
 */
export const albumsHolding = async (cmd: Command, paths: string[], albums: ReadonlySet<string>): Promise<Map<string, Set<string>>> => {
  const holding = new Map<string, Set<string>>();
  const hold = (path: string, album: string | undefined) => {
    if (!album) return;
    let held = holding.get(path);
    if (!held) holding.set(path, held = new Set());
    held.add(album);
  };

  const wanted = [...new Set(paths)];
  for (const path of wanted) hold(path, albumOfDir(dirname(path), albums));
  for (let offset = 0; offset < wanted.length; offset += LINK_TARGET_CHUNK) {
    for (const link of await cmd.sys.vfs.findLinks(cmd.access, wanted.slice(offset, offset + LINK_TARGET_CHUNK), Number.MAX_SAFE_INTEGER)) {
      if (!NON_MEMBER_LINK_NAMES.includes(basename(link.absPath))) hold(link.target, albumOfDir(dirname(link.absPath), albums));
    }
  }
  return holding;
};

/** The members the album shows: a stack's front, never the photos folded under it. */
export const visibleMembers = (members: AlbumMember[]): AlbumMember[] => members.filter((member) => !member.front);

/** The listing `search --under` reads (`@ein/client` `ContainerListing`). */
export const containerListing = ({ members, truncated }: AlbumMembers): ContainerListing => ({
  members: members.map((member) => ({
    path: member.path,
    id: member.node.id,
    ...(member.memberPath ? { memberPath: member.memberPath } : {}),
    ...(member.front ? { front: member.front } : {}),
    ...(member.stackCount ? { stackCount: member.stackCount } : {}),
  })),
  truncated,
});
