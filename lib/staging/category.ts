/**
 * Categories: the directories under a staging area's `files/`, each with its settings in
 * `attrs.stagingCategory` (`StagingCategorySettings`) and its groups in `albums/<name>/`.
 */
import type { StagingCategorySettings } from '@archive/staging/api';
import type { Command } from '@ein/client';
import {
  CATEGORY_SLUG,
  categoryAlbumsPath,
  categoryPath,
  DEFAULT_CATEGORY,
  ORGANIZER_CHECKPOINT,
  ORGANIZER_REQUEST,
  STAGING_MODE,
  stagingRoots,
} from '@archive/staging/paths';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** The attr on a category's directory that holds its settings. */
export const CATEGORY_ATTR = 'stagingCategory';

/** The label a category has until it is given one: `Inbox` for the default category, else its directory's name. */
const defaultLabel = (name: string): string => name === DEFAULT_CATEGORY ? 'Inbox' : name;

/** A new category's settings, labelled `label` or by default. */
export const newCategorySettings = (name: string, label?: string): StagingCategorySettings => ({ label: label ?? defaultLabel(name) });

/** A category's settings from its attr, whatever is stored there: a missing or empty label is the default one, and any other field is left out. */
export const parseCategorySettings = (raw: unknown, name: string): StagingCategorySettings => {
  const stored = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return newCategorySettings(name, typeof stored.label === 'string' && stored.label.trim() !== '' ? stored.label : undefined);
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
type CategoryEdit = { create?: boolean; remove?: boolean; label?: string };

/** What `editCategory` did, and the category as it now is (null once removed). */
type CategoryEdited = { created: boolean; removed: boolean; changed: (keyof StagingCategorySettings)[]; entry: CategoryEntry | null };

/**
 * Create, relabel or remove `user`'s category `name`, or read it when `edit` asks nothing.
 *
 * `--create` makes its directory under `files/` and its directory of groups, private to the home's
 * owner, labelled `label` (by default its name). The default category cannot be removed. `remove`
 * takes only a category that holds nothing but empty folders, and whose directory of groups is
 * empty. A relabel writes the settings whole, so a stored field that is no setting goes.
 */
export const editCategory = async (cmd: Command, user: string, name: string, edit: CategoryEdit): Promise<CategoryEdited> => {
  const vfs = cmd.sys.vfs;
  const access = cmd.access;
  const roots = stagingRoots(user);
  const path = categoryPath(user, name);
  const albums = categoryAlbumsPath(user, name);
  if (!name || name.includes('/') || name === '.' || name === '..') throw new Error(`invalid category name '${name}'`);
  if (edit.create && edit.remove) throw new Error('--create and --remove exclude each other');
  if (edit.remove && edit.label !== undefined) throw new Error('--remove takes no other change');
  if (edit.label !== undefined && edit.label.trim() === '') throw new Error('a label cannot be empty');

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
    const settings = newCategorySettings(name, edit.label?.trim());
    await vfs.ensure(access, 'directory', roots.albumsPath, name, { props });
    await vfs.create(access, 'directory', roots.filesPath, name, { props, attrs: { [CATEGORY_ATTR]: settings } });
    created = true;
  }

  const node = await vfs.get(access, path, { follow: false }).catch(() => undefined);
  if (!node || node.type !== 'directory') throw new Error(`no category ${name} in ${roots.filesPath}`);
  const attrs = node.attrs as Record<string, unknown>;
  const current = parseCategorySettings(attrs[CATEGORY_ATTR], name);
  const next: StagingCategorySettings = { label: edit.label !== undefined ? edit.label.trim() : current.label };
  const differ = next.label === current.label ? [] : ['label' as const];
  if (differ.length > 0) await vfs.update(access, path, { attrs: { [CATEGORY_ATTR]: next } });
  const changed = created ? [] : differ;
  return {
    created,
    removed: false,
    changed,
    entry: { name, id: node.id, path, attrs: { ...attrs, [CATEGORY_ATTR]: next }, settings: next },
  };
};
