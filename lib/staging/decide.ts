/**
 * The decisions made in staging, as `staging promote`, `discard`, `accept`, `later` and `move` make
 * them. Each that takes files out of the inbox is one journal entry (`file.ts`), so `staging undo`
 * reverses it, after a reload as before one. A promote's entry also keeps the matches the group had
 * when the person chose (`matchDecisionOf`); a promote that makes a new album profiles it at once
 * and matches again the category's groups around its days, so the next day of a trip offers it.
 *
 * A group named with its member key (`--expect`) is decided only while its key is still that one:
 * a group the organizer changed after the person looked at it is answered in `changed`, and
 * nothing is written for it.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type {
  MatchConfidence,
  StagingAcceptResult,
  StagingDiscardResult,
  StagingLaterResult,
  StagingMoveResult,
  StagingPromoteResult,
  StagingUndoPlan,
} from '@archive/staging/api';
import type { Command } from '@ein/client';
import { applySharePreference, readSettings, resolveDefaultOwnership, shq, verifyAccess } from '@ein/client';
import { basename, dirname, resolve } from '@std/path';
import { AUTO_ORIGIN, type AutoAlbumMeta, COVER_LINK_NAME } from '@archive/staging/auto-album';
import { CATEGORY_ATTR, parseCategorySettings, readCategories } from '@archive/staging/category';
import { applyFiling, discardStagedMany, fileStagedMany, filesWord, planFiling } from '@archive/staging/file';
import { leaveSuggestedAlbums, suggestionsOf } from '@archive/staging/membership';
import { createJournalEntry, finishJournalEntry } from '@archive/staging/journal';
import { categoryPath, isStagingGroup, parseStagedPath, stagedPlace } from '@archive/staging/paths';
import { atLeast, type Proposal, proposalInputOf, proposeDestination } from '@archive/staging/proposal';
import { albumRefs } from '@archive/staging/status';
import { dayOfWall, profileAlbums } from '@archive/media/album-profile';
import { NON_MEMBER_LINK_NAMES } from '@archive/media/types';
import { matchDecisionOf, rematchAround } from '@archive/staging/match';
import { nodesAt } from '@archive/staging/nodes-at';
import { currentMatches, type GroupRowAttrs, matchedAlbumIds, stagingRowOf } from '@archive/staging/rows';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Groups one `staging accept` decides at most, and plans at most with `--dry-run`. */
export const ACCEPT_MAX = 20;
export const ACCEPT_PLAN_MAX = 50;
/** Groups one `staging later` puts aside at most. */
export const LATER_MAX = 100;

const FILES_DIR = 'files';

/** A suggested group as a decision reads it. */
type Group = {
  path: string;
  slug: string;
  name: string;
  node: Awaited<ReturnType<Vfs['get']>>;
  attrs: GroupRowAttrs;
  meta?: AutoAlbumMeta;
  /** Its member links: name and target. */
  links: { name: string; target: string }[];
};

/** Whose staging area and which category a decision is in. */
type Place = { user: string; category: string };

/**
 * Read the suggested groups `paths`, all of one category, each checked against its entry of
 * `expect` when given: the groups to decide, and those whose member key is no longer the one
 * expected. Throws for a path that is not a suggested group, for groups of different categories,
 * and for a member outside its group's category.
 */
const readGroups = async (cmd: Command, paths: string[], expect?: string[]): Promise<{ groups: Group[]; changed: string[]; place: Place }> => {
  if (expect && expect.length > 0 && expect.length !== paths.length) throw new Error(`--expect takes one member key per group: ${paths.length} groups, ${expect.length} keys`);
  let place: Place | undefined;
  const groups: Group[] = [];
  const changed: string[] = [];
  for (const [index, path] of paths.entries()) {
    const parsed = isStagingGroup(path) ? parseStagedPath(path) : undefined;
    if (!parsed?.category) throw new Error(`not a suggested group: ${path}`);
    if (place && (place.user !== parsed.user || place.category !== parsed.category)) throw new Error(`groups of different categories: ${path}`);
    place = { user: parsed.user, category: parsed.category };
    const node = await cmd.sys.vfs.get<GroupRowAttrs & { origin?: string }>(cmd.access, path);
    if (node.type !== 'album' || node.attrs.origin !== AUTO_ORIGIN) throw new Error(`not a suggested group: ${path}`);
    const meta = node.attrs.autoAlbum;
    if (expect && expect.length > 0 && meta?.memberKey !== expect[index]) {
      changed.push(path);
      continue;
    }
    const files = `${categoryPath(parsed.user, parsed.category)}/`;
    const links = (await cmd.sys.vfs.children(cmd.access, path))
      .filter((child) => child.name !== COVER_LINK_NAME && typeof child.node.props.softlink === 'string')
      .map((child) => ({ name: child.name, target: child.node.props.softlink! }));
    const outside = links.find((link) => !link.target.startsWith(files));
    if (outside) throw new Error(`member is outside the group's category: ${outside.target}`);
    groups.push({
      path,
      slug: basename(path),
      name: typeof node.attrs.name === 'string' && node.attrs.name ? node.attrs.name : basename(path),
      node,
      attrs: node.attrs,
      meta,
      links,
    });
  }
  if (!place) throw new Error('no group named');
  return { groups, changed, place };
};

/**
 * The path segment a library album gets from its title: the title with a slash (which would make
 * it two segments) written as a dash and its spaces evened out; a title of dots alone, or of
 * nothing, gives `album`.
 */
const albumSegment = (title: string): string => {
  const segment = title.replace(/\//g, '-').replace(/\s+/g, ' ').trim();
  return /^\.*$/.test(segment) ? 'album' : segment;
};

/** `root/<segment>` for `title`, numbered `(2)`, `(3)`, … past a name taken there. */
const freeAlbumPath = async (vfs: Vfs, access: Access, root: string, title: string): Promise<string> => {
  const segment = albumSegment(title);
  for (let n = 1;; n++) {
    const path = `${root}/${n === 1 ? segment : `${segment} (${n})`}`;
    if (!(await vfs.exists(access, path, { follow: false }))) return path;
  }
};

/**
 * Where an album keeps the members filed into it: in its `files/` when it has one and holds no
 * media or member links of its own, as an imported album does; in itself otherwise.
 */
const memberDirOf = async (vfs: Vfs, access: Access, album: string): Promise<string> => {
  const children = await vfs.children(access, album);
  const holdsMedia = children.some((child) => !NON_MEMBER_LINK_NAMES.includes(child.name) && (child.node.type === 'file' || child.node.props.softlink));
  return !holdsMedia && children.some((child) => child.name === FILES_DIR && child.node.type === 'directory') ? `${album}/${FILES_DIR}` : album;
};

/** Pin the groups `paths` that are still there: a person chose what is left in them. */
const pin = async (vfs: Vfs, access: Access, paths: string[]): Promise<void> => {
  for (const path of paths) {
    const node = await vfs.get<{ autoAlbum?: AutoAlbumMeta }>(access, path, { follow: false }).catch(() => undefined);
    if (node?.attrs.autoAlbum) await vfs.update(access, path, { attrs: { autoAlbum: { ...node.attrs.autoAlbum, pinned: true } } });
  }
};

type PromoteOptions = {
  /** File into this library album. */
  into?: string;
  /** Make a new library album with this title. */
  name?: string;
  /** The directory the new album is made in. */
  to?: string;
  /** `private`: the new album is its owner's alone; `default`, or none: shared as the owner's new albums are. */
  share?: 'private' | 'default';
  except?: string[];
  expect?: string[];
  dryRun?: boolean;
};

/**
 * Promote suggested groups `paths`, all of one category, into one library album: the one named by
 * `into`, or a new one titled `name` (the first group's name by default) in `to`, its path made
 * from the title and numbered on a clash. Every member but those of `except` is filed
 * (`planFiling`, `applyFiling`); a group whose members all go is deleted, and one that keeps some
 * is pinned. A new album whose first group goes whole is that group's node, so it keeps its id;
 * otherwise a new node. A new album is then shared as its owner's new albums are, or privately.
 * One journal entry, made before anything changes, records it all.
 */
export const promoteGroups = async (cmd: Command, paths: string[], options: PromoteOptions = {}): Promise<StagingPromoteResult> => {
  if (options.into !== undefined && options.name !== undefined) throw new Error('--into and --name cannot both be given');
  if (options.into !== undefined && (options.share !== undefined || options.to !== undefined)) {
    throw new Error('--share and --to are for a new album; --into files into one that is there');
  }
  const { vfs } = cmd.sys;
  const dryRun = options.dryRun === true;
  const { groups, changed, place } = await readGroups(cmd, paths, options.expect);
  const result: StagingPromoteResult = {
    ok: true,
    dryRun,
    journal: null,
    album: null,
    groups: groups.map((group) => group.path),
    moved: 0,
    groupsRemoved: [],
    groupsChanged: [],
    changed,
    failed: [],
  };
  if (groups.length === 0) return result;

  const except = new Set((options.except ?? []).map((path) => resolve(cmd.cwd, path)));
  const files = [...new Set(groups.flatMap((group) => group.links.map((link) => link.target).filter((target) => !except.has(target))))];
  const keeping = groups.filter((group) => group.links.some((link) => except.has(link.target))).map((group) => group.path);

  let albumPath: string;
  let albumDir: string;
  let title: string;
  let albumId: string | undefined;
  const first = groups[0];
  const asGroup = options.into === undefined && !keeping.includes(first.path);
  if (options.into !== undefined) {
    albumPath = resolve(cmd.cwd, options.into);
    if (parseStagedPath(albumPath) !== undefined) throw new Error(`${albumPath} is in staging, not in the library`);
    const album = await vfs.get<{ name?: string }>(cmd.access, albumPath);
    if (album.type !== 'album') throw new Error(`${albumPath}: not an album (is ${album.type})`);
    albumId = album.id;
    title = typeof album.attrs.name === 'string' && album.attrs.name ? album.attrs.name : basename(albumPath);
    albumDir = await memberDirOf(vfs, cmd.access, albumPath);
  } else {
    title = options.name?.trim() || first.name;
    const root = resolve(cmd.cwd, options.to ?? ALBUMS_ROOT);
    if (parseStagedPath(root) !== undefined) throw new Error(`${root} is in staging, not in the library`);
    const rootNode = await vfs.get(cmd.access, root);
    if (!verifyAccess(cmd.access, rootNode.props, 'w') || !verifyAccess(cmd.access, rootNode.props, 'x')) throw new Error(`cannot make an album in ${root}`);
    albumPath = await freeAlbumPath(vfs, cmd.access, root, title);
    albumDir = `${albumPath}/${FILES_DIR}`;
    if (asGroup) albumId = first.node.id;
  }
  result.album = { path: albumPath, title, created: options.into === undefined };
  if (dryRun) {
    result.moved = files.length;
    return result;
  }

  const plan = await planFiling(cmd, files, albumDir, asGroup ? `${first.path}/${FILES_DIR}` : undefined);
  const matched = groups.find((group) => currentMatches(group.attrs));
  const matchDecision = matched ? matchDecisionOf(matched.attrs, options.into === undefined ? 'new' : albumId!) : undefined;
  const idOf = new Map(plan.moves.map((move) => [move.from, move.id]));
  const undo: StagingUndoPlan = { kind: 'filed', moves: plan.moves, groups: plan.groups.filter((group) => !asGroup || group.path !== first.path) };
  if (asGroup) {
    undo.group = {
      id: first.node.id,
      from: first.path,
      to: albumPath,
      attrs: first.node.attrs,
      props: { uid: first.node.props.uid, gid: first.node.props.gid, mode: first.node.props.mode },
      links: first.links.flatMap((link) => idOf.has(link.target) ? [{ ...link, id: idOf.get(link.target)! }] : []),
    };
  }
  const entry = await createJournalEntry(
    vfs,
    cmd.access,
    place.user,
    {
      category: place.category,
      action: 'promote',
      files: plan.moves.length,
      summary: `${filesWord(plan.moves.length)} → ${title}`,
      ...(albumId ? { albums: [albumId] } : {}),
      groups: groups.map((group) => ({ slug: group.slug, name: group.name })),
      ...(options.share === 'private' ? { share: 'private' as const } : {}),
    },
    undo,
    matchDecision ? { matchDecision } : {},
  );
  result.journal = entry.id;

  let state: 'done' | 'partial' = 'partial';
  const created: string[] = [];
  try {
    if (asGroup) {
      await vfs.rename(cmd.access, dirname(first.path), first.slug, dirname(albumPath), basename(albumPath), { failIfExists: true });
      // The album holds its files in `files/` instead of its member links, which go before their
      // files move, so the move has none of them to re-point.
      const unlinked = await vfs.unlinkMany(cmd.access, first.links.map((link) => `${albumPath}/${link.name}`));
      const refused = unlinked.find((outcome) => outcome.status === 'rejected');
      if (refused) throw refused.reason;
      await vfs.ensure(cmd.access, 'directory', albumPath, FILES_DIR, { props: { uid: first.node.props.uid, gid: first.node.props.gid, mode: 0o700 } });
    } else if (options.into === undefined) {
      await vfs.createTree(cmd.access, dirname(albumPath), [{
        type: 'album',
        name: basename(albumPath),
        props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o700 },
        attrs: { name: title },
        children: [{ type: 'directory', name: FILES_DIR, props: { uid: cmd.access.uid, gid: cmd.access.gid, mode: 0o700 } }],
      }]);
      albumId = (await vfs.get(cmd.access, albumPath)).id;
      created.push(albumId);
    }

    const filed = await applyFiling(cmd, plan);
    result.moved = filed.filed.length;
    result.failed = filed.failed;
    result.groupsRemoved = filed.groupsRemoved;
    result.groupsChanged = filed.groupsChanged;

    if (asGroup) {
      await vfs.update(cmd.access, albumPath, { attrs: { origin: null, autoAlbum: null, stagingLaterAt: null, stagingMatches: null, name: title } });
      result.groupsRemoved.push(first.path);
    }

    if (options.into === undefined) {
      const ownership = await resolveDefaultOwnership(cmd, cmd.access);
      const settings = await readSettings(cmd, cmd.access);
      const preference = options.share === 'private' ? 'private' : settings.CFG_USER_DEFAULT_SHARE;
      const mode = applySharePreference(ownership.mode, preference);
      const share = await cmd.execute(
        `share-set ${shq(albumPath)} --mode=${mode.toString(8).padStart(4, '0')} --default-owner${preference === 'everyone' ? ' -m g:users:rx' : ''}`,
      );
      if (share.code !== 0) throw new Error(share.stderr.trim() || 'failed to apply shared album access');
    }

    await pin(vfs, cmd.access, keeping);
    // Media filed into `files/` raise no membership fact of their own, so the span is asked for here.
    await cmd.execute(`album-span ${shq(albumPath)}`);
    if (options.into === undefined) await followNewAlbum(cmd, place, albumPath);
    if (result.failed.length === 0) state = 'done';
    return result;
  } finally {
    await finishJournalEntry(vfs, cmd.access, entry, {
      state,
      ...(albumId ? { albums: [albumId] } : {}),
      ...(created.length > 0 ? { created } : {}),
    });
  }
};

/**
 * Profile the album a promote just made and match again the groups of the category around its
 * days, so they can offer it. Its members are the promote's own, so the promoter reads them all.
 * What fails here leaves the promote done: the album's pipeline profiles it as well.
 */
const followNewAlbum = async (cmd: Command, place: Place, albumPath: string): Promise<void> => {
  try {
    const album = await cmd.sys.vfs.get(cmd.access, albumPath);
    const [outcome] = await profileAlbums(cmd, [{ path: albumPath, id: album.id, props: { uid: album.props.uid, gid: album.props.gid, mode: album.props.mode } }], {
      write: true,
    });
    if (outcome?.profile) await rematchAround(cmd, place.user, place.category, outcome.profile.changedDays);
  } catch {
    // The album's own pipeline profiles it, and the organizer matches the groups around it.
  }
};

/** Paths of `paths` that do not lie under another of them: a folder discarded takes what is in it. */
const outermost = (paths: string[]): string[] => {
  const set = new Set(paths);
  return [...set].filter((path) => {
    for (let at = dirname(path); at !== '/' && at !== '.'; at = dirname(at)) if (set.has(at)) return false;
    return true;
  });
};

/**
 * Discard `targets` — suggested groups (their members but those of `except`) and staged files and
 * folders, all of one category — into the caller's trash, as one journal entry
 * (`discardStagedMany`). A group that keeps excepted members is pinned. A dry run counts what
 * would go and changes nothing.
 */
export const discardTargets = async (
  cmd: Command,
  targets: string[],
  options: { except?: string[]; expect?: string[]; dryRun?: boolean } = {},
): Promise<StagingDiscardResult> => {
  const { vfs } = cmd.sys;
  const dryRun = options.dryRun === true;
  const groupPaths = targets.filter((path) => isStagingGroup(path));
  const staged = targets.filter((path) => !isStagingGroup(path));
  let place: Place | undefined;
  for (const path of staged) {
    const at = stagedPlace(path);
    if (!at) throw new Error(`not staged: ${path}`);
    if (place && (place.user !== at.user || place.category !== at.category)) throw new Error(`not in one category: ${path}`);
    place = at;
  }

  const read = groupPaths.length > 0 ? await readGroups(cmd, groupPaths, options.expect) : { groups: [], changed: [], place };
  if (place && read.place && (place.user !== read.place.user || place.category !== read.place.category)) throw new Error('not in one category');
  place ??= read.place;
  const result: StagingDiscardResult = { ok: true, dryRun, journal: null, files: 0, batches: [], groupsRemoved: [], groupsChanged: [], changed: read.changed, failed: [] };
  if (!place) return result;

  const except = new Set((options.except ?? []).map((path) => resolve(cmd.cwd, path)));
  const members = read.groups.flatMap((group) => group.links.map((link) => link.target).filter((target) => !except.has(target)));
  const paths = outermost([...members, ...staged]);
  if (paths.length === 0) return result;
  if (dryRun) {
    result.files = paths.length;
    return result;
  }

  const category = await vfs.get<Record<string, unknown>>(cmd.access, categoryPath(place.user, place.category));
  const label = parseCategorySettings(category.attrs[CATEGORY_ATTR], place.category).label;
  const what = read.groups.length === 1 && staged.length === 0 ? `“${read.groups[0].name}”` : `${paths.length.toLocaleString('en')} items`;
  const discarded = await discardStagedMany(cmd, place.user, place.category, paths, {
    label: `Discarded from ${label}: ${what}`,
    groups: read.groups.map((group) => ({ slug: group.slug, name: group.name })),
  });
  await pin(vfs, cmd.access, read.groups.filter((group) => group.links.some((link) => except.has(link.target))).map((group) => group.path));
  return { ...result, ...discarded, journal: discarded.journal };
};

/**
 * File an Everyday lane's days that are matched to an album the caller may file into, each day's
 * files into its album (`fileStagedMany`): one journal entry per album. The rest of the lane stays.
 */
const fileMatchedDays = async (cmd: Command, group: Group, refs: ReadonlyMap<string, { path: string; title: string; writable: boolean }>): Promise<string[]> => {
  const { vfs } = cmd.sys;
  const days = new Map((currentMatches(group.attrs)?.days ?? []).filter((day) => refs.get(day.albumId)?.writable).map((day) => [day.day, day.albumId]));
  const nodes = await nodesAt(vfs, cmd.access, group.links.map((link) => link.target));
  const byAlbum = new Map<string, string[]>();
  for (const link of group.links) {
    const day = dayOfWall(nodes.get(link.target)?.attrs.takenAt as string | undefined);
    const albumId = day ? days.get(day) : undefined;
    if (albumId) byAlbum.set(albumId, [...byAlbum.get(albumId) ?? [], link.target]);
  }
  const journal: string[] = [];
  for (const [albumId, files] of byAlbum) {
    const album = refs.get(albumId)!;
    const filed = await fileStagedMany(cmd, files, await memberDirOf(vfs, cmd.access, album.path), { id: albumId, title: album.title, created: false });
    journal.push(...filed.journal);
    await cmd.execute(`album-span ${shq(album.path)}`);
  }
  return journal;
};

/**
 * Apply each group's proposal (`proposeDestination`, from its current matches): file it into the
 * album proposed, or into a new album under its title, each group its own decision and journal
 * entry; for an Everyday lane, file its matched days into their albums. A group whose proposal is
 * less sure than `confidence`, or that has none, is left as it is, and so is one whose member key
 * is not its entry of `expect`, and one proposed to be discarded: accept files, and never discards.
 * A dry run answers the plan alone.
 */
export const acceptGroups = async (
  cmd: Command,
  paths: string[],
  options: { confidence?: MatchConfidence; expect?: string[]; dryRun?: boolean } = {},
): Promise<StagingAcceptResult> => {
  const dryRun = options.dryRun === true;
  const max = dryRun ? ACCEPT_PLAN_MAX : ACCEPT_MAX;
  if (paths.length > max) throw new Error(`accept takes at most ${max} groups${dryRun ? ' with --dry-run' : ''}`);
  const floor = options.confidence ?? 'medium';
  const { groups, changed, place } = await readGroups(cmd, paths, options.expect);
  const result: StagingAcceptResult = { ok: true, dryRun, plan: [], journal: [], skipped: changed.map((group) => ({ group, reason: 'changed' as const })) };

  const category = (await readCategories(cmd.sys.vfs, cmd.access, place.user)).find((each) => each.name === place.category);
  const targetId = category?.settings.destinationId;
  const categoryTarget = targetId ? (await albumRefs(cmd.sys.vfs, cmd.access, [targetId])).get(targetId) ?? null : null;

  const refs = await albumRefs(cmd.sys.vfs, cmd.access, [...new Set(groups.flatMap((group) => matchedAlbumIds(group.attrs)))]);
  const decide: { group: Group; proposal: Proposal }[] = [];
  for (const group of groups) {
    const staging = stagingRowOf(group.attrs, refs);
    const proposal = proposeDestination(staging ? proposalInputOf(group.name, staging, categoryTarget) : { kind: group.meta?.kind, title: group.name, categoryTarget });
    result.plan.push({ group: group.path, proposal, files: proposal.action === 'parts' ? proposal.files : group.links.length });
    // Accept files groups; keeping the library's copies is the open group's own decision.
    if (proposal.action === 'none' || proposal.action === 'dedupe') result.skipped.push({ group: group.path, reason: 'no-proposal' });
    else if (proposal.action === 'discard') result.skipped.push({ group: group.path, reason: 'discard' });
    else if (!atLeast(proposal, floor)) result.skipped.push({ group: group.path, reason: 'below-confidence' });
    else decide.push({ group, proposal });
  }
  if (dryRun) return result;

  for (const { group, proposal } of decide) {
    if (proposal.action === 'parts') {
      result.journal.push(...await fileMatchedDays(cmd, group, refs));
      continue;
    }
    const expect = group.meta?.memberKey ? [group.meta.memberKey] : undefined;
    const promoted = proposal.action === 'existing'
      ? await promoteGroups(cmd, [group.path], { into: proposal.album.path, expect })
      : await promoteGroups(cmd, [group.path], { name: proposal.action === 'new' ? proposal.title : group.name, expect });
    if (promoted.changed.length > 0) result.skipped.push({ group: group.path, reason: 'changed' });
    if (promoted.journal) result.journal.push(promoted.journal);
  }
  return result;
};

/** Put suggested groups aside for later (`stagingLaterAt`), or with `off` back where they were. */
export const laterGroups = async (cmd: Command, paths: string[], off: boolean): Promise<StagingLaterResult> => {
  if (paths.length > LATER_MAX) throw new Error(`later takes at most ${LATER_MAX} groups`);
  for (const path of paths) if (!isStagingGroup(path)) throw new Error(`not a suggested group: ${path}`);
  const settled = await cmd.sys.vfs.updateMany(cmd.access, paths, {
    attrs: { stagingLaterAt: off ? null : new Date().toISOString() },
    guard: (node) => {
      if (node.type !== 'album' || node.attrs.origin !== AUTO_ORIGIN) throw new Error('not a suggested group');
    },
  });
  const refused = settled.findIndex((outcome) => outcome.status === 'rejected');
  if (refused >= 0) {
    const reason = (settled[refused] as PromiseRejectedResult).reason;
    throw new Error(`${paths[refused]}: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
  return { ok: true, groups: paths, later: !off };
};

/**
 * Move staged files and folders into `dir`, a folder of a category of the same staging area, with
 * every link to them following (`renameMany`). Those going to another category first leave their
 * own category's suggested groups, which hold only what is in their category. A name taken in
 * `dir` is refused for that entry alone.
 */
export const moveStaged = async (cmd: Command, sources: string[], dir: string): Promise<StagingMoveResult> => {
  const { vfs } = cmd.sys;
  const parsed = parseStagedPath(dir);
  if (parsed?.area !== 'files' || parsed.category === undefined) throw new Error(`not a folder of a staging category: ${dir}`);
  const target = await vfs.get(cmd.access, dir);
  if (target.type !== 'directory') throw new Error(`not a folder: ${dir}`);

  const leaving = new Map<string, string[]>();
  for (const source of sources) {
    const place = stagedPlace(source);
    if (!place || place.user !== parsed.user) throw new Error(`not staged in ${parsed.user}'s staging area: ${source}`);
    if (place.category === parsed.category) continue;
    const albums = suggestionsOf(source)!;
    leaving.set(albums, [...leaving.get(albums) ?? [], source]);
  }
  let left = 0;
  for (const [albumsPath, paths] of leaving) {
    const outcome = await leaveSuggestedAlbums(vfs, cmd.access, paths, albumsPath);
    left += outcome.removed.length + outcome.changed.length;
  }

  const moves = sources.map((source) => ({ from: source, to: `${dir}/${basename(source)}` }));
  const settled = await vfs.renameMany(cmd.access, moves, { failIfExists: true });
  const result: StagingMoveResult = { ok: true, moved: 0, relinked: 0, left, failed: [] };
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      result.moved++;
      result.relinked += outcome.value.relinked;
    } else result.failed.push({ path: moves[i].from, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  });
  return result;
};
