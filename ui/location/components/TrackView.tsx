import { EmptyState, MapTracks, MapView, PageLoader } from '@ein/ui/components';
import { Badge, Box, Card, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useTrack } from '../hooks/useTracks.ts';
import { useLiveTracks } from '../hooks/useLiveTracks.ts';
import { TrackUpload } from './TrackUpload.tsx';
import { FollowButton, liveSummary, LiveTrackLayers } from './LiveTracks.tsx';
import { trackDistance } from '../lib/track-segments.ts';
import { useCallback, useMemo, useState } from 'react';
import { useSourceFiles } from '../../hooks/useSourceFiles.ts';
import { SourceFiles } from '../../components/SourceFiles.tsx';

/** `3 h 12 min`, or minutes alone when it is under an hour. */
function duration(firstTs?: string, lastTs?: string): string | undefined {
  if (!firstTs || !lastTs) return undefined;
  const ms = Date.parse(lastTs) - Date.parse(firstTs);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;

  const minutes = Math.round(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text size='xs' c='dimmed' tt='uppercase' fw={500}>{label}</Text>
      <Text size='lg' fw={500}>{value}</Text>
    </Box>
  );
}

/**
 * A device's track: its route on a map, what the route adds up to, and the GPX files it was read
 * from. While its last fix is recent, a live card says how fast it is going and how old the fix is,
 * and the map draws where it is now and can follow it. `device` is the device's slug; `editable`
 * offers GPX files to add to it.
 */
export function TrackView({ device, editable }: { device: string; editable: boolean }) {
  const { track, segments, truncated, loading, refetch } = useTrack(device);
  const { files, refetch: refetchFiles } = useSourceFiles(track?.path);
  const imported = () => {
    refetch();
    refetchFiles();
  };
  const upload = editable && <TrackUpload device={device} onImported={imported} />;

  const listed = useMemo(() => track ? [track] : [], [track]);
  const { live, now } = useLiveTracks(listed, refetch);
  const current = live[0];
  const [following, setFollowing] = useState<string | null>(null);
  const stopFollowing = useCallback(() => setFollowing(null), []);

  // Summed per segment, so a day boundary or a gap adds no phantom distance.
  const distance = useMemo(() => trackDistance(segments.map((segment) => ({ day: segment.id, points: segment.points }))), [segments]);

  if (loading && !track) {
    return <PageLoader label='Loading track…' />;
  }

  if (!track || track.points === 0) {
    return (
      <EmptyState title='This device has recorded no track' actions={upload}>
        {editable ? 'Upload a GPX file it recorded, and its route appears here.' : 'Its route appears here once a GPX file it recorded is uploaded.'}
      </EmptyState>
    );
  }

  const days = new Set(segments.map((segment) => segment.label)).size;

  return (
    <Stack gap='lg'>
      {upload && <Group justify='flex-end'>{upload}</Group>}
      {current && (
        <Card radius='md' withBorder>
          <Group justify='space-between' wrap='nowrap'>
            <Group gap='sm' wrap='nowrap' style={{ minWidth: 0 }}>
              <Badge color='green' variant='light' leftSection={<Box w={8} h={8} bg='green' style={{ borderRadius: '50%' }} />}>Live</Badge>
              <Text size='sm' truncate>{liveSummary(current, now)}</Text>
            </Group>
            <FollowButton entry={current} following={following === current.track.path} onFollow={setFollowing} />
          </Group>
        </Card>
      )}
      <Card radius='md' p={0} style={{ overflow: 'hidden' }}>
        <Box h={480}>
          <MapView>
            <MapTracks tracks={segments} fit />
            <LiveTrackLayers live={live} now={now} following={following} onStopFollowing={stopFollowing} onPick={setFollowing} />
          </MapView>
        </Box>
      </Card>

      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Stat label='Points' value={track.points.toLocaleString()} />
        <Stat label='Days' value={String(days || 0)} />
        <Stat label='Distance' value={distance > 0 ? `${(distance / 1000).toFixed(1)} km` : '—'} />
        <Stat label='Duration' value={duration(track.firstTs, track.lastTs) ?? '—'} />
      </SimpleGrid>

      {
        /* Said only when the read was actually thinned — then the distance is a
        floor rather than the surveyed length, since decimated points cut corners. */
      }
      <Text size='xs' c='dimmed'>
        {track.firstTs?.slice(0, 16).replace('T', ' ')}
        {track.lastTs && track.lastTs !== track.firstTs ? ` – ${track.lastTs.slice(0, 16).replace('T', ' ')}` : ''}
        {track.description ? ` · ${track.description}` : ''}
        {truncated ? ' · drawn from a thinned copy of the track' : ''}
      </Text>

      {files.length > 0 && (
        <Stack gap='xs' maw={560}>
          <Text size='xs' c='dimmed' tt='uppercase' fw={500}>Read from</Text>
          <SourceFiles files={files} />
        </Stack>
      )}
    </Stack>
  );
}
