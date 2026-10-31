import { AlbumCard, albumCardText } from '../components/AlbumCard.tsx';
import { CardGrid, EmptyState, EntityDetailHeader, HeaderChoice, HeaderFilterBar, HeaderStats, ListFilterInput, PageLoader, TablerIcon } from '@ein/ui/components';
import { isAuthenticated, openDialog } from '@ein/ui/signals';
import { Box, Button, Center, Stack, Text } from '@mantine/core';
import { usePersistedState, useUrlParam } from '@ein/ui/hooks';
import { useAlbums } from '../hooks/useAlbums.ts';
import { countOf, matchesText } from '@ein/ui/lib';
import { compareByDate, facetsFromItems, indexAtDate, sectionsForItems } from '../lib/album-facets.ts';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TimelineScrubber } from '../../components/TimelineScrubber.tsx';
import { buildScrubberModel, offsetAtPosition, scrollAnchorsForSections, scrollAnchorsWithBounds, type ScrubberSelection } from '../../lib/timeline-scrubber.ts';
import { albumRoute } from '../lib/album-path.ts';

/** Desktop symmetry around the rail. */
const RAIL_GUTTER = 16;

type AlbumSort = 'newest' | 'oldest' | 'name' | 'size';

export const handle = { fullBleed: true };

export default function AlbumsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useUrlParam('q');
  // Persisted: these belong to the reader, not to one visit.
  const [sortBy, setSortBy] = usePersistedState<AlbumSort>('albums.list.sort', 'newest');

  const { albums, loading, error } = useAlbums();

  const filteredAlbums = useMemo(() => {
    // Matching on the title, not the slug: "Sommar i Exempelstad" is what is on the card.
    const filtered = albums.filter((album) => matchesText([album.title], search));

    switch (sortBy) {
      case 'name':
        return filtered.toSorted((a, b) => a.title.localeCompare(b.title));
      case 'size':
        return filtered.toSorted((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0));
      case 'oldest':
        return filtered.toSorted(compareByDate);
      default:
        return filtered.toSorted((a, b) => compareByDate(b, a));
    }
  }, [albums, search, sortBy]);

  // The rail is a map of occupied time, so it only means anything while the grid
  // is in date order. Sorted by name or by size, a position on it points nowhere.
  const dated = sortBy === 'newest' || sortBy === 'oldest';

  // Every album is already loaded, so the facets are counted rather than fetched
  // and a seek is a scroll rather than a refetch.
  const facets = useMemo(() => (dated ? facetsFromItems(filteredAlbums) : null), [dated, filteredAlbums]);
  const model = useMemo(() => (facets ? buildScrubberModel(facets, sortBy === 'oldest') : null), [facets, sortBy]);

  const [geometry, setGeometry] = useState<{ columns: number; cardHeight: number; gap: number; height: number }>();
  const gridTopRef = useRef<HTMLDivElement | null>(null);
  /** The same node as state, so the rail can start under the page's own header. */
  const [gridTopNode, setGridTopNode] = useState<HTMLDivElement | null>(null);
  const setGridTop = useCallback((node: HTMLDivElement | null) => {
    gridTopRef.current = node;
    setGridTopNode(node);
  }, []);

  /** Document scroll position of an offset in the grid's own coordinates. */
  const scrollToOffset = useCallback((offset: number) => {
    const top = gridTopRef.current?.getBoundingClientRect().top;
    if (top === undefined) return;
    globalThis.scrollTo({ top: globalThis.scrollY + top + offset, behavior: 'instant' });
  }, []);

  const anchors = useMemo(() => {
    if (!model || !geometry) return [];
    const sections = sectionsForItems(filteredAlbums, model.mode === 'year' ? 7 : 10, geometry);
    return scrollAnchorsWithBounds(scrollAnchorsForSections(model, sections), model.targets.length, 0, geometry.height);
  }, [model, geometry, filteredAlbums]);

  // Both the drag and the release scroll loaded geometry — there is nothing to
  // seek to, since the page is holding the whole list already.
  const scrub = useCallback((selection: ScrubberSelection) => {
    const offset = offsetAtPosition(anchors, selection.position);
    if (offset === undefined) return false;
    scrollToOffset(offset);
    return true;
  }, [anchors, scrollToOffset]);

  const seek = useCallback((date: string) => {
    const index = indexAtDate(filteredAlbums, date, sortBy === 'oldest');
    if (index < 0 || !geometry) return;
    scrollToOffset(Math.floor(index / geometry.columns) * (geometry.cardHeight + geometry.gap));
  }, [filteredAlbums, geometry, scrollToOffset, sortBy]);

  return (
    <Box>
      <EntityDetailHeader
        title='Albums'
        pattern='album'
        meta={!loading && <HeaderStats items={[countOf(albums.length, 'album', 'albums')]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='albums' />}>
            <HeaderChoice
              label='Sort'
              value={sortBy}
              onChange={(value) => setSortBy(value as AlbumSort)}
              options={[
                { value: 'newest', label: 'Newest first', icon: <TablerIcon name='sort-descending' size={18} /> },
                { value: 'oldest', label: 'Oldest first', icon: <TablerIcon name='sort-ascending' size={18} /> },
                { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                { value: 'size', label: 'Most items', icon: <TablerIcon name='sort-descending-numbers' size={18} /> },
              ]}
            />
          </HeaderFilterBar>
        }
      />

      <Box px={{ base: 'md', sm: RAIL_GUTTER }} py='lg'>
        <Stack gap='lg'>
          {loading && <PageLoader label='Loading albums…' />}

          {error && (
            <Center py='xl'>
              <Text c='red'>{error.message}</Text>
            </Center>
          )}

          {/* Album grid. Windowed: the page holds thousands of cards and mounts a screenful. */}
          {!loading && !error && (
            <div ref={setGridTop}>
              <CardGrid
                items={filteredAlbums}
                itemKey={(album) => album.path}
                textParts={albumCardText}
                onGeometry={setGeometry}
              >
                {(album) => <AlbumCard album={album} onClick={() => navigate(albumRoute(album.path))} />}
              </CardGrid>
            </div>
          )}

          {!loading && !error && albums.length === 0 && (
            <EmptyState
              title='No albums yet'
              actions={isAuthenticated.value && (
                <Button
                  variant='light'
                  onClick={() => openDialog('/albums/new')}
                >
                  New album
                </Button>
              )}
            >
              An album gathers the pictures of one occasion. Staging suggests albums for what you upload.
            </EmptyState>
          )}
          {!loading && !error && albums.length > 0 && filteredAlbums.length === 0 && (
            <Box ta='center' py='xl'>
              <Text c='dimmed'>{search ? `No albums found matching "${search}"` : 'No albums here yet.'}</Text>
            </Box>
          )}
        </Stack>

        {dated && facets && filteredAlbums.length > 0 && (
          <TimelineScrubber
            facets={facets}
            onSeek={seek}
            onScrub={scrub}
            below={gridTopNode}
            ascending={sortBy === 'oldest'}
          />
        )}
      </Box>
    </Box>
  );
}
