/**
 * Undoing a journal entry by its plan (`StagingUndoPlan`): files filed into the library move back
 * to where they were staged, files discarded come back out of the trash, and the suggested groups
 * they left get them back — the ones deleted are made again under their own names. A grouping edit
 * is undone by giving the groups it changed their members, names and pins back.
 *
 * Paths in a plan are history: each file is found again by its node id, and only one still where
 * the decision put it moves back; one moved since stays where it is and is reported. Undo never
 * pins a group a decision changed: each group's member key is put right for the members it gets
 * back, so the next organizer run treats it as its own.
 */
import type { GroupSnapshot, StagingUndoPlan } from '@archive/staging/api';
import type { TrashRestoreResult } from '@ein/api';
import { recordPaths } from '@archive/staging/duplicates';
import type { Command } from '@ein/client';
import { shq, verifyAccess } from '@ein/client';
import { basename, dirname } from '@std/path';
import { type AutoAlbumMeta, COVER_LINK_NAME, freeLinkName, isMemberKey, linkSpec, memberKeyOf, toggleMembers } from '@archive/staging/auto-album';
import { withCategoryLock } from '@archive/staging/lock';
import { PROFILE_NAME } from '@archive/media/album-profile';
import { leaveGroups } from '@archive/staging/membership';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** What undoing one entry did: files back, groups given back their members, and the files (or batches) that stayed. */
export type UndoOutcome = { restored: number; groups: string[]; stayed: string[] };

/** Where each of `ids` is now, its first path; an id that resolves nowhere is absent. */
const whereNow = async (vfs: Vfs, access: Access, ids: string[]): Promise<Map<string, string>> => {
  const paths = ids.length > 0 ? await vfs.resolveIdPaths(access, [...new Set(ids)]) : new Map<string, string[]>();
  return new Map([...paths].flatMap(([id, at]) => at[0] ? [[id, at[0]] as [string, string]] : []));
};

/** A snapshot's attrs with its member key put right for `ids`, the members it now has: never a key that would pin it. */
const attrsFor = (attrs: Record<string, unknown>, ids: string[]): Record<string, unknown> => {
  const meta = attrs.autoAlbum as AutoAlbumMeta | undefined;
  if (!meta) return attrs;
  return { ...attrs, autoAlbum: { ...meta, ...(isMemberKey(meta.memberKey) ? { memberKey: memberKeyOf(ids) } : {}), memberCount: ids.length } };
};

/**
 * Give the groups of `snapshots` back the member links a decision took, for each file now at its
 * staged path again (`now`, by id). A group still there gets its links back, its member key
 * XOR-ed with theirs, its pin as it was and its cover back when it lost it; one deleted is made again
 * from its snapshot. Answers the groups given anything back.
 */
const restoreGroups = async (vfs: Vfs, access: Access, snapshots: GroupSnapshot[], now: Map<string, string>): Promise<string[]> => {
  const restored: string[] = [];
  for (const snapshot of snapshots) {
    const back = snapshot.links.filter((link) => now.get(link.id) === link.target);
    if (back.length === 0) continue;
    const cover = snapshot.cover !== undefined && back.some((link) => link.target === snapshot.cover) ? snapshot.cover : undefined;
    const existing = await vfs.get<{ autoAlbum?: AutoAlbumMeta }>(access, snapshot.path, { follow: false }).catch(() => undefined);

    if (!existing) {
      await vfs.createTree(access, dirname(snapshot.path), [{
        type: 'album',
        name: basename(snapshot.path),
        props: snapshot.props,
        attrs: attrsFor(snapshot.attrs, back.map((link) => link.id)),
        children: [
          ...back.map((link) => linkSpec(link.name, link.target, snapshot.props)),
          ...(cover !== undefined ? [linkSpec(COVER_LINK_NAME, cover, snapshot.props)] : []),
        ],
      }]);
      restored.push(snapshot.path);
      continue;
    }

    const children = await vfs.children(access, snapshot.path);
    const names = new Set(children.map((child) => child.name));
    const held = new Set(children.filter((child) => child.name !== COVER_LINK_NAME).map((child) => child.node.props.softlink));
    const joining = back.filter((link) => !held.has(link.target));
    const owner = { uid: existing.props.uid, gid: existing.props.gid };
    const specs = joining.map((link) => {
      const name = freeLinkName(link.name, names);
      names.add(name);
      return linkSpec(name, link.target, owner);
    });
    // The cover it lost was given to another member; it shows its own again.
    if (cover !== undefined) {
      if (names.has(COVER_LINK_NAME)) await vfs.unlink(access, `${snapshot.path}/${COVER_LINK_NAME}`, snapshot.path, { readlink: true });
      specs.push(linkSpec(COVER_LINK_NAME, cover, owner));
    }
    if (specs.length > 0) await vfs.createTree(access, snapshot.path, specs);

    const meta = existing.attrs.autoAlbum;
    const before = (snapshot.attrs.autoAlbum as AutoAlbumMeta | undefined)?.pinned;
    if (meta) {
      const memberKey = isMemberKey(meta.memberKey) ? toggleMembers(meta.memberKey, joining.map((link) => link.id)) : meta.memberKey;
      const autoAlbum: AutoAlbumMeta = { ...meta, memberKey, memberCount: (meta.memberCount ?? 0) + joining.length };
      if (before) autoAlbum.pinned = true;
      else delete autoAlbum.pinned;
      await vfs.update(access, snapshot.path, { attrs: { autoAlbum } });
    }
    restored.push(snapshot.path);
  }
  return restored;
};

/** Whether the album at `path` holds nothing but an empty `files/` and its cover link. */
const emptyAlbum = async (vfs: Vfs, access: Access, path: string): Promise<boolean> => {
  for (const child of await vfs.children(access, path)) {
    if (child.name === COVER_LINK_NAME || child.name === PROFILE_NAME) continue;
    if (child.name === 'files' && child.node.type === 'directory' && (await vfs.childCount(access, `${path}/files`, { all: true })) === 0) continue;
    return false;
  }
  return true;
};

/** Delete the album at `path`: its cover link as a link, its profile, its empty `files/`, then itself. */
const deleteEmptyAlbum = async (vfs: Vfs, access: Access, path: string): Promise<void> => {
  for (const child of await vfs.children(access, path)) {
    await vfs.unlink(access, `${path}/${child.name}`, path, { readlink: true });
  }
  await vfs.unlink(access, path, dirname(path), { follow: false });
};

/**
 * Undo a filing: each file still where it was filed moves back to its staged path, with the links
 * to it following, and gets its own sharing back. A group that became the album (`plan.group`)
 * moves back to where it was, as it was: its attrs and props, and its member links to the files
 * that came back. The other groups get their members back (`restoreGroups`). An album the decision
 * made (`created`) is deleted once nothing is left in it; the albums filed into have their spans
 * refreshed.
 */
export const undoFiled = async (cmd: Command, plan: Extract<StagingUndoPlan, { kind: 'filed' }>, created: string[], albums: string[]): Promise<UndoOutcome> => {
  const { vfs } = cmd.sys;
  const now = await whereNow(vfs, cmd.access, plan.moves.map((move) => move.id));
  const back = plan.moves.filter((move) => now.get(move.id) === move.to);
  const stayed = plan.moves.filter((move) => now.has(move.id) && now.get(move.id) !== move.to && now.get(move.id) !== move.from).map((move) => now.get(move.id)!);

  const settled = await vfs.renameMany(cmd.access, back.map((move) => ({ from: move.to, to: move.from })), { failIfExists: true });
  const moved = back.filter((_, i) => settled[i].status === 'fulfilled');
  stayed.push(...back.filter((_, i) => settled[i].status === 'rejected').map((move) => move.to));
  if (moved.length > 0) {
    await vfs.updateEach(cmd.access, moved.map((move) => ({ ref: move.from, props: { mode: move.mode, gid: move.gid, acl: move.acl ?? [] } })));
  }
  for (const move of moved) now.set(move.id, move.from);

  const groups: string[] = [];
  if (plan.group) {
    const { group } = plan;
    const at = (await whereNow(vfs, cmd.access, [group.id])).get(group.id);
    if (at) {
      const album = await vfs.get(cmd.access, at);
      if (!verifyAccess(cmd.access, album.props, 'w')) throw new Error(`cannot write to ${at}`);
      if (await vfs.exists(cmd.access, `${at}/files`) && (await vfs.childCount(cmd.access, `${at}/files`, { all: true })) === 0) {
        await vfs.unlink(cmd.access, `${at}/files`, at);
      }
      // Its profile is a library album's; as a group again it has none.
      if (await vfs.exists(cmd.access, `${at}/${PROFILE_NAME}`, { follow: false })) await vfs.unlink(cmd.access, `${at}/${PROFILE_NAME}`, at);
      await vfs.rename(cmd.access, dirname(at), basename(at), dirname(group.from), basename(group.from), { failIfExists: true });
      const links = group.links.filter((link) => now.get(link.id) === link.target);
      const cleared = Object.fromEntries(Object.keys(album.attrs).filter((key) => !(key in group.attrs)).map((key) => [key, null]));
      // The album was given to the library's default owner when it was promoted, which its staging
      // owner may not take back alone; the node is one the caller may write, and goes back to them.
      await vfs.update({ ...cmd.access, admin: true }, group.from, {
        props: group.props,
        attrs: { ...cleared, ...attrsFor(group.attrs, links.map((link) => link.id)) },
      });
      const names = new Set((await vfs.children(cmd.access, group.from)).map((child) => child.name));
      const specs = links.map((link) => {
        const name = freeLinkName(link.name, names);
        names.add(name);
        return linkSpec(name, link.target, group.props);
      });
      if (specs.length > 0) await vfs.createTree(cmd.access, group.from, specs);
      groups.push(group.from);
    }
  }
  groups.push(...await restoreGroups(vfs, cmd.access, plan.groups, now));

  const albumPaths = await whereNow(vfs, cmd.access, albums);
  for (const id of created) {
    const path = albumPaths.get(id);
    if (path && id !== plan.group?.id && await emptyAlbum(vfs, cmd.access, path)) {
      await deleteEmptyAlbum(vfs, cmd.access, path);
      albumPaths.delete(id);
    }
  }
  for (const [id, path] of albumPaths) if (id !== plan.group?.id) await cmd.execute(`album-span ${shq(path)}`);

  return { restored: moved.length, groups, stayed };
};

/**
 * Undo a discard: each of its trash batches still in the trash it went into (`plan.home`) is
 * restored whole, the files that came back have their duplicate findings decided again at once
 * (`recordPaths`), and the groups they left get them back. A batch no longer there — emptied, or
 * restored from the Trash page — is reported.
 */
export const undoTrashed = async (cmd: Command, plan: Extract<StagingUndoPlan, { kind: 'trashed' }>, batches: string[]): Promise<UndoOutcome> => {
  const stayed: string[] = [];
  const back: string[] = [];
  for (const batch of batches) {
    const result = await cmd.execute(`HOME=${shq(plan.home)} JSON_OUTPUT=1 trash restore ${shq(batch)}`);
    if (result.code !== 0) {
      stayed.push(`trash batch ${batch}: ${result.stderr.trim().replace(/^trash: /, '') || 'not restored'}`);
      continue;
    }
    back.push(...(JSON.parse(result.stdout) as TrashRestoreResult).restored.map((entry) => entry.path));
  }
  if (back.length > 0) await recordPaths(cmd, back);
  const now = await whereNow(cmd.sys.vfs, cmd.access, plan.groups.flatMap((group) => group.links.map((link) => link.id)));
  const groups = await restoreGroups(cmd.sys.vfs, cmd.access, plan.groups, now);
  return { restored: back.length, groups, stayed };
};

/**
 * Undo a grouping edit, holding the category's lock: every member the changed groups had that is
 * still where it was, and is not in its own group now, leaves whatever group holds it (one the
 * edit made is then empty, and goes), and each group gets back its own (`restoreGroups`), one the
 * edit deleted made again. Each group then has its name, pin and name lock as they were.
 */
export const undoGroups = (cmd: Command, plan: Extract<StagingUndoPlan, { kind: 'groups' }>): Promise<UndoOutcome> =>
  withCategoryLock(plan.albums, async () => {
    const { vfs } = cmd.sys;
    const now = await whereNow(vfs, cmd.access, plan.groups.flatMap((group) => group.links.map((link) => link.id)));
    const listings = await vfs.childrenMany(cmd.access, plan.groups.map((group) => group.path), { follow: false });
    const home = new Set(plan.groups.flatMap((group, i) => {
      const listing = listings[i];
      const held = new Set(listing.status === 'fulfilled' ? listing.value.filter((child) => child.name !== COVER_LINK_NAME).map((child) => child.node.props.softlink) : []);
      return group.links.filter((link) => held.has(link.target)).map((link) => link.target);
    }));
    const back = [...new Set(plan.groups.flatMap((group) => group.links.filter((link) => now.get(link.id) === link.target).map((link) => link.target)))];
    const leaving = back.filter((target) => !home.has(target));
    if (leaving.length > 0) await leaveGroups(vfs, cmd.access, leaving, plan.albums);
    const groups = await restoreGroups(vfs, cmd.access, plan.groups, now);
    for (const snapshot of plan.groups) {
      const node = await vfs.get<{ name?: string; autoAlbum?: AutoAlbumMeta }>(cmd.access, snapshot.path, { follow: false }).catch(() => undefined);
      const was = snapshot.attrs.autoAlbum as AutoAlbumMeta | undefined;
      if (!node?.attrs.autoAlbum || !was) continue;
      const autoAlbum: AutoAlbumMeta = { ...node.attrs.autoAlbum };
      for (const field of ['pinned', 'nameLocked', 'generatedName'] as const) {
        if (was[field] === undefined) delete autoAlbum[field];
        else (autoAlbum as Record<string, unknown>)[field] = was[field];
      }
      await vfs.update(cmd.access, snapshot.path, { attrs: { name: snapshot.attrs.name ?? null, autoAlbum } });
      if (!groups.includes(snapshot.path)) groups.push(snapshot.path);
    }
    return { restored: back.length, groups, stayed: [] };
  });
