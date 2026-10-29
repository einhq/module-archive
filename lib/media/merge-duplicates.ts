/**
 * Merging duplicates: one file is kept, the others are dropped, and what a person said about a
 * dropped copy is not lost with it. The kept file is filled in, never overwritten, from the drops:
 * its fields through the commands that own each, its paired sidecar from a drop's, and the people
 * in it, the comments on it and the albums it is in from the drops' regions, `people/` tags,
 * `comments/` and album links. Staged
 * drops then leave their suggested albums and their inbox's duplicate findings, and the drops go
 * to the trash as one batch, which `trash restore <batch>` brings back.
 */

import type { Command, NodeProps } from '@ein/client';
import { shq, verifyAccess } from '@ein/client';
import { COVER_LINK_NAME, isTrashPath } from '@ein/paths';
import type { StarEntry, TrashEntry, TrashPutResult } from '@ein/api';
import { encodeBase64 } from '@std/encoding/base64';
import { basename, dirname } from '@std/path';
import type { AlbumAddResult, MergeDuplicatesResult, MergeField } from '@archive/media/api';
import { POSITION_CHILD } from '@archive/location/location-link';
import { SIDECAR_CHILD } from '@archive/media/paired-sidecar';
import { applyFileTime } from '@archive/media/resolve-time';
import { leaveSuggestedAlbums, suggestionsOf } from '@archive/staging/membership';
import { inboxOf, markTrashed, refreshReferences } from '@archive/staging/duplicates';
import { AUTO_ORIGIN } from '@archive/staging/auto-album';
import { albumsHolding } from '@archive/media/album-members';
import { iou } from '@archive/media/face-match';
import { FACE_CROP_MIMETYPE, FACE_CROP_NAME } from '@archive/media/face-crop';
import { FACE_DETECTOR, LIGHTBOX_MANUAL_DETECTOR, nextManualName, REGION_TYPE, type RegionAttrs, REGIONS_DIR, regionsPathOf } from '@archive/media/regions';

/** Paths per `trash put`, so a command line stays short however many drops there are. */
const TRASH_CHUNK = 500;

/** Entries a trash batch holds at most; past it the drops go on into a new batch. */
const BATCH_LIMIT = 2_000;

/** Links one lookup of the drops' album links returns at most. */
const LINK_LIMIT = 100_000;

/** `<file>/people/<name>`: a softlink to a person in the picture, without a box. */
export const PEOPLE_DIR = 'people';

/** `<file>/comments/<slug>`: a comment on the file, its author the node's owner. */
export const COMMENTS_DIR = 'comments';

/** An imported album's lone child that holds its members. */
const FILES_DIR = 'files';

/** Where a region's person came from when a machine guessed it; recognition makes the guess again on the kept file. */
const MACHINE_SOURCES = new Set(['auto', 'cluster']);

/** How much a drop's box must overlap a box on the kept file to be the same face. */
const SAME_FACE_IOU = 0.5;

/** The attrs of a file the merge reads: the inputs a person sets by hand, the labels, and whether it is indexed. */
type MergeAttrs = {
  description?: string | null;
  whenManual?: string | null;
  takenAtNote?: string | null;
  positionManual?: { lat: number; lng: number } | null;
  labels?: string[];
  indexedAt?: string;
};

type Point = { lat: number; lng: number };

/** A box on a file, by its path. */
type Region = { path: string; attrs: RegionAttrs };

/** A `people/` tag on a file: where it points, and the person's id when the target resolves. */
type PeopleTag = { target: string; personId?: string };

/** A file in the merge, as read once before anything is written. */
type MergeFile = {
  path: string;
  id: string;
  props: NodeProps;
  attrs: MergeAttrs;
  point?: Point;
  regions: Region[];
  tags: PeopleTag[];
  /** The names under `comments/`, and that directory's props. */
  comments: { names: string[]; props?: NodeProps };
  /** It has a paired sidecar, `<file>/sidecar`. */
  hasSidecar: boolean;
};

/** One write and the field it fills in. */
type Step = { field: MergeField; apply: () => Promise<void> };

/** What the drops' library albums do: links that go, albums the kept file joins, covers that show it. */
type AlbumPlan = { unlink: string[]; join: string[]; cover: string[]; dirs: Set<string> };

type MergeOptions = { batch?: string; label?: string; dryRun?: boolean };

/** Run `command` in JSON mode; its stdout, or its stderr as the error. */
const run = async (cmd: Command, command: string): Promise<string> => {
  const result = await cmd.execute(`JSON_OUTPUT=1 ${command}`);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${command.split(' ')[0]} failed`);
  return result.stdout;
};

/** Run `command` in JSON mode and read its answer. */
const ask = async <T>(cmd: Command, command: string): Promise<T> => JSON.parse(await run(cmd, command)) as T;

/** A step that runs one writer command. */
const commandStep = (cmd: Command, field: MergeField, command: string): Step => ({ field, apply: async () => void await run(cmd, command) });

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** `name`, or `name (2)`, `name (3)`, … — the first not in `used`, which it joins. */
const takeName = (name: string, used: Set<string>): string => {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${name} (${n})`;
  used.add(candidate);
  return candidate;
};

/** A file as its caller has just read it, which the merge takes instead of reading it again. */
type ReadFile = { id: string; props: NodeProps; attrs: Record<string, unknown> };

/**
 * Each of `paths` as a file, refusing anything else, with its point (a `position` child's), its
 * regions, its `people/` tags and the names of its comments. A file in `known` is taken as read
 * there.
 */
const readFiles = async (cmd: Command, paths: string[], known: ReadonlyMap<string, ReadFile>): Promise<MergeFile[]> => {
  const vfs = cmd.sys.vfs;
  const files: MergeFile[] = [];
  for (const path of paths) {
    if (isTrashPath(path)) throw new Error(`${path} is in the trash`);
    const read = known.get(path);
    const node = read ? { ...read, type: 'file' } : await vfs.get<MergeAttrs>(cmd.access, path, { readlink: true }).catch(() => undefined);
    if (node?.type !== 'file') throw new Error(`not a file: ${path}`);
    files.push({ path, id: node.id, props: node.props, attrs: node.attrs as MergeAttrs, regions: [], tags: [], comments: { names: [] }, hasSidecar: false });
  }

  const children = await vfs.getChildLinksByIds(cmd.access, files.map((file) => file.id));
  const has = (file: MergeFile, name: string) => children.get(file.id)?.some((child) => child.name === name) ?? false;
  const positions = new Map<string, string>();
  for (const file of files) {
    const position = children.get(file.id)?.find((child) => child.name === POSITION_CHILD);
    if (position) positions.set(file.id, position.id);
  }
  const points = positions.size > 0 ? await vfs.getPoints(cmd.access, [...positions.values()]) : new Map();

  const personIds = new Map<string, string | undefined>();
  for (const file of files) {
    const point = points.get(positions.get(file.id) ?? '');
    if (point) file.point = { lat: point.lat, lng: point.lng };
    file.hasSidecar = has(file, SIDECAR_CHILD);

    if (has(file, REGIONS_DIR)) {
      const regions = await vfs.children<RegionAttrs>(cmd.access, regionsPathOf(file.path));
      file.regions = regions.filter((entry) => entry.node.type === REGION_TYPE).map((entry) => ({
        path: `${regionsPathOf(file.path)}/${entry.name}`,
        attrs: entry.node.attrs,
      }));
    }
    if (has(file, PEOPLE_DIR)) {
      for (const entry of await vfs.children(cmd.access, `${file.path}/${PEOPLE_DIR}`, { follow: false })) {
        const target = entry.node.props.softlink;
        if (!target) continue;
        if (!personIds.has(target)) personIds.set(target, await vfs.get(cmd.access, target).then((person) => person.id, () => undefined));
        file.tags.push({ target, personId: personIds.get(target) });
      }
    }
    if (has(file, COMMENTS_DIR)) {
      const dir = `${file.path}/${COMMENTS_DIR}`;
      const entries = await vfs.children(cmd.access, dir);
      file.comments = { names: entries.filter((entry) => entry.node.type === 'file').map((entry) => entry.name), props: (await vfs.get(cmd.access, dir)).props };
    }
  }
  return files;
};

/**
 * The writes that fill `keep`'s fields from `drops`, the first drop in order winning a field: a
 * description, a hand-typed time with its note, and a place where the kept file has none; the
 * labels it lacks; the caller's star when a drop has one and the kept file has not; and a drop's
 * paired sidecar where the kept file has none, moved under it (the links to it following) and its
 * time resolved again with it when it is indexed.
 */
const planFields = (cmd: Command, keep: MergeFile, drops: MergeFile[], starred: Set<string>): Step[] => {
  const steps: Step[] = [];

  const described = !keep.attrs.description ? drops.find((drop) => drop.attrs.description) : undefined;
  if (described) {
    const text = encodeBase64(new TextEncoder().encode(described.attrs.description!));
    steps.push(commandStep(cmd, 'description', `file-set-description ${shq(keep.path)} --text-base64 ${text}`));
  }

  const timed = !keep.attrs.whenManual ? drops.find((drop) => drop.attrs.whenManual) : undefined;
  if (timed) {
    const note = timed.attrs.takenAtNote ? ` --note ${shq(timed.attrs.takenAtNote)}` : '';
    steps.push(commandStep(cmd, 'time', `file-set-time ${shq(keep.path)} ${shq(timed.attrs.whenManual!)}${note}`));
  }

  if (!keep.attrs.positionManual && !keep.point) {
    const place = drops.map((drop) => drop.attrs.positionManual ?? drop.point).find((point) => point);
    if (place) steps.push(commandStep(cmd, 'place', `file-set-position ${shq(keep.path)} --lat=${place.lat} --lng=${place.lng}`));
  }

  const own = new Set(keep.attrs.labels ?? []);
  const labels = [...new Set(drops.flatMap((drop) => drop.attrs.labels ?? []))].filter((label) => !own.has(label));
  if (labels.length > 0) steps.push(commandStep(cmd, 'labels', `label add ${shq(keep.path)} ${labels.map(shq).join(' ')}`));

  if (!starred.has(keep.path) && drops.some((drop) => starred.has(drop.path))) steps.push(commandStep(cmd, 'star', `star ${shq(keep.path)}`));

  const paired = !keep.hasSidecar ? drops.find((drop) => drop.hasSidecar) : undefined;
  if (paired) {
    steps.push({
      field: 'sidecar',
      apply: async () => {
        const vfs = cmd.sys.vfs;
        const to = `${keep.path}/${SIDECAR_CHILD}`;
        const [moved] = await vfs.renameMany(cmd.access, [{ from: `${paired.path}/${SIDECAR_CHILD}`, to }], { failIfExists: true });
        if (moved.status === 'rejected') throw moved.reason;
        if (moved.value.node.type === 'file') await vfs.update(cmd.access, to, { attrs: { sourceId: keep.id } });
        if (keep.attrs.indexedAt !== undefined) await applyFileTime(cmd, keep.path);
      },
    });
  }

  return steps;
};

/**
 * The writes that give `keep` the people a person named on a drop, each person once: a drop's
 * region whose person a human gave or an import carried (not a machine's guess) names its person
 * on the kept file's box that overlaps it — one with nobody or a machine's guess, that was not
 * told it is not them — or, with none, on a new `manual-<n>` box like it, its crop copied or left
 * for `regenerate-face-crops`. A drop's `people/` tag joins the kept file's when no box or tag
 * there names that person yet.
 */
const planPeople = (cmd: Command, keep: MergeFile, drops: MergeFile[]): Step[] => {
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const named = new Set(keep.regions.map((region) => region.attrs.personId).filter((id): id is string => !!id));
  const open = keep.regions.filter((region) => !region.attrs.personId || MACHINE_SOURCES.has(region.attrs.personSource ?? ''));

  const assign: { region: Region; from: Region }[] = [];
  const add: Region[] = [];
  for (const from of drops.flatMap((drop) => drop.regions)) {
    const person = from.attrs.personId;
    const box = from.attrs.faceBox;
    if (!person || !box || MACHINE_SOURCES.has(from.attrs.personSource ?? '') || named.has(person)) continue;
    named.add(person);
    const region = open.find((each) => each.attrs.faceBox && iou(each.attrs.faceBox, box) >= SAME_FACE_IOU && !each.attrs.rejectedPersonIds?.includes(person));
    if (region) {
      open.splice(open.indexOf(region), 1);
      assign.push({ region, from });
    } else add.push(from);
  }

  const kept = new Set(keep.tags.map((tag) => tag.target));
  const tags: string[] = [];
  for (const tag of drops.flatMap((drop) => drop.tags)) {
    if (kept.has(tag.target) || (tag.personId && named.has(tag.personId))) continue;
    kept.add(tag.target);
    if (tag.personId) named.add(tag.personId);
    tags.push(tag.target);
  }

  const steps: Step[] = [];
  if (assign.length + add.length > 0) {
    steps.push({
      field: 'faces',
      apply: async () => {
        for (const { region, from } of assign) {
          await vfs.update(access, region.path, {
            follow: false,
            attrs: {
              personId: from.attrs.personId,
              personSource: from.attrs.personSource ?? 'transfer',
              personConfidence: null,
              personAssignedAt: nowIso(),
              doubt: null,
              ...(from.attrs.assignLocked ? { assignLocked: true } : {}),
            },
          });
        }
        if (add.length === 0) return;

        const dir = regionsPathOf(keep.path);
        await vfs.ensure(access, 'directory', keep.path, REGIONS_DIR);
        const names = (await vfs.children(access, dir, { follow: false })).map((entry) => entry.name);
        for (const from of add) {
          const name = nextManualName(names);
          names.push(name);
          // A detection becomes a box drawn by hand here; any other box keeps who drew it.
          const drawnBy = from.attrs.detectedBy && from.attrs.detectedBy !== FACE_DETECTOR ? from.attrs.detectedBy : LIGHTBOX_MANUAL_DETECTOR;
          await vfs.create(access, REGION_TYPE, dir, name, {
            attrs: {
              fileId: keep.id,
              faceBox: from.attrs.faceBox,
              landmarks: null,
              confidence: 1,
              detectedAt: nowIso(),
              detectedBy: drawnBy,
              personId: from.attrs.personId,
              ...(from.attrs.personSource ? { personSource: from.attrs.personSource } : {}),
              personAssignedAt: from.attrs.personAssignedAt ?? nowIso(),
              ...(from.attrs.assignLocked ? { assignLocked: true } : {}),
              ...(from.attrs.rejectedPersonIds?.length ? { rejectedPersonIds: from.attrs.rejectedPersonIds } : {}),
            },
          });
          const crop = `${from.path}/${FACE_CROP_NAME}`;
          if (await vfs.exists(access, crop)) {
            await vfs.copy(access, crop, `${dir}/${name}`);
            await vfs.update(access, `${dir}/${name}/${FACE_CROP_NAME}`, { attrs: { sourceId: keep.id } });
          } else {
            await vfs.create(access, 'file', `${dir}/${name}`, FACE_CROP_NAME, { attrs: { mimetype: FACE_CROP_MIMETYPE, sourceId: keep.id } });
          }
        }
      },
    });
  }
  if (tags.length > 0) {
    steps.push({
      field: 'people',
      apply: async () => {
        const dir = `${keep.path}/${PEOPLE_DIR}`;
        await vfs.ensure(access, 'directory', keep.path, PEOPLE_DIR, { props: { mode: 0o770 } });
        const used = new Set((await vfs.children(access, dir, { follow: false })).map((entry) => entry.name));
        await vfs.createTree(access, dir, tags.map((target) => ({ type: 'softlink', name: takeName(basename(target), used), props: { mode: 0o777, softlink: target } })));
      },
    });
  }
  return steps;
};

/** The drops' comments, moved onto `keep` so each keeps its author and time; a taken slug gets a suffix. */
const planComments = (cmd: Command, keep: MergeFile, drops: MergeFile[]): Step[] => {
  const moving = drops.flatMap((drop) => drop.comments.names.map((name) => ({ from: `${drop.path}/${COMMENTS_DIR}/${name}`, name })));
  if (moving.length === 0) return [];
  return [{
    field: 'comments',
    apply: async () => {
      const dir = `${keep.path}/${COMMENTS_DIR}`;
      await cmd.sys.vfs.ensure(cmd.access, 'directory', keep.path, COMMENTS_DIR);
      const used = new Set(keep.comments.names);
      const moves = moving.map(({ from, name }) => ({ from, to: `${dir}/${takeName(name, used)}` }));
      const refused = (await cmd.sys.vfs.renameMany(cmd.access, moves, { failIfExists: true })).find((outcome) => outcome.status === 'rejected');
      if (refused) throw refused.reason;
    },
  }];
};

/**
 * What the library albums holding a drop of each of `sets` do: the drop's member links there go,
 * its kept file joins each album that does not hold it yet, and a cover that showed a drop shows
 * it. An album holds a file in itself or its `files/` directory, or by a link; suggested albums
 * are staging's and left to `leaveSuggestedAlbums`. `dirs` are the directories these writes touch.
 * One lookup of every drop's links, each directory read once, and one of the kept files' albums.
 */
const planAlbums = async (cmd: Command, sets: { keep: MergeFile; drops: MergeFile[] }[]): Promise<AlbumPlan[]> => {
  const vfs = cmd.sys.vfs;
  const albums = new Map<string, string | undefined>();
  const albumOf = async (dir: string): Promise<string | undefined> => {
    if (albums.has(dir)) return albums.get(dir);
    const library = async (path: string) => {
      const node = await vfs.get<{ origin?: string }>(cmd.access, path).catch(() => undefined);
      return node?.type === 'album' && node.attrs.origin !== AUTO_ORIGIN;
    };
    const album = await library(dir) ? dir : basename(dir) === FILES_DIR && await library(dirname(dir)) ? dirname(dir) : undefined;
    albums.set(dir, album);
    return album;
  };

  const plans = sets.map((): AlbumPlan => ({ unlink: [], join: [], cover: [], dirs: new Set() }));
  const joining = sets.map(() => new Set<string>());
  const covers = sets.map(() => new Set<string>());
  const setOf = new Map<string, number>();
  for (const [i, set] of sets.entries()) {
    for (const drop of set.drops) {
      setOf.set(drop.path, i);
      const album = await albumOf(dirname(drop.path));
      if (album) joining[i].add(album);
    }
  }
  for (const link of await vfs.findLinks(cmd.access, [...setOf.keys()], LINK_LIMIT)) {
    const i = setOf.get(link.target);
    const album = i === undefined ? undefined : await albumOf(dirname(link.absPath));
    if (i === undefined || !album) continue;
    plans[i].dirs.add(dirname(link.absPath));
    if (basename(link.absPath) === COVER_LINK_NAME) covers[i].add(album);
    else {
      plans[i].unlink.push(link.absPath);
      joining[i].add(album);
    }
  }

  const changing = sets.flatMap((_, i) => joining[i].size + covers[i].size > 0 ? [i] : []);
  if (changing.length === 0) return plans;
  const holding = await albumsHolding(cmd, changing.map((i) => sets[i].keep.path), new Set(changing.flatMap((i) => [...joining[i]])));
  for (const i of changing) {
    const held = holding.get(sets[i].keep.path) ?? new Set();
    plans[i].join = [...joining[i]].filter((album) => !held.has(album));
    plans[i].cover = [...covers[i]];
    for (const album of [...plans[i].join, ...plans[i].cover]) plans[i].dirs.add(album);
  }
  return plans;
};

/** How many entries the caller's trash batch `batch` holds, or 0 when there is none. */
const heldIn = async (cmd: Command, batch: string): Promise<number> =>
  (await ask<TrashEntry[]>(cmd, 'trash list')).find((row) => row.id === batch && row.type === 'batch')?.count ?? 0;

/** One set to merge: the file kept and the files dropped into it, by absolute path. */
type MergeSet = { keep: string; drops: string[] };

/** A set as planned, read once before anything is written: its files, its writes and what they fill in. */
type PlannedSet = { keep: MergeFile; drops: MergeFile[]; steps: Step[]; albums: AlbumPlan; merged: MergeField[] };

/** Sets planned to be merged (`planMerge`), and which of their files the caller has starred. */
type MergePlan = { sets: PlannedSet[]; starred: Set<string> };

/** What merging one set did: where its kept file is now, and what it was filled in with. */
export type MergedSet = { keep: string; fields: MergeField[] };

/**
 * Plan merging `sets`, reading every file once and changing nothing: each kept file's fill-ins
 * from its drops, and the drops' library albums (`planAlbums`). A file in `known`, by path, is
 * taken as its caller has just read it. Refused, before anything is written, for a path that is
 * not a file or is in a trash, a kept file among its drops or a file in two sets, a kept file the
 * caller cannot write when there is something to fill in, a drop the caller could not move out of
 * its directory or whose comments it could not move, and an album it could not change.
 */
export const planMerge = async (cmd: Command, sets: MergeSet[], known: ReadonlyMap<string, ReadFile> = new Map()): Promise<MergePlan> => {
  const seen = new Set<string>();
  for (const set of sets) {
    const drops = [...new Set(set.drops)];
    if (drops.length === 0) throw new Error(`nothing to drop into ${set.keep}`);
    if (drops.includes(set.keep)) throw new Error(`${set.keep} is both kept and dropped`);
    for (const path of [set.keep, ...drops]) {
      if (seen.has(path)) throw new Error(`${path} is in two sets`);
      seen.add(path);
    }
  }
  const files = new Map((await readFiles(cmd, [...seen], known)).map((file) => [file.path, file]));
  const writable = (props: NodeProps) => verifyAccess(cmd.access, props, 'w') && verifyAccess(cmd.access, props, 'x');

  for (const dir of new Set(sets.flatMap((set) => set.drops.map((drop) => dirname(drop))))) {
    if (!writable((await cmd.sys.vfs.get(cmd.access, dir)).props)) throw new Error(`cannot move files out of ${dir}`);
  }
  const stars = await ask<StarEntry[]>(cmd, 'star list');
  const starred = new Set(stars.map((star) => star.target));

  const read = sets.map((set) => ({ keep: files.get(set.keep)!, drops: [...new Set(set.drops)].map((path) => files.get(path)!) }));
  const steps = read.map(({ keep, drops }) => {
    const locked = drops.find((drop) => drop.comments.props && !writable(drop.comments.props));
    if (locked) throw new Error(`cannot move the comments on ${locked.path}`);
    const steps = [...planFields(cmd, keep, drops, starred), ...planPeople(cmd, keep, drops), ...planComments(cmd, keep, drops)];
    if (steps.some((step) => step.field !== 'star') && !verifyAccess(cmd.access, keep.props, 'w')) {
      throw new Error(`cannot write ${keep.path}, which would take ${steps.map((step) => step.field).join(', ')} from its duplicates`);
    }
    return steps;
  });
  const albumPlans = await planAlbums(cmd, read);
  const albumDirs = new Set(albumPlans.flatMap((albums) => [...albums.dirs]));
  const planned: PlannedSet[] = read.map(({ keep, drops }, i) => {
    const albums = albumPlans[i];
    const merged = [...steps[i].map((step) => step.field), ...(albums.join.length + albums.cover.length > 0 ? ['albums' as const] : [])];
    return { keep, drops, steps: steps[i], albums, merged };
  });
  for (const dir of albumDirs) {
    if (!writable((await cmd.sys.vfs.get(cmd.access, dir)).props)) throw new Error(`cannot change the album ${dir}`);
  }
  return { sets: planned, starred };
};

/**
 * Carry out the fill-ins of `plan`, the drops staying where they are: each kept file is filled in
 * and the drops unstarred; the staged drops leave their suggested albums, a staged kept file
 * joining each in their place when it is staged beside them; and the drops leave their library
 * albums, the kept file joining each that does not hold it yet — filed there when it is staged, as
 * `album add` does — and showing as the cover where a drop did.
 */
export const fillKept = async (cmd: Command, plan: MergePlan): Promise<MergedSet[]> => {
  for (const set of plan.sets) for (const step of set.steps) await step.apply();
  const unstar = plan.sets.flatMap((set) => set.drops.filter((drop) => plan.starred.has(drop.path)).map((drop) => drop.path));
  if (unstar.length > 0) await run(cmd, `star -d ${unstar.map(shq).join(' ')}`);

  // The staged drops leave their suggested albums a category at a time, each with its kept file to
  // join in its place when that is staged beside it.
  const leaving = new Map<string, Map<string, string | undefined>>();
  for (const set of plan.sets) {
    for (const drop of set.drops) {
      const albums = suggestionsOf(drop.path);
      if (!albums) continue;
      const drops = leaving.get(albums) ?? new Map<string, string | undefined>();
      drops.set(drop.path, suggestionsOf(set.keep.path) === albums ? set.keep.path : undefined);
      leaving.set(albums, drops);
    }
  }
  for (const [albums, drops] of leaving) await leaveSuggestedAlbums(cmd.sys.vfs, cmd.access, [...drops.keys()], albums, drops);

  const merged: MergedSet[] = [];
  for (const set of plan.sets) {
    const unlinked = set.albums.unlink.length > 0 ? await cmd.sys.vfs.unlinkMany(cmd.access, set.albums.unlink) : [];
    const refused = unlinked.find((outcome) => outcome.status === 'rejected');
    if (refused) throw refused.reason;
    let kept = set.keep.path;
    for (const album of set.albums.join) {
      const added = await ask<AlbumAddResult>(cmd, `album add ${shq(album)} ${shq(kept)}`);
      kept = added.moved[0]?.to ?? kept;
    }
    for (const album of set.albums.cover) await run(cmd, `album set ${shq(album)} cover ${shq(kept)}`);
    merged.push({ keep: kept, fields: set.merged });
  }
  return merged;
};

/**
 * Merge `drops` into `keep` (absolute paths): plan (`planMerge`), fill the kept file in
 * (`fillKept`), and trash the drops `TRASH_CHUNK` at a time into one batch, `options.batch` when
 * given, going on into a new one past `BATCH_LIMIT` entries. Staged drops leave their inbox's
 * duplicate findings before they go. The answer names where the kept file is now. `trash restore`
 * brings the drops back, not their comments, which stay on the kept file, nor their place in the
 * albums the kept file took.
 */
export const mergeDuplicates = async (cmd: Command, keepPath: string, dropPaths: string[], options: MergeOptions = {}): Promise<MergeDuplicatesResult> => {
  const plan = await planMerge(cmd, [{ keep: keepPath, drops: dropPaths }]);
  const [{ keep, drops, merged }] = plan.sets;
  if (options.dryRun) return { ok: true, keep: keep.path, merged, trashed: drops.length, batch: null, batches: [], dryRun: true };
  const [{ keep: kept }] = await fillKept(cmd, plan);

  // Staged drops leave their inbox's duplicate findings before they go, and the twins and
  // look-alikes they leave behind there are decided again once they have gone.
  const inboxes = new Map<string, MergeFile[]>();
  for (const drop of drops) {
    const user = inboxOf(drop.path);
    if (user !== undefined) inboxes.set(user, [...inboxes.get(user) ?? [], drop]);
  }
  const marked = new Map<string, { originals: string[]; all: string[]; peers: string[]; ids: string[] }>();
  for (const [user, staged] of inboxes) {
    marked.set(user, await markTrashed(cmd, user, staged.map((drop) => ({ id: drop.id, path: drop.path, attrs: drop.attrs as Record<string, unknown> })), []));
  }

  const batches: string[] = [];
  let batch = options.batch;
  let held = batch ? await heldIn(cmd, batch) : 0;
  let trashed = 0;
  const label = options.label ? ` --label ${shq(options.label)}` : '';
  let gone = false;
  try {
    for (let start = 0; start < drops.length;) {
      if (held >= BATCH_LIMIT) {
        batch = undefined;
        held = 0;
      }
      const chunk = drops.slice(start, start + Math.min(TRASH_CHUNK, BATCH_LIMIT - held)).map((drop) => drop.path);
      const put = await ask<TrashPutResult>(cmd, `trash put --batch=${batch ?? ''}${label} ${chunk.map(shq).join(' ')}`);
      batch = put.batch!;
      if (!batches.includes(batch)) batches.push(batch);
      held += put.entries.length;
      trashed += put.entries.length;
      start += chunk.length;
    }
    gone = true;
  } finally {
    for (const [user, sums] of marked) await refreshReferences(cmd, user, gone ? sums.originals : sums.all, gone ? sums.peers : [...sums.peers, ...sums.ids]);
  }

  return { ok: true, keep: kept, merged, trashed, batch: batches[0] ?? null, batches, dryRun: false };
};
