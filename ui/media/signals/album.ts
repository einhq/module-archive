import { signal } from '@preact/signals-react';

/**
 * Media type filter state — the `value` of one `MEDIA_KIND_FILTERS` entry, as a plain string so
 * that signals do not import the filter vocabulary. `MediaFilters` writes it, and resets a value
 * the container cannot answer to `all`.
 */
export const mediaTypeFilter = signal<string>('all');

/**
 * Set when files left where they were listed — a staged file put in an album moves there
 * (`album add`), a staged duplicate goes to the trash (`staging dedupe`) — naming the paths they
 * left. A list showing them drops them.
 */
export const mediaMoved = signal<{ paths: string[]; at: number } | null>(null);

type AlbumMediaRefreshRequest = { id: number; albumPath: string; focusPath: string };
export const albumMediaRefreshRequest = signal<AlbumMediaRefreshRequest | null>(null);
let albumMediaRefreshId = 0;

/** Ask the timeline that owns an album lightbox to reload and retain its focus. */
export const requestAlbumMediaRefresh = (albumPath: string, focusPath: string) => {
  albumMediaRefreshRequest.value = { id: ++albumMediaRefreshId, albumPath, focusPath };
};
