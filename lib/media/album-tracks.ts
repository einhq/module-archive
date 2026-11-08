/**
 * An album's tracks: the ones its map draws.
 *
 * - The tracks of the cameras that took its media are on the list: the track a camera links to
 *   (its child softlink `track`), read from the members' `cameraPath` each time it is asked, so
 *   media from a new camera joining, a member linked to its camera later, or a camera given its
 *   track later is on it at once.
 * - A track added by hand is a softlink in the album's `tracks/` directory, named by the track's
 *   name: `<album>/tracks/<name>` → the track's path.
 * - A track of its media that was removed from the list is named in the album's `tracksRemoved`
 *   attr, so the removal holds when more of its media joins.
 *
 * A folder that is not an album has the tracks of its media and nothing else.
 */

import { basename, dirname, resolve } from '@std/path';
import type { Command, ContainerListing, NodeId } from '@ein/client';
import { shq } from '@ein/client';
import { TRACK_LINK, trackName } from '@archive/location/track';
import type { AlbumTrack, AlbumTrackList } from '@archive/media/api';
import { NODE_TYPE_ALBUM } from '@archive/media/types';
import { slugifyName } from '@archive/people/person';

/** The album's directory of the tracks added to it by hand. */
const ALBUM_TRACKS_DIR = 'tracks';

/** Album attr: the paths of the tracks of its media that were removed from its list. */
const TRACKS_REMOVED_ATTR = 'tracksRemoved';

/** Ids per batched lookup. */
const IDS_PER_CALL = 1000;

const NODE_TYPE_TRACK = 'track';

type Node = Awaited<ReturnType<Command['sys']['vfs']['get']>>;

const removedOf = (album: Node): string[] => {
  const value = album.attrs[TRACKS_REMOVED_ATTR];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** How many of the media `path` shows each camera took (`members`, a stack's front for the whole stack). */
const mediaCameras = async (cmd: Command, path: string): Promise<Map<string, number>> => {
  const listed = await cmd.execute(`JSON_OUTPUT=1 members ${shq(path)}`);
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || `${path}: cannot list its members`);
  const ids: NodeId[] = (JSON.parse(listed.stdout) as ContainerListing).members.filter((member) => !member.front).map((member) => member.id);
  const counts = new Map<string, number>();
  for (let offset = 0; offset < ids.length; offset += IDS_PER_CALL) {
    for (const node of (await cmd.sys.vfs.getNodesByIds(cmd.access, ids.slice(offset, offset + IDS_PER_CALL))).values()) {
      const camera = node.attrs.cameraPath;
      if (typeof camera === 'string') counts.set(camera, (counts.get(camera) ?? 0) + 1);
    }
  }
  return counts;
};

/** The track the camera at `camera` links to, or undefined when it links to none. */
const cameraTrack = async (cmd: Command, camera: string): Promise<string | undefined> => {
  const link = `${camera}/${TRACK_LINK}`;
  const node = await cmd.sys.vfs.get(cmd.access, link, { follow: false, readlink: true }).catch(() => undefined);
  return node?.props.softlink ? resolve(dirname(link), node.props.softlink) : undefined;
};

/** How many of the media `path` shows were taken by cameras that record into each track. */
const mediaTracks = async (cmd: Command, path: string): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  for (const [camera, media] of await mediaCameras(cmd, path)) {
    const track = await cameraTrack(cmd, camera);
    if (track) counts.set(track, (counts.get(track) ?? 0) + media);
  }
  return counts;
};

/** The tracks linked from the album's `tracks/`, by the link's name. None when it has no such directory. */
const addedTracks = async (cmd: Command, albumPath: string): Promise<Map<string, string>> => {
  const dir = `${albumPath}/${ALBUM_TRACKS_DIR}`;
  const added = new Map<string, string>();
  if (!(await cmd.sys.vfs.exists(cmd.access, dir, { follow: false }))) return added;
  for (const entry of await cmd.sys.vfs.children(cmd.access, dir, { follow: false })) {
    if (entry.node.props.softlink) added.set(resolve(dir, entry.node.props.softlink), entry.name);
  }
  return added;
};

/** The track at `path` as a row, or undefined when it is gone, unreadable or not a track. */
const trackRow = async (cmd: Command, path: string, source: AlbumTrack['source'], media: number): Promise<AlbumTrack | undefined> => {
  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);
    if (node.type !== NODE_TYPE_TRACK) return undefined;
    return { path, name: await trackName(cmd, path, node), source, media };
  } catch {
    return undefined;
  }
};

const byMedia = (a: AlbumTrack, b: AlbumTrack): number => b.media - a.media || a.name.localeCompare(b.name);

/** The tracks of the album or folder at `path` (see the file comment). */
export const albumTracks = async (cmd: Command, path: string): Promise<AlbumTrackList> => {
  const container = await cmd.sys.vfs.get(cmd.access, path);
  const album = container.type === NODE_TYPE_ALBUM;
  const counts = await mediaTracks(cmd, path);
  const removedPaths = new Set(album ? removedOf(container) : []);
  const added = album ? await addedTracks(cmd, path) : new Map<string, string>();

  const rows = await Promise.all([
    ...[...counts].map(([track, media]) => trackRow(cmd, track, 'media', media)),
    ...[...added.keys()].filter((track) => !counts.has(track)).map((track) => trackRow(cmd, track, 'added', 0)),
  ]);
  const tracks: AlbumTrack[] = [];
  const removed: AlbumTrack[] = [];
  for (const row of rows) {
    if (!row) continue;
    // A link lists its track even when that track is also named as removed.
    if (removedPaths.has(row.path) && !added.has(row.path)) removed.push(row);
    else tracks.push(row);
  }
  tracks.sort((a, b) => (a.source === b.source ? byMedia(a, b) : a.source === 'media' ? -1 : 1));
  removed.sort(byMedia);
  return { album: path, tracks, removed };
};

/** The album at `path`, or an error saying it is not one. */
const albumNode = async (cmd: Command, path: string): Promise<Node> => {
  const node = await cmd.sys.vfs.get(cmd.access, path);
  if (node.type !== NODE_TYPE_ALBUM) throw new Error(`${path}: not an album (is ${node.type})`);
  return node;
};

const setRemoved = async (cmd: Command, albumPath: string, removed: string[]): Promise<void> => {
  await cmd.sys.vfs.update(cmd.access, albumPath, { attrs: { [TRACKS_REMOVED_ATTR]: removed.length > 0 ? removed : null } });
};

/**
 * Put the track at `track` on the album's list: no longer removed, and linked from `tracks/` unless
 * a camera of the album's media records into it, which lists it already. True when the list changed.
 */
export const addAlbumTrack = async (cmd: Command, albumPath: string, track: string): Promise<boolean> => {
  const album = await albumNode(cmd, albumPath);
  const node = await cmd.sys.vfs.get(cmd.access, track);
  if (node.type !== NODE_TYPE_TRACK) throw new Error(`${track}: not a track (is ${node.type})`);
  const removed = removedOf(album);
  const wasRemoved = removed.includes(track);
  if (wasRemoved) await setRemoved(cmd, albumPath, removed.filter((entry) => entry !== track));

  if ((await mediaTracks(cmd, albumPath)).has(track)) return wasRemoved;
  if ((await addedTracks(cmd, albumPath)).has(track)) return wasRemoved;

  // The directory is shared as the album is, so whoever reads the album reads its list.
  const dir = `${albumPath}/${ALBUM_TRACKS_DIR}`;
  const { mode, gid, acl } = album.props;
  await cmd.sys.vfs.ensure(cmd.access, 'directory', albumPath, ALBUM_TRACKS_DIR, { props: { mode, gid, ...(acl?.length ? { acl } : {}) } });
  const taken = new Set((await cmd.sys.vfs.children(cmd.access, dir, { follow: false })).map((entry) => entry.name));
  const stem = slugifyName(await trackName(cmd, track, node)) || basename(track);
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
  await cmd.sys.vfs.create(cmd.access, 'softlink', dir, name, {
    props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o777, softlink: track },
  });
  return true;
};

/**
 * Take the track at `track` off the album's list: its link in `tracks/` goes (and `tracks/` with the
 * last one), and when a camera of the album's media records into it it is named as removed, which
 * keeps it off as more of its media joins. True when the list changed.
 */
export const removeAlbumTrack = async (cmd: Command, albumPath: string, track: string): Promise<boolean> => {
  const album = await albumNode(cmd, albumPath);
  const link = (await addedTracks(cmd, albumPath)).get(track);
  if (link) {
    const dir = `${albumPath}/${ALBUM_TRACKS_DIR}`;
    await cmd.sys.vfs.unlink(cmd.access, `${dir}/${link}`, dir, { readlink: true });
    // The last track added by hand takes its directory with it.
    if ((await cmd.sys.vfs.childCount(cmd.access, dir, { all: true })) === 0) await cmd.sys.vfs.unlink(cmd.access, dir, albumPath);
  }

  const removed = removedOf(album);
  if (removed.includes(track) || !(await mediaTracks(cmd, albumPath)).has(track)) return link !== undefined;
  await setRemoved(cmd, albumPath, [...removed, track]);
  return true;
};
