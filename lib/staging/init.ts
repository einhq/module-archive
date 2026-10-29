/**
 * `staging init`: make one user's staging area whole, and keep it so.
 *
 * 1. `staging/` and each of `STAGING_DIRS` are directories owned as the home is, mode 0700, and
 *    `staging/` is unlisted (`UNLISTED_ATTR`), so the library's views leave out what it holds.
 * 2. The default category exists with the `inbox` kind, and every other directory under `files/`
 *    is a category: one without settings is adopted with the `generic` kind's. Each category has
 *    its directory of groups under `albums/`, owned and private the same way.
 * 3. Unless only the layout is asked for, what does not belong where it is moves, with every link
 *    to it following (`renameMany`): a GPX file waiting for a device into `routes/`; any other
 *    entry of `files/` that is not a directory into the default category's loose batch; an entry
 *    of `albums/` that is not a directory (a group from before categories) into the default
 *    category's groups. A name taken there gets `-2`, `-3`, … before its extension. With `idleMs`,
 *    a loose file of `files/` changed more recently than that stays where it is (`recent`), since
 *    a copy still being written by path would break if it moved.
 *
 * On an area already whole it reads and writes nothing else. With `dryRun` it writes nothing and
 * answers what it would do.
 */
import type { StagingInitUser } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { UNLISTED_ATTR } from '@ein/client';
import { CATEGORY_ATTR, presetSettings, readCategories } from '@archive/staging/category';
import { DEFAULT_CATEGORY, STAGING_DIRS, STAGING_MODE, stagingRoots } from '@archive/staging/paths';
import { basename } from '@std/path';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Where the loose entries of `files/` go in the default category when no batch is named. */
const DEFAULT_LOOSE_BATCH = 'unsorted';

/** Entries read from a directory per page, and GPX files found per query. */
const PAGE = 1000;

type InitOptions = {
  /** The default category's directory the loose entries of `files/` move into. */
  looseBatch?: string;
  /** Report what would be done, and do none of it. */
  dryRun?: boolean;
  /** Only the directories and categories (steps 1 and 2): nothing moves. */
  layoutOnly?: boolean;
  /** Leave the loose entries of `files/` changed within this many milliseconds. */
  idleMs?: number;
};

/** `name`, or `name-2`, `name-3`, … before its extension — the first not in `used`, which it joins. */
const freeName = (name: string, used: Set<string>): string => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
  used.add(candidate);
  return candidate;
};

/** Every child of `path` in name order, a page at a time; none when it does not exist. */
const allChildren = async (vfs: Vfs, access: Access, path: string) => {
  if (!(await vfs.exists(access, path))) return [];
  const entries = [];
  let after: string | undefined;
  while (true) {
    const page = await vfs.children(access, path, { page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
    entries.push(...page);
    if (page.length < PAGE) return entries;
    after = page[page.length - 1].name;
  }
};

/** Make `user`'s staging area whole (see the file's comment), or say what that would take. */
export const initStaging = async (vfs: Vfs, access: Access, user: string, options: InitOptions = {}): Promise<StagingInitUser> => {
  const roots = stagingRoots(user);
  const looseBatch = options.looseBatch ?? DEFAULT_LOOSE_BATCH;
  if (!looseBatch || looseBatch === '.' || looseBatch === '..' || looseBatch.includes('/')) throw new Error(`invalid loose batch '${looseBatch}'`);
  const dryRun = options.dryRun === true;
  const answer: StagingInitUser = { user, created: [], repaired: [], adopted: [], moved: 0, movedTo: null, recent: 0, groups: 0, routes: 0, relinked: 0, failed: [] };

  const home = await vfs.get(access, roots.homePath);
  const owner = { uid: home.props.uid, gid: home.props.gid, mode: STAGING_MODE };

  /**
   * `parent/name` as a private directory of the home's owner: made with `attrs`, or its props put
   * right. `marks` are attrs it carries however it was made, written where they differ.
   */
  const ensureDir = async (parent: string, name: string, attrs?: Record<string, unknown>, marks: Record<string, unknown> = {}): Promise<void> => {
    const path = `${parent}/${name}`;
    const node = await vfs.get(access, path, { follow: false }).catch(() => undefined);
    if (!node) {
      answer.created.push(path);
      if (!dryRun) await vfs.ensure(access, 'directory', parent, name, { props: owner, attrs: { ...attrs, ...marks } });
      return;
    }
    if (node.type !== 'directory') throw new Error(`not a directory: ${path}`);
    const owned = node.props.uid === owner.uid && node.props.gid === owner.gid && (node.props.mode & 0o7777) === STAGING_MODE;
    const marked = Object.entries(marks).every(([key, value]) => node.attrs[key] === value);
    if (!owned || !marked) {
      answer.repaired.push(path);
      if (!dryRun) await vfs.update(access, path, { ...(owned ? {} : { props: owner }), ...(marked ? {} : { attrs: marks }) });
    }
  };

  await ensureDir(roots.homePath, 'staging', undefined, { [UNLISTED_ATTR]: true });
  for (const dir of STAGING_DIRS) await ensureDir(roots.stagingPath, dir);

  const categories = await readCategories(vfs, access, user);
  const inbox = categories.find((category) => category.name === DEFAULT_CATEGORY);
  if (!inbox) await ensureDir(roots.filesPath, DEFAULT_CATEGORY, { [CATEGORY_ATTR]: presetSettings('inbox', DEFAULT_CATEGORY) });
  for (const category of categories) {
    await ensureDir(roots.filesPath, category.name);
    const stored = category.attrs[CATEGORY_ATTR];
    if (category.name === DEFAULT_CATEGORY && (stored === undefined || category.settings.kind !== 'inbox')) {
      if (!answer.repaired.includes(category.path)) answer.repaired.push(category.path);
      if (!dryRun) await vfs.update(access, category.path, { attrs: { [CATEGORY_ATTR]: { ...category.settings, kind: 'inbox' } } });
    } else if (stored === undefined) {
      answer.adopted.push(category.path);
      if (!dryRun) await vfs.update(access, category.path, { attrs: { [CATEGORY_ATTR]: presetSettings('generic', category.name) } });
    }
  }
  for (const name of new Set([DEFAULT_CATEGORY, ...categories.map((category) => category.name)])) await ensureDir(roots.albumsPath, name);

  if (options.layoutOnly) return answer;

  const inboxPath = `${roots.filesPath}/${DEFAULT_CATEGORY}`;
  const moves: { from: string; to: string; kind: 'moved' | 'groups' | 'routes' }[] = [];

  // A GPX file waiting for a device, wherever under files/ it is.
  const waiting = new Set<string>();
  if (await vfs.exists(access, roots.filesPath)) {
    let after: string | undefined;
    while (true) {
      const page = await vfs.query(access, {
        types: ['file'],
        where: [{ ref: 'trackDevicePending', op: 'eq', value: true }],
        within: roots.filesPath,
        limit: PAGE,
        ...(after !== undefined ? { after: { value: null, id: after } } : {}),
      });
      for (const entry of page) waiting.add(entry.absPath);
      if (page.length < PAGE) break;
      after = page[page.length - 1].id;
    }
  }
  if (waiting.size > 0) {
    const used = new Set((await allChildren(vfs, access, roots.routesPath)).map((entry) => entry.name));
    for (const path of [...waiting].sort()) moves.push({ from: path, to: `${roots.routesPath}/${freeName(basename(path), used)}`, kind: 'routes' });
  }

  const changedSince = options.idleMs === undefined ? Infinity : Date.now() - options.idleMs;
  const loose = (await allChildren(vfs, access, roots.filesPath))
    .filter((entry) => entry.node.type !== 'directory' && !waiting.has(`${roots.filesPath}/${entry.name}`))
    .filter((entry) => {
      const { birthtime, changetime, modtime } = entry.node.props;
      const idle = Math.max(birthtime.timestamp, changetime.timestamp, modtime.timestamp) <= changedSince;
      if (!idle) answer.recent++;
      return idle;
    });
  if (loose.length > 0) {
    const batchPath = `${inboxPath}/${looseBatch}`;
    await ensureDir(inboxPath, looseBatch);
    answer.movedTo = batchPath;
    const used = new Set((await allChildren(vfs, access, batchPath)).map((entry) => entry.name));
    for (const entry of loose) moves.push({ from: `${roots.filesPath}/${entry.name}`, to: `${batchPath}/${freeName(entry.name, used)}`, kind: 'moved' });
  }

  const looseGroups = (await allChildren(vfs, access, roots.albumsPath)).filter((entry) => entry.node.type !== 'directory');
  if (looseGroups.length > 0) {
    const groupsPath = `${roots.albumsPath}/${DEFAULT_CATEGORY}`;
    const used = new Set((await allChildren(vfs, access, groupsPath)).map((entry) => entry.name));
    for (const entry of looseGroups) moves.push({ from: `${roots.albumsPath}/${entry.name}`, to: `${groupsPath}/${freeName(entry.name, used)}`, kind: 'groups' });
  }

  if (dryRun) {
    for (const move of moves) answer[move.kind]++;
    return answer;
  }
  if (moves.length === 0) return answer;
  const settled = await vfs.renameMany(access, moves.map(({ from, to }) => ({ from, to })), { failIfExists: true });
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      answer[moves[i].kind]++;
      answer.relinked += outcome.value.relinked;
    } else {
      answer.failed.push({ path: moves[i].from, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    }
  });
  return answer;
};
