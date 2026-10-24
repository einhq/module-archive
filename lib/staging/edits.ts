/**
 * The grouping verbs: a person's edits of a category's suggested groups, which last.
 *
 * Each verb holds the category's lock, makes its journal entry first — with the groups it will
 * change as they are, so `staging undo` gives them back — then changes the groups at once, keeping
 * every member key right, and answers `StagingEditResult`. The entry also keeps the edit as a
 * constraint (`StagingEdit`) that the organizer applies on every run until the entry is undone:
 *
 * | verb                    | now                                           | from then on                                                    |
 * | ----------------------- | --------------------------------------------- | --------------------------------------------------------------- |
 * | `split <g> --at <f>`    | `f` and the members after it make a new group | a cut before `f` (a seed: both pieces pinned)                    |
 * | `regroup <g> <f>…`      | the files move into `g`                       | they go with `g`'s members                                      |
 * | `regroup --new <f>…`    | the files make a new group                    | a run bounded both sides, when nothing else lies between; else pinned |
 * | `merge <keep> <other>…` | the others' members move into `keep`          | no cut inside them, when nothing else lies between; else pinned |
 * | `delete <g>`            | its members go to their lanes                 | no group of mostly them is one                                  |
 * | `rename <g> <name>`     | its name, locked                              | —                                                               |
 * | `pin <g> [--off]`       | it is pinned, or not                          | —                                                               |
 *
 * Lanes (Everyday, clutter, undated) are not split, merged or deleted: a picture leaves a lane by
 * `regroup`. A group named with its member key (`--expect`) is edited only while its key is still
 * that one; one the organizer changed since is answered in `changed`.
 */
import type { GroupSnapshot, StagingEdit, StagingEditResult } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { basename, dirname } from '@std/path';
import { AUTO_ORIGIN, type AutoAlbumMeta, COVER_LINK_NAME, groupSpec, memberKeyOf, memberLinkSpecs, toggleMembers } from '@archive/staging/auto-album';
import { type CategoryEntry, readCategories } from '@archive/staging/category';
import { compareItems } from '@archive/staging/cluster';
import { createJournalEntry, finishJournalEntry, liveEdits } from '@archive/staging/journal';
import { withCategoryLock } from '@archive/staging/lock';
import { leaveGroups, snapshotGroups } from '@archive/staging/membership';
import { formatDates } from '@archive/staging/naming';
import { idsAt } from '@archive/staging/nodes-at';
import { fileIntoLanes, type FileRow } from '@archive/staging/organizer';
import { categoryAlbumsPath, isStagingGroup, parseStagedPath, stagedPlace, stagingRoots } from '@archive/staging/paths';
import { naturalCompare } from '@archive/staging/strategy';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The kinds that are lanes, which are not split, merged or deleted. */
const LANES = new Set(['loose', 'clutter', 'undated']);

/** Files one `regroup` moves at most. */
export const REGROUP_MAX = 2_000;

/** A suggested group as an edit reads it: its node, and its member links with their targets' ids. */
type Group = {
  path: string;
  slug: string;
  id: string;
  attrs: Record<string, unknown> & { name?: string; autoAlbum?: AutoAlbumMeta };
  props: { uid: number; gid: number; mode: number };
  meta: AutoAlbumMeta;
  name: string;
  links: { name: string; target: string; id: string }[];
  cover?: string;
};

/** Whose category an edit is in. */
type Place = { user: string; category: CategoryEntry; albumsPath: string; owner: { uid: number; gid: number } };

/** A staged medium as an edit orders it. */
type Member = { id: string; path: string; attrs: { takenAt?: string; takenAtUtc?: string } };

const isLane = (meta: AutoAlbumMeta): boolean => meta.kind !== undefined && LANES.has(meta.kind);

/** The place of the suggested group `path` or the staged file `path`: its user, category and directory of groups. */
const placeOf = async (cmd: Command, path: string): Promise<Place> => {
  const parsed = parseStagedPath(path);
  const at = isStagingGroup(path) ? parsed : undefined;
  const place = at?.category ? { user: at.user, category: at.category } : stagedPlace(path);
  if (!place) throw new Error(`not a suggested group or a staged file: ${path}`);
  const category = (await readCategories(cmd.sys.vfs, cmd.access, place.user)).find((entry) => entry.name === place.category);
  if (!category) throw new Error(`no category ${place.category}`);
  const home = await cmd.sys.vfs.get(cmd.access, stagingRoots(place.user).homePath);
  return { user: place.user, category, albumsPath: categoryAlbumsPath(place.user, place.category), owner: { uid: home.props.uid, gid: home.props.gid } };
};

/** Read the suggested group at `path` of `place`, and its members' ids. */
const readGroup = async (vfs: Vfs, access: Access, path: string, place: Place): Promise<Group> => {
  if (!isStagingGroup(path) || dirname(path) !== place.albumsPath) throw new Error(`not a suggested group of ${place.category.name}: ${path}`);
  const node = await vfs.get<Group['attrs'] & { origin?: string }>(access, path, { follow: false });
  if (node.type !== 'album' || node.attrs.origin !== AUTO_ORIGIN || !node.attrs.autoAlbum) throw new Error(`not a suggested group: ${path}`);
  const children = await vfs.children(access, path);
  const links = children.filter((child) => child.name !== COVER_LINK_NAME && typeof child.node.props.softlink === 'string')
    .map((child) => ({ name: child.name, target: child.node.props.softlink! }));
  const ids = await idsAt(vfs, access, links.map((link) => link.target));
  return {
    path,
    slug: basename(path),
    id: node.id,
    attrs: node.attrs,
    props: { uid: node.props.uid, gid: node.props.gid, mode: node.props.mode },
    meta: node.attrs.autoAlbum,
    name: typeof node.attrs.name === 'string' && node.attrs.name ? node.attrs.name : basename(path),
    links: links.flatMap((link) => ids.has(link.target) ? [{ ...link, id: ids.get(link.target)! }] : []),
    cover: children.find((child) => child.name === COVER_LINK_NAME)?.node.props.softlink,
  };
};

/** A group as it is, for undo: with every member link, or (for a change of name or pin) with none. */
const snapshotOf = (group: Group, links = true): GroupSnapshot => ({
  path: group.path,
  id: group.id,
  attrs: group.attrs,
  props: group.props,
  links: links ? group.links : [],
  ...(links && group.cover !== undefined ? { cover: group.cover } : {}),
  emptied: false,
});

/** The members `ids` with their capture times, in time order (by name for those with none, after them). */
const readOrdered = async (vfs: Vfs, access: Access, members: { id: string; target: string }[]): Promise<Member[]> => {
  const nodes = await vfs.getNodesByIds<Member['attrs']>(access, members.map((member) => member.id));
  const read = members.map((member) => ({ id: member.id, path: member.target, attrs: nodes.get(member.id)?.attrs ?? {} }));
  const timeOf = (member: Member) => Date.parse(member.attrs.takenAtUtc ?? '');
  return read.sort((a, b) => {
    const [ta, tb] = [timeOf(a), timeOf(b)];
    if (Number.isFinite(ta) && Number.isFinite(tb)) return compareItems({ path: a.path, id: a.id, timeMs: ta }, { path: b.path, id: b.id, timeMs: tb });
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
    return naturalCompare(basename(a.path), basename(b.path));
  });
};

/** Whether a member is dated to the day or finer, as the timeline wants it. */
const onTimeline = (member: Member): boolean => !!member.attrs.takenAtUtc && /^\d{4}-\d{2}-\d{2}/.test(member.attrs.takenAt ?? member.attrs.takenAtUtc);

/** The first of `base`, `base-2`, `base-3`… with no node in `albumsPath`. */
const freeSlug = async (vfs: Vfs, access: Access, albumsPath: string, base: string): Promise<string> => {
  for (let n = 1;; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await vfs.exists(access, `${albumsPath}/${slug}`, { follow: false }))) return slug;
  }
};

/** The meta of a group an edit makes of `members` (in order). */
const newMeta = (kind: AutoAlbumMeta['kind'], members: Member[], name: string, by: string, extra: Partial<AutoAlbumMeta> = {}): AutoAlbumMeta => {
  const dated = members.filter((member) => member.attrs.takenAtUtc);
  return {
    kind,
    ...(dated.length > 0 ? { timeStart: dated[0].attrs.takenAtUtc, timeEnd: dated[dated.length - 1].attrs.takenAtUtc } : {}),
    memberKey: memberKeyOf(members.map((member) => member.id)),
    memberCount: members.length,
    generatedName: name,
    generatedAt: new Date().toISOString(),
    generatedBy: by,
    ...extra,
  };
};

/** The name an edit gives a group of `members` unless a person named it. */
const datesName = (members: Member[], fallback: string): string => formatDates(members.flatMap((member) => member.attrs.takenAt ?? [])) ?? fallback;

/** Refuse a group whose member key is not the one expected: the answer names it, and nothing is written. */
const refused = (changed: string[]): StagingEditResult => ({ ok: true, journal: null, groupsCreated: [], groupsChanged: [], groupsRemoved: [], changed });

const expectOne = (expect: string[] | undefined, count: number): void => {
  if (expect && expect.length > 0 && expect.length !== count) throw new Error(`--expect takes one member key per group: ${count} groups, ${expect.length} keys`);
};

/**
 * Make the journal entry, run `change`, and finish the entry however it ends: the edit's whole
 * answer, made under the category's lock.
 */
const journaled = async (
  cmd: Command,
  place: Place,
  summary: string,
  files: number,
  groups: GroupSnapshot[],
  edit: StagingEdit | undefined,
  change: () => Promise<Omit<StagingEditResult, 'ok' | 'journal' | 'changed'>>,
): Promise<StagingEditResult> => {
  const { vfs } = cmd.sys;
  const entry = await createJournalEntry(vfs, cmd.access, place.user, { category: place.category.name, action: 'edit', files, summary }, {
    kind: 'groups',
    albums: place.albumsPath,
    groups,
  }, { edit });
  let state: 'done' | 'partial' = 'partial';
  try {
    const result = await change();
    state = 'done';
    return { ok: true, journal: entry.id, changed: [], ...result };
  } finally {
    await finishJournalEntry(vfs, cmd.access, entry, { state });
  }
};

/** Add the members `adding` (link targets and their ids) to `group`, its key and count kept right. */
const addMembers = async (vfs: Vfs, access: Access, group: Group, adding: { target: string; id: string }[], owner: Place['owner'], attrs: Record<string, unknown> = {}) => {
  const names = new Set([COVER_LINK_NAME, ...group.links.map((link) => link.name)]);
  const fresh = adding.filter((member) => !group.links.some((link) => link.target === member.target));
  if (fresh.length > 0) await vfs.createTree(access, group.path, memberLinkSpecs(fresh.map((member) => member.target), names, owner));
  const node = await vfs.get<{ autoAlbum?: AutoAlbumMeta }>(access, group.path, { follow: false });
  const meta = node.attrs.autoAlbum ?? group.meta;
  await vfs.update(access, group.path, {
    attrs: {
      ...attrs,
      autoAlbum: {
        ...meta,
        memberKey: toggleMembers(meta.memberKey, fresh.map((member) => member.id)),
        memberCount: meta.memberCount + fresh.length,
        ...(attrs.autoAlbum as object | undefined ?? {}),
      },
    },
  });
};

/**
 * `staging split <group> --at <file>`: `file` and the members after it, in time order (a scan run:
 * in file-name order), become a new group, named `name` or by their dates. The organizer keeps the
 * cut from then on, and both pieces count as a person's; a seed splits into two pinned groups.
 */
export const splitGroup = async (cmd: Command, path: string, at: string, options: { name?: string; expect?: string[] } = {}): Promise<StagingEditResult> => {
  const place = await placeOf(cmd, path);
  const { vfs } = cmd.sys;
  expectOne(options.expect, 1);
  return await withCategoryLock(place.albumsPath, async () => {
    const group = await readGroup(vfs, cmd.access, path, place);
    if (options.expect?.length && group.meta.memberKey !== options.expect[0]) return refused([path]);
    if (isLane(group.meta)) throw new Error('a lane is not split; move pictures out of it with staging regroup');
    const ordered = group.meta.kind === 'folder'
      ? (await readOrdered(vfs, cmd.access, group.links.map((link) => ({ id: link.id, target: link.target })))).sort((a, b) =>
        naturalCompare(basename(a.path), basename(b.path))
      )
      : await readOrdered(vfs, cmd.access, group.links.map((link) => ({ id: link.id, target: link.target })));
    const index = ordered.findIndex((member) => member.path === at);
    if (index < 0) throw new Error(`not a member of ${path}: ${at}`);
    if (index === 0) throw new Error('split needs a member after the first: the group would be left empty');
    const piece = ordered.slice(index);
    const seed = group.meta.kind === 'seed';
    const edit: StagingEdit | undefined = seed ? undefined : { category: place.category.name, op: 'cut', after: ordered[index - 1].id };
    const name = options.name?.trim() || datesName(piece, `${group.name} (2)`);
    return await journaled(cmd, place, `Split “${group.name}”`, piece.length, [snapshotOf(group)], edit, async () => {
      await leaveGroups(vfs, cmd.access, piece.map((member) => member.path), place.albumsPath);
      const slug = await freeSlug(vfs, cmd.access, place.albumsPath, onTimeline(piece[0]) ? piece[0].attrs.takenAt!.slice(0, 10) : `${group.slug}-part`);
      const meta = newMeta(group.meta.kind ?? 'event', piece, name, 'staging split', {
        significance: { reason: 'edited', baseline: 1 },
        ...(options.name?.trim() ? { nameLocked: true } : {}),
        ...(seed ? { pinned: true, ...(group.meta.seed ? { seed: group.meta.seed } : {}) } : {}),
        ...(group.meta.folderId ? { folderId: group.meta.folderId } : {}),
      });
      await vfs.createTree(cmd.access, place.albumsPath, [groupSpec(slug, { name, autoAlbum: meta }, piece.map((member) => member.path), place.owner, piece[0].path)]);
      if (seed) {
        const node = await vfs.get<{ autoAlbum: AutoAlbumMeta }>(cmd.access, path, { follow: false });
        await vfs.update(cmd.access, path, { attrs: { autoAlbum: { ...node.attrs.autoAlbum, pinned: true } } });
      }
      return { groupsCreated: [`${place.albumsPath}/${slug}`], groupsChanged: [path], groupsRemoved: [] };
    });
  });
};

/** The staged media `paths`, all of `place`'s category, with their ids and times, in time order. */
const readFiles = async (cmd: Command, paths: string[], place: Place): Promise<Member[]> => {
  if (paths.length === 0) throw new Error('name at least one staged file');
  if (paths.length > REGROUP_MAX) throw new Error(`regroup takes at most ${REGROUP_MAX} files`);
  for (const path of paths) {
    const at = stagedPlace(path);
    if (at?.user !== place.user || at.category !== place.category.name) throw new Error(`not staged in ${place.user}'s ${place.category.name}: ${path}`);
  }
  const ids = await idsAt(cmd.sys.vfs, cmd.access, paths);
  const missing = paths.find((path) => !ids.has(path));
  if (missing) throw new Error(`not found: ${missing}`);
  return await readOrdered(cmd.sys.vfs, cmd.access, [...new Set(paths)].map((path) => ({ id: ids.get(path)!, target: path })));
};

/**
 * Whether the staged media of `place` dated from `first` to `last` (in time order) are only
 * `members`: no other indexed medium lies between them. Reads the range a page at a time, and
 * stops at the first other one.
 */
const onlyThese = async (cmd: Command, place: Place, members: Member[]): Promise<boolean> => {
  const [first, last] = [members[0], members[members.length - 1]];
  const inside = new Set(members.map((member) => member.id));
  const key = (member: Member) => ({ path: member.path, id: member.id, timeMs: Date.parse(member.attrs.takenAtUtc!) });
  let after: { value: string | null; id: string } | undefined;
  while (true) {
    const rows = await cmd.sys.vfs.query(cmd.access, {
      within: place.category.path,
      types: ['file'],
      where: [
        { ref: 'takenAtUtc', op: 'gte', value: first.attrs.takenAtUtc! },
        { ref: 'takenAtUtc', op: 'lte', value: last.attrs.takenAtUtc! },
        { ref: 'sourceId', op: 'missing' },
        { ref: 'indexedAt', op: 'exists' },
      ],
      orderBy: { ref: 'takenAtUtc', dir: 'asc' },
      ...(after ? { after } : {}),
      limit: 500,
    });
    for (const row of rows) {
      if (inside.has(row.id) || !/^(image|video|audio)\//.test(String(row.node.attrs.mimetype ?? ''))) continue;
      const here = { path: row.absPath, id: row.id, timeMs: Date.parse(String(row.node.attrs.takenAtUtc)) };
      if (compareItems(here, key(first)) < 0 || compareItems(here, key(last)) > 0) continue;
      return false;
    }
    if (rows.length < 500) return true;
    after = { value: rows[rows.length - 1].sortValue, id: rows[rows.length - 1].id };
  }
};

/**
 * `staging regroup <group> <file>…`: the files leave the groups that hold them for `group`, and
 * stay with its members from then on. A group they leave empty is deleted.
 */
export const regroupInto = async (cmd: Command, path: string, files: string[], options: { expect?: string[] } = {}): Promise<StagingEditResult> => {
  const place = await placeOf(cmd, path);
  const { vfs } = cmd.sys;
  expectOne(options.expect, 1);
  return await withCategoryLock(place.albumsPath, async () => {
    const group = await readGroup(vfs, cmd.access, path, place);
    if (options.expect?.length && group.meta.memberKey !== options.expect[0]) return refused([path]);
    const members = await readFiles(cmd, files, place);
    const moving = new Set(members.map((member) => member.id));
    const anchor = group.links.find((link) => !moving.has(link.id));
    if (!anchor) throw new Error(`${path} has no member of its own for the files to go with`);
    const holders = await snapshotGroups(vfs, cmd.access, members.map((member) => member.path), place.albumsPath);
    const edit: StagingEdit = { category: place.category.name, op: 'assign', items: members.map((member) => member.id), with: anchor.id };
    return await journaled(cmd, place, `${members.length} moved into “${group.name}”`, members.length, holders.filter((holder) => holder.path !== path), edit, async () => {
      const left = await leaveGroups(vfs, cmd.access, members.map((member) => member.path), place.albumsPath);
      await addMembers(vfs, cmd.access, await readGroup(vfs, cmd.access, path, place), members.map((member) => ({ target: member.path, id: member.id })), place.owner);
      return { groupsCreated: [], groupsChanged: [...new Set([path, ...left.changed.filter((each) => each !== path)])], groupsRemoved: left.removed };
    });
  });
};

/**
 * `staging regroup --new <file>…`: the files leave their groups and make a new one, named `name`
 * or by their dates. When they are a run of the timeline — every indexed medium dated between the
 * first and the last is one of them — the organizer keeps them one group, bounded both sides;
 * otherwise the new group is pinned.
 */
export const regroupNew = async (cmd: Command, files: string[], options: { name?: string } = {}): Promise<StagingEditResult> => {
  if (files.length === 0) throw new Error('name at least one staged file');
  const place = await placeOf(cmd, files[0]);
  const { vfs } = cmd.sys;
  return await withCategoryLock(place.albumsPath, async () => {
    const members = await readFiles(cmd, files, place);
    const run = members.every(onTimeline) && await onlyThese(cmd, place, members);
    const holders = await snapshotGroups(vfs, cmd.access, members.map((member) => member.path), place.albumsPath);
    const edit: StagingEdit | undefined = run
      ? { category: place.category.name, op: 'join', first: members[0].id, last: members[members.length - 1].id, bounded: true }
      : undefined;
    const name = options.name?.trim() || datesName(members, 'New group');
    return await journaled(cmd, place, `New group “${name}”`, members.length, holders, edit, async () => {
      const left = await leaveGroups(vfs, cmd.access, members.map((member) => member.path), place.albumsPath);
      const slug = await freeSlug(vfs, cmd.access, place.albumsPath, onTimeline(members[0]) ? members[0].attrs.takenAt!.slice(0, 10) : 'group');
      const meta = newMeta('event', members, name, 'staging regroup', {
        significance: { reason: 'edited', baseline: 1 },
        ...(options.name?.trim() ? { nameLocked: true } : {}),
        ...(run ? {} : { pinned: true }),
      });
      await vfs.createTree(cmd.access, place.albumsPath, [groupSpec(slug, { name, autoAlbum: meta }, members.map((member) => member.path), place.owner, members[0].path)]);
      return { groupsCreated: [`${place.albumsPath}/${slug}`], groupsChanged: left.changed, groupsRemoved: left.removed };
    });
  });
};

/**
 * `staging merge <keep> <other>…`: the others' members move into `keep`, and the others go. When
 * the groups are side by side in time — no other indexed medium is dated between their first and
 * last — the organizer keeps them one from then on; otherwise `keep` is pinned, so a join never
 * pulls in what lies between.
 */
export const mergeGroups = async (cmd: Command, keep: string, others: string[], options: { name?: string; expect?: string[] } = {}): Promise<StagingEditResult> => {
  const all = [keep, ...others];
  if (others.length === 0) throw new Error('merge needs the group to keep and at least one other');
  if (new Set(all).size !== all.length) throw new Error('a group is named twice');
  expectOne(options.expect, all.length);
  const place = await placeOf(cmd, keep);
  const { vfs } = cmd.sys;
  return await withCategoryLock(place.albumsPath, async () => {
    const groups = [];
    const changed: string[] = [];
    for (const [i, path] of all.entries()) {
      const group = await readGroup(vfs, cmd.access, path, place);
      if (isLane(group.meta)) throw new Error(`a lane is not merged: ${path}`);
      if (options.expect?.length && group.meta.memberKey !== options.expect[i]) changed.push(path);
      groups.push(group);
    }
    if (changed.length > 0) return refused(changed);
    const [kept, ...gone] = groups;
    const members = await readOrdered(vfs, cmd.access, groups.flatMap((group) => group.links.map((link) => ({ id: link.id, target: link.target }))));
    const adjacent = members.length > 0 && members.every(onTimeline) && await onlyThese(cmd, place, members);
    const edit: StagingEdit | undefined = adjacent ? { category: place.category.name, op: 'join', first: members[0].id, last: members[members.length - 1].id } : undefined;
    const name = options.name?.trim();
    return await journaled(
      cmd,
      place,
      `Merged ${gone.length + 1} groups into “${name ?? kept.name}”`,
      members.length,
      groups.map((group) => snapshotOf(group)),
      edit,
      async () => {
        const moving = gone.flatMap((group) => group.links.map((link) => ({ target: link.target, id: link.id })));
        const left = await leaveGroups(vfs, cmd.access, moving.map((member) => member.target), place.albumsPath);
        const dated = members.filter((member) => member.attrs.takenAtUtc);
        await addMembers(vfs, cmd.access, await readGroup(vfs, cmd.access, keep, place), moving, place.owner, {
          ...(name ? { name } : {}),
          autoAlbum: {
            ...(dated.length > 0 ? { timeStart: dated[0].attrs.takenAtUtc, timeEnd: dated[dated.length - 1].attrs.takenAtUtc } : {}),
            ...(name ? { nameLocked: true } : {}),
            ...(adjacent ? {} : { pinned: true }),
            significance: { reason: 'edited', baseline: 1 },
          },
        });
        return { groupsCreated: [], groupsChanged: [keep], groupsRemoved: left.removed.filter((path) => path !== keep) };
      },
    );
  });
};

/**
 * `staging delete <group>` ("not a group"): its members go to their lanes now, and from then on no
 * group of mostly them is one. Not for lanes, nor in a category grouped by folder, where there is
 * no lane to go to.
 */
export const deleteGroup = async (cmd: Command, path: string, options: { expect?: string[] } = {}): Promise<StagingEditResult> => {
  const place = await placeOf(cmd, path);
  const { vfs } = cmd.sys;
  expectOne(options.expect, 1);
  if (place.category.settings.group.strategy === 'folders') throw new Error('a category grouped by folder has no lanes: split or merge its runs instead');
  return await withCategoryLock(place.albumsPath, async () => {
    const group = await readGroup(vfs, cmd.access, path, place);
    if (options.expect?.length && group.meta.memberKey !== options.expect[0]) return refused([path]);
    if (isLane(group.meta)) throw new Error('a lane is not deleted: it is where pictures without a group are');
    const edit: StagingEdit = { category: place.category.name, op: 'dismiss', members: group.links.map((link) => link.id) };
    return await journaled(cmd, place, `“${group.name}” is not a group`, group.links.length, [snapshotOf(group)], edit, async () => {
      const left = await leaveGroups(vfs, cmd.access, group.links.map((link) => link.target), place.albumsPath);
      const nodes = await vfs.getNodesByIds(cmd.access, group.links.map((link) => link.id));
      const rows: FileRow[] = group.links.flatMap((link) => {
        const node = nodes.get(link.id);
        return node ? [{ id: link.id, path: link.target, attrs: node.attrs as FileRow['attrs'] }] : [];
      });
      const edits = [...await liveEdits(vfs, cmd.access, place.user, place.category.name), edit];
      const lanes = await fileIntoLanes(cmd, place.user, place.category, place.owner, rows, edits);
      return { groupsCreated: lanes.created, groupsChanged: lanes.changed, groupsRemoved: left.removed };
    });
  });
};

/** `staging rename <group> <name>`: its name, which the organizer keeps from then on; its members stay its to change. */
export const renameGroup = async (cmd: Command, path: string, name: string): Promise<StagingEditResult> => {
  const title = name.trim();
  if (!title) throw new Error('staging rename needs the new name');
  const place = await placeOf(cmd, path);
  const { vfs } = cmd.sys;
  return await withCategoryLock(place.albumsPath, async () => {
    const group = await readGroup(vfs, cmd.access, path, place);
    return await journaled(cmd, place, `“${group.name}” renamed “${title}”`, 0, [snapshotOf(group, false)], undefined, async () => {
      await vfs.update(cmd.access, path, { attrs: { name: title, autoAlbum: { ...group.meta, nameLocked: true } } });
      return { groupsCreated: [], groupsChanged: [path], groupsRemoved: [] };
    });
  });
};

/** `staging pin <group> [--off]`: the organizer leaves it and its members as they are, or manages it again. */
export const pinGroup = async (cmd: Command, path: string, off: boolean): Promise<StagingEditResult> => {
  const place = await placeOf(cmd, path);
  const { vfs } = cmd.sys;
  return await withCategoryLock(place.albumsPath, async () => {
    const group = await readGroup(vfs, cmd.access, path, place);
    return await journaled(cmd, place, `“${group.name}” ${off ? 'unpinned' : 'pinned'}`, 0, [snapshotOf(group, false)], undefined, async () => {
      // Unpinned, the group is the organizer's again: keyed to what it holds now, so the members a
      // person gave it while pinned do not read as an edit that pins it once more.
      const rekey = off ? { memberKey: memberKeyOf(group.links.map((link) => link.id)), memberCount: group.links.length } : {};
      await vfs.update(cmd.access, path, { attrs: { autoAlbum: { ...group.meta, ...rekey, pinned: !off } } });
      return { groupsCreated: [], groupsChanged: [path], groupsRemoved: [] };
    });
  });
};
