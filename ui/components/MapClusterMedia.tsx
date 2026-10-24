import { MediaTimeline } from './MediaTimeline.tsx';
import { Dialog, GeoBounds } from '@ein/ui/components';
import { Box, Loader } from '@mantine/core';
import { type CSSProperties, useMemo, useState } from 'react';
import type { MapCluster, YearRange } from '../hooks/useMapMedia.ts';
import { FILE_KINDS, type SearchFilters } from '@ein/ui/lib';
import { subjectsOf } from '../lib/subjects.ts';
import { type MapFilters } from '../lib/map-params.ts';

type MapClusterMediaProps = {
  /** The open cluster and the cell it stands for; null when nothing is open. `view` when it is the whole viewport. */
  open: { cluster: MapCluster; bounds: GeoBounds; view?: boolean } | null;
  /** The map's year slider, which the cell inherits. */
  years?: YearRange;
  /** The map filter that produced this cluster and its count. */
  filters?: MapFilters;
  onClose: () => void;
};

/**
 * What is behind a cluster's number: the same `MediaTimeline` an album, a
 * person or a location shows, asked of the cell as a search region.
 *
 * One component rather than a copy, so the cell gets the album's date dividers,
 * floating date, selection and rail as they are now and as they change. The
 * map's filters and year slider carry into the search, so the dialog holds what
 * the number counted.
 *
 * The list scrolls in its own column rather than in the dialog: the rail
 * stands inline beside it, and it has to hang from something that does not
 * scroll.
 */
export function MapClusterMedia({ open, years = {}, filters, onClose }: MapClusterMediaProps) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);

  const bounds = open?.bounds;
  const searchFilters = useMemo((): SearchFilters | undefined =>
    bounds && {
      region: { shape: 'bbox', ...bounds },
      fromYear: years.fromYear,
      toYear: years.toYear,
      query: filters?.query,
      subjects: subjectsOf(filters),
      tags: filters?.tag ? [filters.tag] : undefined,
      under: filters?.under,
    }, [bounds, years.fromYear, years.toYear, filters?.query, filters?.person, filters?.location, filters?.tag, filters?.under]);

  return (
    <Dialog
      opened={open !== null}
      onClose={onClose}
      size='screen'
      // This page has no document scroll to lock: the map owns a fixed-height
      // viewport and the dialog scrolls internally. Locking the body changes
      // its width, which makes Leaflet emit moveend and repeat the map search on
      // both open and close.
      lockScroll={false}
      // The count is the server's; the pictures arrive a moment later.
      title={`${open?.cluster.count ?? 0} photos ${open?.view ? 'in this view' : 'here'}`}
      subtitle={open && !open.view ? `${open.cluster.lat.toFixed(5)}, ${open.cluster.lng.toFixed(5)}` : undefined}
      aside={loading && <Loader size='xs' color='white' />}
      icon='map-pin'
      pattern='location'
      bleed
    >
      {
        /* A frame the height the header leaves, out of the flow so the list's
          length does not stretch the dialog: positioned, and not the column,
          because the rail is absolute, and a containing block outside the
          scroller is what keeps it still while the list moves. */
      }
      <Box style={{ flex: 1, position: 'relative' }}>
        <Box style={{ position: 'absolute', inset: 0, display: 'flex' }}>
          {
            /* No scrollbar: the rail is the better one, and two bars 15px apart — one
              of them inert to a drag — read as a mistake. The column carries its own
              padding, because the padding has to scroll with it; the body-padding
              variable is what the grid's `bleed` cancels on a phone. */
          }
          <Box
            ref={setScrollEl}
            p='md'
            className='mrx-no-scrollbar'
            style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowAnchor: 'none', '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}
          >
            {
              /* Months, not the album's days: a cell is a location rather than an
                afternoon, so it is headed the way a location's own page is. */
            }
            {scrollEl && searchFilters && (
              <MediaTimeline
                key={open?.cluster.key}
                filters={searchFilters}
                kinds={[...FILE_KINDS]}
                granularity='month'
                scrollRoot={scrollEl}
                onLoadingChange={setLoading}
                emptyMessage='Nothing here in this range.'
              />
            )}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}
