/**
 * Categories: the directories under a staging area's `files/`, each with its settings in
 * `attrs.stagingCategory` (`StagingCategorySettings`) and its groups in `albums/<name>/`.
 */
import type { GroupStrategy, SignificancePreset, StagingCategoryKind, StagingCategorySettings, StagingLane, StagingSidecars, StagingTimeRules } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { filenameDate } from '@archive/media/filename-date';
import {
  CATEGORY_SLUG,
  categoryAlbumsPath,
  categoryPath,
  DEFAULT_CATEGORY,
  ORGANIZER_CHECKPOINT,
  ORGANIZER_REQUEST,
  parseStagedPath,
  stagedPlace,
  STAGING_MODE,
  stagingRoots,
} from '@archive/staging/paths';
import { resolve } from '@std/path';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The attr on a category's directory that holds its settings. */
export const CATEGORY_ATTR = 'stagingCategory';

/** Time rules: nothing but the files' own clocks. */
const CLOCKS: StagingTimeRules = { digitized: false, filenameDates: false };
/** Time rules: a date a file's name spells counts when nothing better is known. */
const NAMES: StagingTimeRules = { digitized: false, filenameDates: true };
/** Time rules of digitized copies: no clock recorded while digitizing counts. */
const DIGITIZED: StagingTimeRules = { digitized: true, filenameDates: false };

/**
 * The settings each kind starts from; `generic`'s label is the directory's name. Scans are grouped
 * by folder, never by when they were scanned, and no clock of the scanner dates them; messaging and
 * screenshots fall into monthly lanes. Phones, messengers, screenshot tools and the uploaders whose
 * files land in the inbox write dates into names; a camera's or a Takeout's names are not dates. A
 * Takeout and a box of scans arrive by the thousand, so their work runs in the bulk lane. Sidecars
 * are paired wherever an export or an editor may have written them, not where a messenger's or a
 * screenshot tool's files land.
 */
const PRESETS: Record<StagingCategoryKind, { label: string; strategy: GroupStrategy; time: StagingTimeRules; lane: StagingLane; sidecars: StagingSidecars }> = {
  inbox: { label: 'Inbox', strategy: 'events', time: NAMES, lane: 'normal', sidecars: 'pair' },
  'google-photos': { label: 'Google Photos', strategy: 'events', time: CLOCKS, lane: 'bulk', sidecars: 'pair' },
  scans: { label: 'Scans', strategy: 'folders', time: DIGITIZED, lane: 'bulk', sidecars: 'pair' },
  phone: { label: 'Phone', strategy: 'events', time: NAMES, lane: 'normal', sidecars: 'pair' },
  camera: { label: 'Camera', strategy: 'events', time: CLOCKS, lane: 'normal', sidecars: 'pair' },
  messaging: { label: 'Messaging', strategy: 'none', time: NAMES, lane: 'normal', sidecars: 'ignore' },
  screenshots: { label: 'Screenshots', strategy: 'none', time: NAMES, lane: 'normal', sidecars: 'ignore' },
  generic: { label: '', strategy: 'events', time: CLOCKS, lane: 'normal', sidecars: 'pair' },
};

export const CATEGORY_KINDS = Object.keys(PRESETS) as StagingCategoryKind[];
export const GROUP_STRATEGIES: GroupStrategy[] = ['events', 'folders', 'none'];
export const SIGNIFICANCE_PRESETS: SignificancePreset[] = ['fewer', 'normal', 'more'];
export const STAGING_LANES: StagingLane[] = ['normal', 'bulk'];
export const STAGING_SIDECARS: StagingSidecars[] = ['pair', 'ignore'];

const isCategoryKind = (value: unknown): value is StagingCategoryKind => typeof value === 'string' && value in PRESETS;
const isStrategy = (value: unknown): value is GroupStrategy => (GROUP_STRATEGIES as unknown[]).includes(value);
const isSignificance = (value: unknown): value is SignificancePreset => (SIGNIFICANCE_PRESETS as unknown[]).includes(value);
const isLane = (value: unknown): value is StagingLane => (STAGING_LANES as unknown[]).includes(value);
const isSidecars = (value: unknown): value is StagingSidecars => (STAGING_SIDECARS as unknown[]).includes(value);

/** The settings a new category of `kind` named `name` has; every kind's significance is `normal`. */
export const presetSettings = (kind: StagingCategoryKind, name: string): StagingCategorySettings => ({
  kind,
  label: PRESETS[kind].label || name,
  group: { strategy: PRESETS[kind].strategy, significance: 'normal' },
  time: { ...PRESETS[kind].time },
  lane: PRESETS[kind].lane,
  sidecars: PRESETS[kind].sidecars,
});

/**
 * A category's settings from its attr, whatever is stored there: an unknown kind is `generic`, and
 * every field that is missing or not of its type is the kind's preset's.
 */
export const parseCategorySettings = (raw: unknown, name: string): StagingCategorySettings => {
  const stored = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const kind = isCategoryKind(stored.kind) ? stored.kind : 'generic';
  const settings = presetSettings(kind, name);
  if (typeof stored.label === 'string' && stored.label.trim() !== '') settings.label = stored.label;
  if (typeof stored.destinationId === 'string' && stored.destinationId !== '') settings.destinationId = stored.destinationId;
  const group = stored.group !== null && typeof stored.group === 'object' ? stored.group as Record<string, unknown> : {};
  if (isStrategy(group.strategy)) settings.group.strategy = group.strategy;
  if (isSignificance(group.significance)) settings.group.significance = group.significance;
  const time = stored.time !== null && typeof stored.time === 'object' ? stored.time as Record<string, unknown> : {};
  if (typeof time.digitized === 'boolean') settings.time.digitized = time.digitized;
  if (typeof time.filenameDates === 'boolean') settings.time.filenameDates = time.filenameDates;
  if (isLane(stored.lane)) settings.lane = stored.lane;
  if (isSidecars(stored.sidecars)) settings.sidecars = stored.sidecars;
  return settings;
};

/**
 * A staged file's time-trust attrs: `digitized: true` on a digitized copy, and `whenName`, the date
 * its name spells where names are dates. Null takes an attr off, as `vfs.update` reads it. They
 * stay on the file when it leaves staging, so it is dated by the same clocks in the library.
 */
type TimeStamps = { digitized: true | null; whenName: string | null };

/** The time-trust attrs a category's `rules` give a file named `name`. */
export const timeStamps = (rules: StagingTimeRules, name: string): TimeStamps => ({
  digitized: rules.digitized ? true : null,
  whenName: rules.filenameDates ? filenameDate(name) ?? null : null,
});

/** Whether a file's attrs already carry `stamps`. */
export const stampsHold = (attrs: Record<string, unknown>, stamps: TimeStamps): boolean =>
  (attrs.digitized === true) === (stamps.digitized === true) && (typeof attrs.whenName === 'string' ? attrs.whenName : null) === stamps.whenName;

/** Whether two categories date their files by the same clocks. */
export const sameTimeRules = (a: StagingTimeRules, b: StagingTimeRules): boolean => a.digitized === b.digitized && a.filenameDates === b.filenameDates;

/**
 * The time rules of the category the staged entry at `path` lies in, read from its directory, or
 * undefined for a path in no category or a category that cannot be read.
 */
export const categoryTimeRules = async (vfs: Vfs, access: Access, path: string): Promise<StagingTimeRules | undefined> => {
  const place = stagedPlace(path);
  if (!place) return undefined;
  const node = await vfs.get(access, categoryPath(place.user, place.category), { follow: false }).catch(() => undefined);
  return node?.type === 'directory' ? parseCategorySettings((node.attrs as Record<string, unknown>)[CATEGORY_ATTR], place.category).time : undefined;
};

/** One directory under `files/`: its name, node, and settings (parsed whether it carries the attr or not). */
export type CategoryEntry = { name: string; id: string; path: string; attrs: Record<string, unknown>; settings: StagingCategorySettings };

/** Directories read from `files/` per page. */
const PAGE = 1000;

/** Every directory under `user`'s `files/`, in name order; none when there is no `files/`. */
export const readCategories = async (vfs: Vfs, access: Access, user: string): Promise<CategoryEntry[]> => {
  const { filesPath } = stagingRoots(user);
  if (!(await vfs.exists(access, filesPath))) return [];
  const categories: CategoryEntry[] = [];
  let after: string | undefined;
  while (true) {
    const page = await vfs.children(access, filesPath, { types: ['directory'], page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
    for (const entry of page) {
      const attrs = entry.node.attrs as Record<string, unknown>;
      categories.push({ name: entry.name, id: entry.node.id, path: `${filesPath}/${entry.name}`, attrs, settings: parseCategorySettings(attrs[CATEGORY_ATTR], entry.name) });
    }
    if (page.length < PAGE) return categories;
    after = page[page.length - 1].name;
  }
};

/** What `staging category` is asked to change; nothing asked is a read. */
type CategoryEdit = {
  create?: boolean;
  remove?: boolean;
  kind?: string;
  label?: string;
  /** A library album, or a directory of them, by path. */
  destination?: string;
  noDestination?: boolean;
  strategy?: string;
  significance?: string;
  /** `on` or `off`. */
  digitized?: string;
  /** `on` or `off`. */
  filenameDates?: string;
  /** `normal` or `bulk`. */
  lane?: string;
  /** `pair` or `ignore`. */
  sidecars?: string;
};

/** What `editCategory` did, and the category as it now is (null once removed). */
type CategoryEdited = { created: boolean; removed: boolean; changed: (keyof StagingCategorySettings)[]; entry: CategoryEntry | null };

const SETTING_FIELDS: (keyof StagingCategorySettings)[] = ['kind', 'label', 'destinationId', 'group', 'time', 'lane', 'sidecars'];

/** A switch flag's value: `on` or `off`, undefined when not given. */
const onOff = (flag: string, value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value !== 'on' && value !== 'off') throw new Error(`--${flag} is on or off`);
  return value === 'on';
};

/** Whether two settings' values are the same: the group settings by their fields. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Create, change or remove `user`'s category `name`, or read it when `edit` asks nothing.
 *
 * `--create` makes its directory under `files/` and its directory of groups, private to the home's
 * owner, with the settings of `kind` (default `generic`) and `label`. A `kind` resets the other
 * settings to that kind's preset, but for what the same call sets and the destination. `strategy`
 * and `significance` set how its files are grouped, which the organizer's next run follows;
 * `digitized` and `filenameDates` (`on` or `off`) which clocks date its files, which the caller
 * then applies to the files there (`changed` names `time`); `lane` (`normal` or `bulk`) which lane
 * the work announced on its files from then on runs in; `sidecars` (`pair` or `ignore`) whether
 * sidecars arriving there from then on are paired with their files. Only the default category is of the
 * `inbox` kind, and it cannot be removed. `remove` takes only a category that holds nothing but
 * empty folders, and whose directory of groups is empty.
 */
export const editCategory = async (cmd: Command, user: string, name: string, edit: CategoryEdit): Promise<CategoryEdited> => {
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const roots = stagingRoots(user);
  const path = categoryPath(user, name);
  const albums = categoryAlbumsPath(user, name);
  const changes = edit.kind !== undefined || edit.label !== undefined || edit.destination !== undefined || edit.noDestination === true ||
    edit.strategy !== undefined || edit.significance !== undefined || edit.digitized !== undefined || edit.filenameDates !== undefined || edit.lane !== undefined ||
    edit.sidecars !== undefined;
  const digitized = onOff('digitized', edit.digitized);
  const filenameDates = onOff('filename-dates', edit.filenameDates);
  if (!name || name.includes('/') || name === '.' || name === '..') throw new Error(`invalid category name '${name}'`);
  if (edit.create && edit.remove) throw new Error('--create and --remove exclude each other');
  if (edit.remove && changes) throw new Error('--remove takes no other change');
  if (edit.destination !== undefined && edit.noDestination) throw new Error('--destination and --no-destination exclude each other');
  if (edit.kind !== undefined && !isCategoryKind(edit.kind)) throw new Error(`unknown kind '${edit.kind}': one of ${CATEGORY_KINDS.join(', ')}`);
  if (edit.kind !== undefined && (edit.kind === 'inbox') !== (name === DEFAULT_CATEGORY)) {
    throw new Error(name === DEFAULT_CATEGORY ? `the default category ${name} is of the inbox kind` : 'only the default category is of the inbox kind');
  }
  if (edit.label !== undefined && edit.label.trim() === '') throw new Error('a label cannot be empty');
  if (edit.strategy !== undefined && !isStrategy(edit.strategy)) throw new Error(`unknown strategy '${edit.strategy}': one of ${GROUP_STRATEGIES.join(', ')}`);
  if (edit.significance !== undefined && !isSignificance(edit.significance)) {
    throw new Error(`unknown significance '${edit.significance}': one of ${SIGNIFICANCE_PRESETS.join(', ')}`);
  }
  if (edit.lane !== undefined && !isLane(edit.lane)) throw new Error(`unknown lane '${edit.lane}': one of ${STAGING_LANES.join(', ')}`);
  if (edit.sidecars !== undefined && !isSidecars(edit.sidecars)) throw new Error(`unknown sidecars '${edit.sidecars}': one of ${STAGING_SIDECARS.join(', ')}`);

  if (edit.remove) {
    if (name === DEFAULT_CATEGORY) throw new Error(`the default category ${name} cannot be removed`);
    const node = await vfs.get(access, path, { follow: false });
    if (node.type !== 'directory') throw new Error(`not a category: ${path}`);
    // A recursive unlink would follow a link into what it points at, so only empty folders go.
    const held = (await vfs.aggregate(access, { within: path, group: [{ column: 'type' }] })).filter((bucket) => bucket.key[0] !== 'directory');
    if (held.length > 0) throw new Error(`${path} is not empty: it holds ${held.map((bucket) => `${bucket.count} ${bucket.key[0]}`).join(', ')}`);
    if (await vfs.exists(access, albums, { follow: false })) {
      // The organizer's checkpoint and a request for a run are no groups: they go with the directory.
      const groups = (await vfs.children(access, albums)).filter((child) => child.name !== ORGANIZER_CHECKPOINT && child.name !== ORGANIZER_REQUEST);
      if (groups.length > 0) throw new Error(`${albums} still holds groups`);
      await vfs.unlink(access, albums, roots.albumsPath, { recursive: true, follow: false });
    }
    await vfs.unlink(access, path, roots.filesPath, { recursive: true, follow: false });
    return { created: false, removed: true, changed: [], entry: null };
  }

  let created = false;
  if (edit.create) {
    if (!CATEGORY_SLUG.test(name)) throw new Error(`a new category's name is lowercase letters, digits and dashes, at most 48: '${name}'`);
    if (await vfs.exists(access, path, { follow: false })) throw new Error(`category ${name} already exists`);
    if (!(await vfs.exists(access, roots.filesPath)) || !(await vfs.exists(access, roots.albumsPath))) {
      throw new Error(`${roots.stagingPath} is not set up: run staging init`);
    }
    const home = await vfs.get(access, roots.homePath);
    const props = { uid: home.props.uid, gid: home.props.gid, mode: STAGING_MODE };
    const settings = presetSettings((edit.kind ?? 'generic') as StagingCategoryKind, name);
    if (edit.strategy !== undefined) settings.group.strategy = edit.strategy as GroupStrategy;
    if (edit.significance !== undefined) settings.group.significance = edit.significance as SignificancePreset;
    if (digitized !== undefined) settings.time.digitized = digitized;
    if (filenameDates !== undefined) settings.time.filenameDates = filenameDates;
    if (edit.lane !== undefined) settings.lane = edit.lane as StagingLane;
    if (edit.sidecars !== undefined) settings.sidecars = edit.sidecars as StagingSidecars;
    await vfs.ensure(access, 'directory', roots.albumsPath, name, { props });
    await vfs.create(access, 'directory', roots.filesPath, name, { props, attrs: { [CATEGORY_ATTR]: settings } });
    created = true;
  }

  const node = await vfs.get(access, path, { follow: false }).catch(() => undefined);
  if (!node || node.type !== 'directory') throw new Error(`no category ${name} in ${roots.filesPath}`);
  const attrs = node.attrs as Record<string, unknown>;
  const current = parseCategorySettings(attrs[CATEGORY_ATTR], name);
  const next: StagingCategorySettings = edit.kind !== undefined
    ? presetSettings(edit.kind as StagingCategoryKind, name)
    : { ...current, group: { ...current.group }, time: { ...current.time } };
  if (edit.kind !== undefined && current.destinationId !== undefined) next.destinationId = current.destinationId;
  if (edit.label !== undefined) next.label = edit.label.trim();
  if (edit.noDestination) delete next.destinationId;
  if (edit.strategy !== undefined) next.group.strategy = edit.strategy as GroupStrategy;
  if (edit.significance !== undefined) next.group.significance = edit.significance as SignificancePreset;
  if (digitized !== undefined) next.time.digitized = digitized;
  if (filenameDates !== undefined) next.time.filenameDates = filenameDates;
  if (edit.lane !== undefined) next.lane = edit.lane as StagingLane;
  if (edit.sidecars !== undefined) next.sidecars = edit.sidecars as StagingSidecars;
  if (edit.destination !== undefined) {
    const target = resolve(cmd.cwd, edit.destination);
    if (parseStagedPath(target) !== undefined) throw new Error(`a destination is a library album, not ${target}`);
    const album = await vfs.get(access, target);
    if (album.type !== 'album' && album.type !== 'directory') throw new Error(`not an album: ${target}`);
    next.destinationId = album.id;
  }

  const differ = SETTING_FIELDS.filter((field) => !sameValue(current[field], next[field]));
  if (differ.length > 0) await vfs.update(access, path, { attrs: { [CATEGORY_ATTR]: next } });
  const changed = created ? [] : differ;
  return {
    created,
    removed: false,
    changed,
    entry: { name, id: node.id, path, attrs: { ...attrs, [CATEGORY_ATTR]: next }, settings: next },
  };
};
