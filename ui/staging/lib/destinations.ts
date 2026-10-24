/**
 * Where the Sort tab files a group, besides its proposal: the sticky target B files into, and the
 * albums filed into lately. Both are the viewer's own conveniences, kept in the browser as JSON;
 * anything unreadable there is as if nothing was kept. Pure, so it is tested without a page.
 */
import type { StagingAlbumRef } from '@archive/staging/api';
import type { Proposal } from '@archive/staging/proposal';

/** An album as the page files into it: its path, and what it is called. */
export type AlbumTarget = { path: string; title: string };

/** Albums filed into lately that the column and the picker offer. */
export const RECENT_MAX = 8;

const isTarget = (value: unknown): value is AlbumTarget =>
  value !== null && typeof value === 'object' && typeof (value as AlbumTarget).path === 'string' && typeof (value as AlbumTarget).title === 'string';

/** A kept album, or none. */
export function parseTarget(stored: string): AlbumTarget | null {
  try {
    const value = JSON.parse(stored);
    return isTarget(value) ? { path: value.path, title: value.title } : null;
  } catch {
    return null;
  }
}

/** The kept recent albums, newest first. */
export function parseRecent(stored: string): AlbumTarget[] {
  try {
    const value = JSON.parse(stored);
    return Array.isArray(value) ? value.filter(isTarget).slice(0, RECENT_MAX).map(({ path, title }) => ({ path, title })) : [];
  } catch {
    return [];
  }
}

/** `recent` with `album` first, once, and at most `RECENT_MAX` long. */
export const withRecent = (recent: readonly AlbumTarget[], album: AlbumTarget): AlbumTarget[] =>
  [album, ...recent.filter((each) => each.path !== album.path)].slice(0, RECENT_MAX);

/**
 * The target B files into: the one chosen for the category with ⇧B, else the category's
 * destination when the reader may file into it, else the album filed into last.
 */
export function stickyTarget(chosen: AlbumTarget | null, destination: StagingAlbumRef | null, recent: readonly AlbumTarget[]): AlbumTarget | null {
  if (chosen) return chosen;
  if (destination?.writable) return { path: destination.path, title: destination.title };
  return recent[0] ?? null;
}

/** What Enter does with a proposal, in the words of its button; none without one. */
export function proposalLabel(proposal: Proposal): string | undefined {
  if (proposal.action === 'existing') return `Add to “${proposal.album.title}”`;
  if (proposal.action === 'new') return `New album “${proposal.title}”`;
  if (proposal.action === 'parts') return `File ${proposal.parts} matched ${proposal.parts === 1 ? 'day' : 'days'} · ${proposal.files.toLocaleString('en')} photos`;
  if (proposal.action === 'dedupe') return `Keep the library copies · ${proposal.files.toLocaleString('en')} ${proposal.files === 1 ? 'photo' : 'photos'} go`;
  if (proposal.action === 'discard') return 'Discard';
  return undefined;
}

/** How sure a proposal is, as the page says it. */
export const CONFIDENCE_WORDS = { high: 'sure', medium: 'likely', low: 'unsure' } as const;
