import { MapTracks } from '@ein/ui/components';
import { Paper, Text } from '@mantine/core';
import { useMemo } from 'react';
import { MediaMap } from '../../components/MediaMap.tsx';
import { useSpanTracks } from '../../location/hooks/useTracks.ts';
import { useAlbumTracks } from '../hooks/useAlbumTracks.ts';
import type { MapFilters } from '../../lib/map-params.ts';

type AlbumMapProps = {
  /** The album or folder whose media are drawn. */
  path: string;
  /** Its span, for what its tracks recorded while it was taken. */
  from?: string;
  to?: string;
};

/** `names` as a sentence's list: "A", "A and B", "A, B and C". */
const listed = (names: string[]): string => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * An album's media on a map, and the routes its tracks (`album-track-list`) recorded while they
 * were taken. The map opens fitted to the media and the routes together.
 */
export function AlbumMap({ path, from, to }: AlbumMapProps) {
  const filters = useMemo((): MapFilters => ({ under: path }), [path]);
  const { list: trackList, loading: listLoading } = useAlbumTracks(path);
  const tracks = useMemo(() => listLoading ? null : (trackList?.tracks ?? []).map((track) => track.path), [trackList, listLoading]);
  const { segments, loading: tracksLoading } = useSpanTracks(from, to, tracks);
  const around = useMemo(() => tracksLoading ? null : segments.flatMap((segment) => segment.points), [segments, tracksLoading]);

  const names = (trackList?.tracks ?? []).map((track) => track.name);
  return (
    <MediaMap
      filters={filters}
      around={around}
      layers={<MapTracks tracks={segments} />}
      note={(placed) =>
        !placed && (
          <Paper px='sm' py={6} radius='md' shadow='sm'>
            <Text size='sm' c='dimmed'>
              Nothing in this album has a position; the map shows the routes its tracks recorded while it was taken.
            </Text>
          </Paper>
        )}
      empty={
        <Text c='dimmed' ta='center' p='xl'>
          {names.length === 0
            ? 'Nothing in this album has a position, and it has no tracks whose routes to show.'
            : `Nothing in this album has a position, and ${listed(names)} recorded no route while it was taken.`}
        </Text>
      }
    />
  );
}
