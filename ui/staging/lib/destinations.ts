/**
 * Where pictures are filed: a proposal in the words of its button, and the albums moved into lately
 * (the album page's Move to album), the viewer's own convenience, kept in the browser as JSON;
 * anything unreadable there is as if nothing was kept. Pure, so it is tested without a page.
 */
import type { Proposal } from '@archive/staging/proposal';

/** An album as the page files into it: its path, and what it is called. */
export type AlbumTarget = { path: string; title: string };

/** Albums moved into lately that the picker offers. */
export const RECENT_MAX = 8;

const isTarget = (value: unknown): value is AlbumTarget =>
  value !== null && typeof value === 'object' && typeof (value as AlbumTarget).path === 'string' && typeof (value as AlbumTarget).title === 'string';

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

/** What Enter does with a proposal, in the words of its button; none without one. */
export function proposalLabel(proposal: Proposal): string | undefined {
  if (proposal.action === 'existing') return `Add to “${proposal.album.title}”`;
  if (proposal.action === 'new') return `Create album “${proposal.title}”`;
  if (proposal.action === 'parts') return `File ${proposal.parts} matched ${proposal.parts === 1 ? 'day' : 'days'} · ${proposal.files.toLocaleString('en')} photos`;
  if (proposal.action === 'dedupe') return `Keep the library copies · ${proposal.files.toLocaleString('en')} ${proposal.files === 1 ? 'photo' : 'photos'} go`;
  if (proposal.action === 'discard') return 'Discard';
  return undefined;
}

/** How sure a proposal is, as the page says it. */
export const CONFIDENCE_WORDS = { high: 'sure', medium: 'likely', low: 'unsure' } as const;
