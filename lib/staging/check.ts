/**
 * `staging check`: one user's staging area against its rules, read only. Each problem names the
 * rule it breaks (`StagingCheckProblem`); `staging init` repairs the layout ones.
 *
 * - `staging/`, each of `STAGING_DIRS`, and each category's two directories are directories owned
 *   as the home is, mode 0700; `staging/` is unlisted.
 * - `files/` and `albums/` hold directories only, and every directory of groups has its category.
 * - The default category exists, of the `inbox` kind.
 * - Every link in a group points at a file in the group's own category, and at something there.
 * - A GPX file waiting for a device is in `routes/`.
 */
import type { StagingCheckAnswer, StagingCheckProblem } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { UNLISTED_ATTR } from '@ein/client';
import { CATEGORY_ATTR, readCategories } from '@archive/staging/category';
import { categoryAlbumsPath, DEFAULT_CATEGORY, STAGING_DIRS, STAGING_MODE, stagingRoots } from '@archive/staging/paths';
import { basename, dirname } from '@std/path';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Group links looked at, at most. */
const LINK_LIMIT = 20_000;

/** Entries read from a directory per page. */
const PAGE = 1000;

const childrenOf = async (vfs: Vfs, access: Access, path: string) => {
  const entries = [];
  let after: string | undefined;
  while (true) {
    const page = await vfs.children(access, path, { page: { limit: PAGE, ...(after !== undefined ? { after } : {}) } });
    entries.push(...page);
    if (page.length < PAGE) return entries;
    after = page[page.length - 1].name;
  }
};

/** Which of `targets` name nothing: one read of each distinct parent, and one of their child edges. */
const missingTargets = async (vfs: Vfs, access: Access, targets: string[]): Promise<Set<string>> => {
  const parents = new Map<string, string | undefined>();
  for (const parent of new Set(targets.map((target) => dirname(target)))) {
    parents.set(parent, await vfs.get(access, parent).then((node) => node.id, () => undefined));
  }
  const edges = await vfs.getChildLinksByIds(access, [...parents.values()].filter((id) => id !== undefined));
  const names = new Map([...edges].map(([id, links]) => [id, new Set(links.map((link) => link.name))]));
  const missing = new Set<string>();
  for (const target of targets) {
    const parent = parents.get(dirname(target));
    if (parent === undefined || !names.get(parent)?.has(basename(target))) missing.add(target);
  }
  return missing;
};

/** `user`'s staging area against its rules (`StagingCheckAnswer`). */
export const stagingCheck = async (vfs: Vfs, access: Access, user: string): Promise<StagingCheckAnswer> => {
  const roots = stagingRoots(user);
  const problems: StagingCheckProblem[] = [];
  const answer = (checkedLinks = 0, truncated = false): StagingCheckAnswer => ({ user, ok: problems.length === 0, checkedLinks, truncated, problems });
  const home = await vfs.get(access, roots.homePath);

  /** Whether `path` is a directory as the rules want it, carrying `marks`; each way it is not is a problem. */
  const checkDir = async (path: string, marks: { unlisted?: boolean } = {}): Promise<boolean> => {
    const node = await vfs.get(access, path, { follow: false }).catch(() => undefined);
    if (!node) {
      problems.push({ code: 'missing', path, detail: 'no such directory' });
      return false;
    }
    if (node.type !== 'directory') {
      problems.push({ code: 'not-directory', path, detail: `a ${node.type}` });
      return false;
    }
    if (marks.unlisted && node.attrs[UNLISTED_ATTR] !== true) {
      problems.push({ code: 'not-unlisted', path, detail: 'the library views list what it holds' });
    }
    const mode = node.props.mode & 0o7777;
    if (mode !== STAGING_MODE) problems.push({ code: 'mode', path, detail: `mode ${mode.toString(8).padStart(4, '0')}, not 0700` });
    if (node.props.uid !== home.props.uid || node.props.gid !== home.props.gid) {
      problems.push({ code: 'owner', path, detail: `owned by ${node.props.uid}:${node.props.gid}, not ${home.props.uid}:${home.props.gid}` });
    }
    return true;
  };

  if (!(await checkDir(roots.stagingPath, { unlisted: true }))) return answer();
  const present = new Set<string>();
  for (const dir of STAGING_DIRS) if (await checkDir(`${roots.stagingPath}/${dir}`)) present.add(dir);

  const categories = present.has('files') ? await readCategories(vfs, access, user) : [];
  const inbox = categories.find((category) => category.name === DEFAULT_CATEGORY);
  if (present.has('files') && (!inbox || inbox.attrs[CATEGORY_ATTR] === undefined || inbox.settings.kind !== 'inbox')) {
    problems.push({ code: 'no-inbox', path: `${roots.filesPath}/${DEFAULT_CATEGORY}`, detail: inbox ? 'not of the inbox kind' : 'no default category' });
  }
  for (const category of categories) await checkDir(category.path);

  if (present.has('files')) {
    for (const entry of await childrenOf(vfs, access, roots.filesPath)) {
      if (entry.node.type !== 'directory') {
        problems.push({ code: 'loose-entry', path: `${roots.filesPath}/${entry.name}`, detail: `a ${entry.node.type} outside every category` });
      }
    }
    const waiting = await vfs.query(access, { types: ['file'], where: [{ ref: 'trackDevicePending', op: 'eq', value: true }], within: roots.filesPath, limit: 100 });
    for (const entry of waiting) problems.push({ code: 'waiting-route', path: entry.absPath, detail: `waits for a device outside ${roots.routesPath}` });
  }

  if (!present.has('albums')) return answer();
  const names = new Set(categories.map((category) => category.name));
  const groupDirs: string[] = [];
  for (const entry of await childrenOf(vfs, access, roots.albumsPath)) {
    const path = `${roots.albumsPath}/${entry.name}`;
    if (entry.node.type !== 'directory') problems.push({ code: 'loose-entry', path, detail: `a ${entry.node.type} outside every category` });
    else if (!names.has(entry.name)) problems.push({ code: 'orphan-albums', path, detail: `no category ${roots.filesPath}/${entry.name}` });
    else groupDirs.push(entry.name);
  }
  for (const name of names) {
    if (!groupDirs.includes(name)) problems.push({ code: 'missing', path: categoryAlbumsPath(user, name), detail: 'no directory of groups for the category' });
  }

  // Every link of every group, up to the limit: where it points, and whether anything is there.
  const links: { path: string; target: string; category: string }[] = [];
  let truncated = false;
  collect: for (const name of groupDirs) {
    const dir = categoryAlbumsPath(user, name);
    await checkDir(dir);
    const groups = (await childrenOf(vfs, access, dir)).filter((entry) => entry.node.type === 'album');
    const listings = await vfs.childrenMany(access, groups.map((group) => `${dir}/${group.name}`));
    for (const [i, listing] of listings.entries()) {
      if (listing.status === 'rejected') continue;
      for (const child of listing.value) {
        const target = child.node.props.softlink;
        if (typeof target !== 'string') continue;
        if (links.length >= LINK_LIMIT) {
          truncated = true;
          break collect;
        }
        links.push({ path: `${dir}/${groups[i].name}/${child.name}`, target, category: name });
      }
    }
  }
  const missing = await missingTargets(vfs, access, [...new Set(links.map((link) => link.target))]);
  for (const link of links) {
    const own = `${roots.filesPath}/${link.category}/`;
    if (!link.target.startsWith(own)) problems.push({ code: 'cross-category', path: link.path, detail: `points at ${link.target}, outside ${own}` });
    else if (missing.has(link.target)) problems.push({ code: 'dangling-link', path: link.path, detail: `points at ${link.target}, which is gone` });
  }
  return answer(links.length, truncated);
};
