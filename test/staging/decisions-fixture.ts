/**
 * What the decision tests share: an inbox of invented photos in suggested groups as the organizer
 * makes them (keyed by member ids, owned by the inbox owner, 0700), and a listing of a directory
 * that leaves out only what a move or a restore changes by itself (times, an empty access list).
 */
import { COVER_LINK_NAME, groupSpec, memberKeyOf, memberLinkSpecs } from '@archive/staging/auto-album';
import { basename, dirname } from '@std/path';
import type { NodeVFS } from '@ein/testing';
import { ADMIN_ACCESS } from '@ein/testing';

/** One child as `ls -l` shows it, minus its times: what an undo must give back as it was. */
export type Listed = { name: string; id: string; type: string; uid: number; gid: number; mode: number; acl: unknown[]; softlink?: string; attrs: Record<string, unknown> };

/** The children of `path`, by name, as `Listed`; none when it is not there. */
export const listing = async (vfs: NodeVFS, path: string): Promise<Listed[]> => {
  if (!(await vfs.exists(ADMIN_ACCESS, path))) return [];
  const children = await vfs.children(ADMIN_ACCESS, path);
  return children.map((child) => ({
    name: child.name,
    id: child.node.id,
    type: child.node.type,
    uid: child.node.props.uid,
    gid: child.node.props.gid,
    mode: child.node.props.mode,
    acl: child.node.props.acl ?? [],
    ...(child.node.props.softlink ? { softlink: child.node.props.softlink } : {}),
    attrs: child.node.attrs,
  })).sort((a, b) => a.name.localeCompare(b.name));
};

/** `count` invented photos `<prefix>-<n>.jpg` in `dir`, taken a minute apart from `day`. */
export const stagePhotos = async (vfs: NodeVFS, dir: string, prefix: string, count: number, owner: { uid: number; gid: number }, day = '2019-06-14'): Promise<string[]> => {
  await vfs.createTree(
    ADMIN_ACCESS,
    dir,
    Array.from({ length: count }, (_, i) => ({
      type: 'file',
      name: `${prefix}-${i}.jpg`,
      props: { uid: owner.uid, gid: owner.gid, mode: 0o640 },
      attrs: { mimetype: 'image/jpeg', takenAt: `${day}T10:${String(i).padStart(2, '0')}:00`, takenAtUtc: `${day}T08:${String(i).padStart(2, '0')}:00Z` },
    })),
  );
  return Array.from({ length: count }, (_, i) => `${dir}/${prefix}-${i}.jpg`);
};

/**
 * A suggested group at `path` of `members`, as the organizer writes one, named `name`; one there
 * already gets the members it lacks and the key of them all.
 */
export const makeGroup = async (vfs: NodeVFS, path: string, name: string, members: string[], owner: { uid: number; gid: number }): Promise<void> => {
  const nodes = await Promise.all(members.map((member) => vfs.get(ADMIN_ACCESS, member)));
  const autoAlbum = {
    timeStart: '2019-06-14T08:00:00Z',
    timeEnd: '2019-06-14T09:00:00Z',
    memberKey: memberKeyOf(nodes.map((node) => node.id)),
    memberCount: members.length,
    generatedName: name,
    generatedAt: '2019-06-15T00:00:00Z',
    generatedBy: 'test',
  };
  if (!(await vfs.exists(ADMIN_ACCESS, path))) {
    await vfs.createTree(ADMIN_ACCESS, dirname(path), [groupSpec(basename(path), { name, autoAlbum }, members, owner, members[0])]);
    return;
  }
  const children = await vfs.children(ADMIN_ACCESS, path);
  const held = new Set(children.map((child) => child.node.props.softlink));
  const names = new Set([COVER_LINK_NAME, ...children.map((child) => child.name)]);
  const adding = members.filter((member) => !held.has(member));
  if (adding.length > 0) await vfs.createTree(ADMIN_ACCESS, path, memberLinkSpecs(adding, names, owner));
  await vfs.update(ADMIN_ACCESS, path, { attrs: { name, autoAlbum } });
};

/** The member softlink targets of a suggested group, the cover link left out. */
export const readMembers = async (vfs: NodeVFS, albumPath: string): Promise<string[]> =>
  (await vfs.children(ADMIN_ACCESS, albumPath)).filter((child) => child.name !== COVER_LINK_NAME && child.node.props.softlink).map((child) =>
    child.node.props.softlink as string
  );
