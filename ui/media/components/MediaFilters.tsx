import { useSignals } from '@preact/signals-react/runtime';
import { HeaderChoice, TablerIcon } from '@ein/ui/components';
import { MEDIA_KIND_FILTERS, type SearchKind } from '@ein/ui/lib';
import { useEffect, useMemo } from 'react';
import { mediaTypeFilter } from '../signals/album.ts';

type MediaFiltersProps = {
  /**
   * The kinds the container actually holds, from `search --facets`. Undefined
   * while they are still being counted, which is not the same as an empty set —
   * the control keeps its current shape rather than collapsing and reappearing.
   */
  available?: readonly SearchKind[];
};

/** The icon for a media kind filter, as its collapsed control shows it on a phone. */
export function mediaKindIcon(value: string, size = 18) {
  return <TablerIcon name={MEDIA_KIND_ICONS[value] ?? 'adjustments'} size={size} />;
}

const MEDIA_KIND_ICONS: Record<string, string> = { photo: 'photo', video: 'video', audio: 'music', document: 'file-text' };

/**
 * The media type filter for one container.
 *
 * Only offers what is in there. A control listing Video and Audio over an album
 * of scanned photographs is three ways to ask a question with one answer.
 *
 * With one kind present there is nothing to choose, so the control renders
 * nothing at all rather than a lone pair of chips that cannot change the grid.
 */
export function MediaFilters({ available }: MediaFiltersProps) {
  useSignals();

  const options = useMemo(() => {
    if (!available) return MEDIA_KIND_FILTERS;
    const present = new Set(available);
    // `all` has every file kind on it, so it is kept by name rather than by the
    // subset test — it is the way out of a filter, not a kind of its own.
    return MEDIA_KIND_FILTERS.filter((entry) => entry.value === 'all' || entry.kinds.every((kind) => present.has(kind)));
  }, [available]);

  // A container the current selection cannot answer would otherwise show an
  // empty grid with no visible control to clear — the signal is global, so it
  // survives navigating from an album with video to one without.
  useEffect(() => {
    if (!options.some((entry) => entry.value === mediaTypeFilter.value)) mediaTypeFilter.value = 'all';
  }, [options]);

  // One kind means one answer: "All" and "Images" over an album of photographs
  // are the same button twice. `all` is not counted — it is the way out of a
  // filter, not something to filter to.
  if (options.filter((entry) => entry.value !== 'all').length < 2) return null;

  return (
    <HeaderChoice
      label='Show'
      variant='segmented'
      value={mediaTypeFilter.value}
      onChange={(value) => {
        mediaTypeFilter.value = value;
      }}
      options={options.map((entry) => ({ value: entry.value, label: entry.label, icon: mediaKindIcon(entry.value) }))}
    />
  );
}
