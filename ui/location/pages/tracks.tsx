import { Badge, Box, Stack, Text } from '@mantine/core';
import {
  BrowseEntityCard,
  CardGrid,
  EmptyState,
  EntityDetailHeader,
  HeaderChoice,
  HeaderChoices,
  HeaderFilterBar,
  HeaderStats,
  ListFilterInput,
  PageLoader,
  TablerIcon,
} from '@ein/ui/components';
import { usePersistedState, useUrlParam } from '@ein/ui/hooks';
import { countOf, matchesText, plainMarkdown } from '@ein/ui/lib';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TrackEntry } from '@archive/location/api';
import { isTravelKind, TRAVEL_KIND_LABELS } from '@archive/location/track-profile';
import { useTracks } from '../hooks/useTracks.ts';

type TrackSort = 'name' | 'recent';

const trackDescription = (track: TrackEntry): string | undefined => track.description ? plainMarkdown(track.description) : undefined;

/** The page draws its own band edge to edge. */
export const handle = { fullBleed: true };

/**
 * `/tracks`: every track under the archive (`track-list`), a card each with its name, how it
 * travels, how many positions it holds and the span they were recorded over; a card opens the
 * track's page.
 */
export default function TracksPage() {
  const [search, setSearch] = useUrlParam('q');
  const [sortBy, setSortBy] = usePersistedState<TrackSort>('tracks.list.sort', 'name');
  const { tracks, loading, error } = useTracks();
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const matching = tracks.filter((track) => matchesText([track.name, track.description], search));
    if (sortBy === 'recent') return matching.toSorted((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? '') || a.name.localeCompare(b.name));
    return matching.toSorted((a, b) => a.name.localeCompare(b.name));
  }, [tracks, search, sortBy]);

  return (
    <Box>
      <EntityDetailHeader
        title='Tracks'
        pattern='track'
        meta={!loading && <HeaderStats items={[countOf(tracks.length, 'track', 'tracks')]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='tracks' />}>
            <HeaderChoices>
              <HeaderChoice
                label='Sort'
                value={sortBy}
                onChange={(value) => setSortBy(value as TrackSort)}
                options={[
                  { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                  { value: 'recent', label: 'Last recorded', icon: <TablerIcon name='clock' size={18} /> },
                ]}
              />
            </HeaderChoices>
          </HeaderFilterBar>
        }
      />

      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {error && <Text c='red'>{error.message}</Text>}
          {loading ? <PageLoader label='Loading tracks…' /> : (
            <>
              <CardGrid
                items={filtered}
                itemKey={(track) => track.path}
                textParts={(track) => ({ date: Boolean(track.firstTs), description: Boolean(trackDescription(track)), badges: true })}
              >
                {(track) => (
                  <BrowseEntityCard
                    title={track.name}
                    description={trackDescription(track)}
                    kind='track'
                    timeStart={track.firstTs}
                    timeEnd={track.lastTs}
                    hoverText={track.path}
                    onClick={() => navigate(`/tracks/${encodeURIComponent(track.path)}`)}
                    badges={
                      <>
                        {isTravelKind(track.kind) && <Badge size='xs' variant='light' color='cyan'>{TRAVEL_KIND_LABELS[track.kind]}</Badge>}
                        <Badge size='xs' variant='light' color='gray'>{countOf(track.points, 'position', 'positions')}</Badge>
                      </>
                    }
                  />
                )}
              </CardGrid>

              {tracks.length === 0 && (
                <EmptyState title='No tracks yet'>
                  Where a GPS tracker, a phone or a GPX file says something travelled: a boat, a car, a hike. A tracker's history is one, kept with its device.
                </EmptyState>
              )}
              {tracks.length > 0 && filtered.length === 0 && (
                <Box ta='center' py='xl'>
                  <Text c='dimmed'>No tracks found matching "{search}"</Text>
                </Box>
              )}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
