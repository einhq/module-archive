import { Box } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MediaLightbox } from '../components/MediaLightbox.tsx';
import { useMediaTimeline } from '../../hooks/useMediaTimeline.ts';
import { SLIDESHOW_ORDER_PARAM } from '../lib/slideshow-search.ts';
import { FILE_KINDS, hasAnyFilter } from '@ein/ui/hooks';
import { filtersFromParams } from '@ein/ui/lib';
import { endLightbox, isLightboxOpen, offerLightboxList, showLightboxPath } from '@ein/ui/signals';

export const handle = { fullBleed: true };

/**
 * The lightbox's slideshow alone, over the window and nothing else: what a screen is given
 * (`screenSlideshow`), so it shows the first slide and no list page before it. Its parameters say
 * what it shows, as a search's do (`under` an album, the words, the pills, `kind`), and `order`
 * whether oldest first; `?slideshow=screen` runs it as for a screen nobody touches. Black until the
 * first file is there. A search asks for files alone, as the media page's does: left to fan out,
 * it also finds albums, people and places, which are no slide.
 */
export default function SlideshowPage() {
  useSignals();
  // Read once: the slideshow takes its own parameter out of the address as it starts.
  const search = useLocation().search;
  const [params] = useState(() => new URLSearchParams(search));
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const { under, kinds, ...narrowing } = filters;
  const searched = hasAnyFilter(narrowing);
  const { items } = useMediaTimeline({
    under,
    kinds: kinds ?? (searched ? [...FILE_KINDS] : undefined),
    filters: searched ? narrowing : undefined,
    rankByRelevance: Boolean(filters.query?.trim()),
    browseAll: under === undefined && kinds === undefined && !searched,
    ascending: params.get(SLIDESHOW_ORDER_PARAM) === 'oldest',
    granularity: 'none',
  });

  // The list is the lightbox's from its first file on; as more pages come it walks them too.
  const first = items[0]?.path;
  useLayoutEffect(() => {
    offerLightboxList(items);
    if (first && !isLightboxOpen.peek()) showLightboxPath(first);
  }, [items, first]);
  useLayoutEffect(() => () => offerLightboxList([]), []);
  useEffect(() => () => endLightbox(false), []);

  return (
    <Box pos='fixed' bg='black' style={{ inset: 0, zIndex: 'calc(var(--mantine-z-index-modal) - 2)' }}>
      {isLightboxOpen.value && <MediaLightbox />}
    </Box>
  );
}
