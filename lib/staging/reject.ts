/**
 * "Not this album" (`staging reject <group> <album>`): a person says a suggested group does not go
 * into a library album. The rejection is a journal entry (`attrs.stagingReject`) naming the album
 * and the group's members by node id, so it holds for any group of the category made mostly of
 * them — the group as the organizer rebuilds it, or a piece split off it — whenever it is matched,
 * until the entry is undone. The group's stored matches lose the album at once (`withoutAlbum`);
 * the entry keeps them as they were, which undoing gives back.
 */
import type { StagingEditResult, StagingMatches } from '@archive/staging/api';
import type { Command } from '@ein/client';
import { basename } from '@std/path';
import { AUTO_ORIGIN, type AutoAlbumMeta, COVER_LINK_NAME } from '@archive/staging/auto-album';
import { createJournalEntry, finishJournalEntry } from '@archive/staging/journal';
import { MATCHES_ATTR, withoutAlbum } from '@archive/staging/match';
import { idsAt } from '@archive/staging/nodes-at';
import { isStagingGroup, parseStagedPath } from '@archive/staging/paths';
import { currentMatches } from '@archive/staging/rows';

/** Reject the library album at `albumPath` for the suggested group at `groupPath`. */
export const rejectAlbum = async (cmd: Command, groupPath: string, albumPath: string): Promise<StagingEditResult> => {
  const { vfs } = cmd.sys;
  const parsed = isStagingGroup(groupPath) ? parseStagedPath(groupPath) : undefined;
  if (!parsed?.category) throw new Error(`not a suggested group: ${groupPath}`);
  const group = await vfs.get<{ origin?: string; name?: string; autoAlbum?: AutoAlbumMeta; stagingMatches?: StagingMatches }>(cmd.access, groupPath);
  if (group.type !== 'album' || group.attrs.origin !== AUTO_ORIGIN) throw new Error(`not a suggested group: ${groupPath}`);
  if (parseStagedPath(albumPath) !== undefined) throw new Error(`${albumPath} is in staging, not in the library`);
  const album = await vfs.get<{ name?: string }>(cmd.access, albumPath);
  if (album.type !== 'album') throw new Error(`${albumPath}: not an album (is ${album.type})`);

  const targets = (await vfs.children(cmd.access, groupPath))
    .flatMap((child) => child.name !== COVER_LINK_NAME && typeof child.node.props.softlink === 'string' ? [child.node.props.softlink] : []);
  const members = [...new Set((await idsAt(vfs, cmd.access, targets)).values())];
  const name = typeof group.attrs.name === 'string' && group.attrs.name ? group.attrs.name : basename(groupPath);
  const title = typeof album.attrs.name === 'string' && album.attrs.name ? album.attrs.name : basename(albumPath);
  const entry = await createJournalEntry(
    vfs,
    cmd.access,
    parsed.user,
    {
      category: parsed.category,
      action: 'reject',
      files: 0,
      summary: `“${name}” is not for ${title}`,
      albums: [album.id],
      groups: [{ slug: basename(groupPath), name }],
    },
    { kind: 'matches', groups: [{ id: group.id, matches: group.attrs.stagingMatches ?? null }] },
    { reject: { category: parsed.category, members, album: album.id } },
  );
  let state: 'done' | 'partial' = 'partial';
  try {
    const matches = currentMatches(group.attrs);
    if (matches) await vfs.update(cmd.access, groupPath, { attrs: { [MATCHES_ATTR]: withoutAlbum(matches, album.id) } });
    state = 'done';
  } finally {
    await finishJournalEntry(vfs, cmd.access, entry, { state });
  }
  return { ok: true, journal: entry.id, groupsCreated: [], groupsChanged: [groupPath], groupsRemoved: [], changed: [] };
};
