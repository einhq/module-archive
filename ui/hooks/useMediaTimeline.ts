import { useCallback, useEffect, useMemo } from 'react';
import { albumMediaList, currentMediaIndex, MediaItem, openMediaAt } from '@ein/ui/signals';
import { ScrollRoot, type SearchOutcome, searchResultToMediaItem, useLoadMoreSentinel, useSearch } from '@ein/ui/hooks';
import { bucketByDate, type DateBucket, SearchFilters, SearchKind } from '@ein/ui/lib';
import { mediaTimelineSearchRequest } from '../lib/media-timeline-request.ts';

type MediaTimelineGroup = DateBucket<MediaItem>;

/**
 * One MediaGrid (and therefore one ResizeObserver and scroll measurement) is
 * mounted per date bucket. Keep a decades-long album from turning item
 * windowing into thousands of tiny grid shells; dense ordinary albums retain
 * their useful day headings.
 */
const MAX_ALBUM_DATE_GROUPS = 240;

/**
 * How wide a bucket is. A subject spans decades, so months keep its headers
 * readable; an album is usually an afternoon, where a month header says nothing
 * and a day header is the actual structure of the thing.
 */
export type TimelineGranularity = 'day' | 'month' | 'none';

type UseMediaTimelineOptions = {
  /** Person slug or path. Mutually exclusive with `location` in practice. */
  person?: string;
  location?: string;
  /** Album (or directory) path — its own media, softlink members followed. */
  under?: string;
  /** Directory path — every file in the tree under it, however deep, its own links not followed. */
  within?: string;
  /** Device path (`/devices/<name>`) — the media that camera produced. */
  device?: string;
  /** Restrict to these content kinds, e.g. the media-type filter. */
  kinds?: SearchKind[];
  /**
   * Anything else the `search` command takes — free text, labels, a region, a
   * year window.
   *
   * Merged with the named fields above, the named ones winning, so a caller can
   * use either or both.
   */
  filters?: SearchFilters;
  /** Keep search hits in best-match order instead of arranging them by time. */
  rankByRelevance?: boolean;
  /** Oldest first. Defaults to newest first. */
  ascending?: boolean;
  /** Bucket width for the group headers. Defaults to `month`. */
  granularity?: TimelineGranularity;
  pageSize?: number;
  /** Start the list at this `YYYY[-MM[-DD]]` — where the time rail was dragged. */
  anchor?: string | null;
  /**
   * Run even with no filter at all.
   *
   * Every other list is *of* something, and an empty filter set there means
   * "nothing asked yet" — so the search stays off. The media feed is the one
   * list that is meant to be everything: `search --sort -time` on its own is
   * the server's plain newest-first browse, with store-counted facets, and
   * spelling "everything" as every file kind would post-filter instead and cap
   * the rail at the scan limit.
   */
  browseAll?: boolean;
  /**
   * The element the list scrolls in, when that is not the window — a dialog's
   * own column. Paging measures against it, or a sentinel clipped by the
   * column would never come within reach of the viewport's margin.
   */
  scrollRoot?: ScrollRoot;
};

type UseMediaTimelineResult = {
  items: MediaItem[];
  groups: MediaTimelineGroup[];
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Attach to a sentinel element after the last row to page on scroll. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** Opens the lightbox on `index`, bound to the whole loaded list. */
  openAt: (index: number) => void;
  /** Drop items by path without resetting paging — for media that was deleted. */
  removeItems: (paths: string[]) => void;
  /** Re-run from the first page. For changes that reorder, which pruning cannot express. */
  reload: () => void;
  /** True while the anchor has left media out of reach above the top of the list. */
  hasNewer: boolean;
  /** Index of the first item at the anchor, after the lead sent above it. 0 without a seek. */
  anchorIndex: number;
  /** The anchor the loaded items answer, or null for the top; see `UseSearchResult`. */
  answeredAnchor: string | null;
  /** Attach to a sentinel above the first bucket to page upward on scroll. */
  topSentinelRef: (node: HTMLElement | null) => void;
  /** How the first page was answered; see `UseSearchResult`. */
  outcome: SearchOutcome | null;
};

/**
 * A subject's, an album's or a directory tree's media as a windowed timeline.
 *
 * Wraps the `search` command's subject facets (`--person` / `--location`), its
 * container facet (`--under`) and its subtree facet (`--within`), all of which
 * return results already ordered by time. Materialized sources and a subtree small
 * enough use one compact complete layout; the rest page as the sentinel scrolls
 * into view. Items are grouped into headers by
 * `granularity`, with undated media collected at the end.
 */
export function useMediaTimeline(opts: UseMediaTimelineOptions): UseMediaTimelineResult {
  const { person, location, under, within, granularity = 'month', pageSize = 60, browseAll = false, scrollRoot = null } = opts;
  const { filters: merged, anchor } = mediaTimelineSearchRequest(opts);

  const { results, loading, error, hasMore, loadMore, removeResults, reload, hasNewer, anchorIndex, answeredAnchor, topSentinelRef, seams, outcome } = useSearch({
    ...merged,
    limit: pageSize,
    browseAll,
    anchor,
    scrollRoot,
    // Containers, people and locations already materialize their complete ordered
    // sets on the server, and a subtree is laid out whole while it is small enough.
    // One compact index gives their grids exact geometry; a subtree too large for one,
    // devices and general search page by cursor.
    layout: under !== undefined || within !== undefined || person !== undefined || location !== undefined,
  });

  const items = useMemo(() => results.map(searchResultToMediaItem), [results]);

  // Seams matter as much as dates here: a page that arrives above the list must
  // not be packed into the bucket it joins, or every row after it moves.
  const groups = useMemo(() => {
    const options = { startsSegment: (item: MediaItem) => seams.has(item.path) };
    const requested = bucketByDate(items, (item) => item.takenAt, granularity, options);
    if ((under === undefined && within === undefined) || granularity !== 'day' || requested.length <= MAX_ALBUM_DATE_GROUPS) return requested;

    const months = bucketByDate(items, (item) => item.takenAt, 'month', options);
    return months.length <= MAX_ALBUM_DATE_GROUPS ? months : bucketByDate(items, (item) => item.takenAt, 'year', options);
  }, [items, granularity, seams, under, within]);

  // Keep the lightbox's list in step with what has been loaded, so arrowing
  // past the end of the first page keeps working once more arrives.
  useEffect(() => {
    if (currentMediaIndex.value < 0) return;
    const open = albumMediaList.value;
    if (open.length === 0 || items.length <= open.length) return;
    if (open[0]?.id !== items[0]?.id) return; // a different list is open
    albumMediaList.value = items;
  }, [items]);

  const openAt = useCallback((index: number) => openMediaAt(index, items), [items]);

  const sentinelRef = useLoadMoreSentinel(hasMore && !error, loading, loadMore, scrollRoot);

  return {
    items,
    groups,
    loading,
    error,
    hasMore,
    loadMore,
    sentinelRef,
    openAt,
    removeItems: removeResults,
    reload,
    hasNewer,
    anchorIndex,
    answeredAnchor,
    topSentinelRef,
    outcome,
  };
}
