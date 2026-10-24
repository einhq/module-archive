/**
 * Suggested groups (auto albums): what the organizer makes of a category's staged media, one
 * `album` node per group, distinguished from hand-curated albums by `attrs.origin`.
 *
 * Layout of a group `/home/<user>/staging/albums/<category>/<slug>`, owned by the inbox owner (the
 * home's uid and gid), mode 0700:
 *   attrs.origin    = 'auto'
 *   attrs.name      = display name
 *   attrs.autoAlbum = `AutoAlbumMeta`
 *   children        = softlink members (name = basename of the media path), 0777 and
 *                     the owner's, plus a `coverPhoto` softlink (not a member)
 *
 * Exported as `@archive/staging/auto-album`. No core imports: concrete VFS/Access types are
 * derived from the Command surface.
 */
import type { AlbumScores } from '@archive/media/api';
import type { GroupKind, SignificanceReason } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { COVER_LINK_NAME } from '@ein/paths';

export { COVER_LINK_NAME };

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

const NODE_TYPE_ALBUM = 'album';
const NODE_TYPE_SOFTLINK = 'softlink';

/** A suggested album is its owner's alone. */
const GROUP_MODE = 0o700;
/** A link's own mode means nothing; what it points at is guarded by that node. */
const LINK_MODE = 0o777;

/** Marks an album node as machine-generated (vs a curated album). */
export const AUTO_ORIGIN = 'auto';

/** Who a suggested album, its member links and its cover belong to: the inbox owner. */
type GroupOwner = { uid: number; gid: number };

/**
 * One level-1 part of a rolled-up album — a morning, an evening — kept so the
 * grouping can be explained and drawn, not as anything the VFS knows about.
 */
type AutoAlbumPart = {
  timeStart: string;
  timeEnd: string;
  memberCount: number;
  centroid?: { lat: number; lng: number };
};

/** What the organizer records on a group (`attrs.autoAlbum`). */
export type AutoAlbumMeta = {
  /** What kind of grouping it is; none is an event. */
  kind?: GroupKind;
  /** A lane's or a seed's key (`loose:2014`, `undated:<folder id>`), by which the organizer finds it again. */
  key?: string;
  /** ISO capture time of the earliest and latest member; absent for a group of undated media. */
  timeStart?: string;
  timeEnd?: string;
  /** A lane of media dated only to a year or a month. */
  precision?: 'year' | 'month';
  /** The folder a seed, a scan run or a folder's lane is of, by node id. */
  folderId?: string;
  /** /locations/<id> when the cluster has a dominant location, else absent. */
  locationPath?: string;
  /**
   * `memberKeyOf` the member node ids: lets a rerun detect no-change, and an edit
   * by hand. Node ids, so a member moved by `mv` keeps it exact.
   */
  memberKey: string;
  memberCount: number;
  /** Distinct shots among the members. */
  shots?: number;
  scores?: AlbumScores;
  /** The name the organizer last gave it. A name that differs from it is a person's, and stays. */
  generatedName?: string;
  /** A person named it (`staging rename`): the organizer keeps the name, but may still change its members. */
  nameLocked?: boolean;
  /** ISO timestamp of the last (re)generation. */
  generatedAt: string;
  /** Command that produced this album (e.g. 'staging organize'). */
  generatedBy: string;
  /** More than a tenth of its images have not been through face detection yet. */
  provisional?: boolean;
  /** A person keeps it as it is (`staging pin`, a merge they made, a hand edit): the organizer leaves it and its members alone. */
  pinned?: boolean;
  /** Distinct local days the members fall on. */
  days?: number;
  /** Far from the usual location; absent when that could not be told. */
  away?: boolean;
  /** The parts this album was rolled up from, when it was. */
  parts?: AutoAlbumPart[];
  /** A lane's members per local day. */
  dayCounts?: [string, number][];
  /** Why an event or trip is a group of its own, and the year's usual day it was weighed against. */
  significance?: { reason: SignificanceReason; baseline: number };
  /** A seed's folder: an imported album's title, or the folder's name. */
  seed?: { source: 'takeout-album' | 'folder'; label: string };
  /** How its cover was picked: the first picture with a face, or the earliest. */
  cover?: 'face' | 'earliest';
};

const MASK_64 = (1n << 64n) - 1n;
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
/** A member key is 64 bits, written as this many hex digits. */
const MEMBER_KEY_DIGITS = 16;

/** FNV-1a, 64 bits, over a node id's characters (ids are ASCII). */
export const fnv1a64 = (text: string): bigint => {
  let h = FNV_OFFSET_64;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i) & 0xff);
    h = (h * FNV_PRIME_64) & MASK_64;
  }
  return h;
};

const keyOf = (value: bigint): string => value.toString(16).padStart(MEMBER_KEY_DIGITS, '0');

/**
 * `key` with each distinct id of `ids` XOR-ed in: a member joining or leaving changes the key by
 * its own hash alone, so neither needs the rest of the members read. An id XOR-ed twice is gone
 * again.
 */
export const toggleMembers = (key: string, ids: Iterable<string>): string => {
  let value = BigInt(`0x${key}`);
  for (const id of new Set(ids)) value ^= fnv1a64(id);
  return keyOf(value);
};

/**
 * The member key of a set of member node ids: the XOR of each distinct id's FNV-1a-64, as 16 hex
 * digits. Independent of order and of duplicates.
 */
export const memberKeyOf = (ids: Iterable<string>): string => toggleMembers(keyOf(0n), ids);

/** Whether `key` is a member key (`memberKeyOf`). */
export const isMemberKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{16}$/.test(key);

/** basename of a VFS path (last non-empty segment). */
const baseName = (path: string): string => {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
};

/**
 * Whether a person holds this group as it is: it is pinned, or its members no longer key to the
 * `memberKey` the organizer stored, which only a link added or removed by hand does — every verb
 * that changes a group's members keeps its key. Such a group the organizer leaves alone.
 *
 * `memberIds` holds one entry per member link: the node id it points at, or
 * `undefined` for a link whose target is gone (a deleted file). Such a link has
 * no id to key, so the album is then judged by its link count instead: as the
 * organizer leaves an album, it has `memberCount` member links, dangling or not,
 * and a link added or removed by hand changes that.
 */
export const isUserEdited = (
  attrs: { name?: string; autoAlbum?: AutoAlbumMeta },
  memberIds: (string | undefined)[],
): boolean => {
  const meta = attrs.autoAlbum;
  if (!meta) return false;
  if (meta.pinned) return true;
  if (memberIds.some((id) => id === undefined)) return memberIds.length !== meta.memberCount;
  return memberKeyOf(memberIds as string[]) !== meta.memberKey;
};

/** Whether a group's name is a person's: they renamed it, or it no longer is the one the organizer gave it. */
export const isNameLocked = (attrs: { name?: string; autoAlbum?: Pick<AutoAlbumMeta, 'nameLocked' | 'generatedName'> }): boolean => {
  const meta = attrs.autoAlbum;
  if (!meta) return false;
  if (meta.nameLocked) return true;
  return meta.generatedName !== undefined && attrs.name !== undefined && attrs.name !== meta.generatedName;
};

/**
 * Delete an auto album, link by link.
 *
 * Deliberately not a recursive unlink: every child here is a softlink, and the
 * VFS's own recursion resolves a child path *through* the link, so it would
 * unlink the media the album points at rather than the pointer — deleting the
 * photos. Each child is dropped with `readlink` first, which operates on the
 * link itself, and only then is the emptied album detached from its parent.
 */
export const deleteAutoAlbum = async (vfs: Vfs, access: Access, albumPath: string, parentPath: string): Promise<void> => {
  for (const child of await vfs.children(access, albumPath)) {
    await vfs.unlink(access, `${albumPath}/${child.name}`, albumPath, { readlink: true });
  }
  await vfs.unlink(access, albumPath, parentPath, { follow: false });
};

/** A member link (or the cover link) of a suggested album, owned as the album is: a link's own mode means nothing. */
export const linkSpec = (name: string, target: string, owner: GroupOwner) => ({
  type: NODE_TYPE_SOFTLINK,
  name,
  props: { uid: owner.uid, gid: owner.gid, mode: LINK_MODE, softlink: target },
});

/** `name`, or `name-2`, `name-3`, … — the first not in `used`, as member links are named. */
export const freeLinkName = (name: string, used: ReadonlySet<string>): string => {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${name}-${n}`;
  return candidate;
};

/**
 * Member links for `targets`, each named by its target's basename, `-2`, `-3`… on a clash with
 * `used` (which the names join), owned as the group is.
 */
export const memberLinkSpecs = (targets: Iterable<string>, used: Set<string>, owner: GroupOwner) => {
  const specs = [];
  for (const target of targets) {
    const name = freeLinkName(baseName(target), used);
    used.add(name);
    specs.push(linkSpec(name, target, owner));
  }
  return specs;
};

/**
 * A whole suggested group as one tree to create: the album node named `slug`, owned by `owner` and
 * private, with `attrs` (`origin` set to auto), a link to each of `members` and, given one, its
 * cover.
 */
export const groupSpec = (slug: string, attrs: Record<string, unknown>, members: string[], owner: GroupOwner, cover?: string) => ({
  type: NODE_TYPE_ALBUM,
  name: slug,
  props: { uid: owner.uid, gid: owner.gid, mode: GROUP_MODE },
  attrs: { ...attrs, origin: AUTO_ORIGIN },
  children: [
    ...memberLinkSpecs(members, new Set([COVER_LINK_NAME]), owner),
    ...(cover !== undefined ? [linkSpec(COVER_LINK_NAME, cover, owner)] : []),
  ],
});
