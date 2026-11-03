import { EmptyState, FillWindow, MapTracks, MapView, PageLoader } from '@ein/ui/components';
import { Badge, Box, Container, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useRejectedRuns, useTrack } from '../hooks/useTracks.ts';
import { useLiveTracks } from '../hooks/useLiveTracks.ts';
import { FollowButton, liveSummary, LiveTrackLayers } from './LiveTracks.tsx';
import { FixPanel, FixPicker, RejectedFixes } from './TrackFixes.tsx';
import type { TrackPoint } from '@archive/location/api';
import { movingSpeed, trackDistance } from '../lib/track-segments.ts';
import { formatDistance, formatSpeed, trackProfile } from '@archive/location/track-profile';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

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
      <Text size='md' fw={500}>{value}</Text>
    </Box>
  );
}

type TrackViewProps = {
  /** The device's slug. */
  device: string;
  /** How it travels, which says the units: knots and nautical miles for a boat, km/h and km otherwise. */
  kind?: string;
  /** What a device with no track yet offers to start one: uploading GPX files, live tracking. */
  emptyActions?: ReactNode;
  /** Whether the reader may change the track, which rejecting and accepting its fixes needs. */
  editable?: boolean;
};

/**
 * A device's track: its route on a map that fills the window, and over the map's foot what the
 * route adds up to. While its last fix is recent, the panel says how fast it is going and how old
 * the fix is, and the map draws where it is now and can follow it. The fixes the track left out
 * are drawn faintly; a click picks the fix nearest it, and the panel says what the track made of
 * it and offers to overrule that.
 */
export function TrackView({ device, kind, emptyActions, editable = false }: TrackViewProps) {
  const { track, segments, loading, refetch, reread, revision } = useTrack(device);
  const rejected = useRejectedRuns(track?.path, revision);
  const [picked, setPicked] = useState<TrackPoint | null>(null);
  const marked = useCallback(() => {
    setPicked(null);
    reread();
  }, [reread]);

  const listed = useMemo(() => track ? [track] : [], [track]);
  const { live, now } = useLiveTracks(listed, refetch);
  const current = live[0];
  const [following, setFollowing] = useState<string | null>(null);
  const stopFollowing = useCallback(() => setFollowing(null), []);

  const profile = trackProfile(kind);
  // Summed per segment, so a day boundary or a gap adds no phantom distance.
  const runs = useMemo(() => segments.map((segment) => ({ day: segment.id, points: segment.points })), [segments]);
  const distance = useMemo(() => trackDistance(runs), [runs]);
  const speed = useMemo(() => movingSpeed(runs, profile), [runs, profile]);

  if (loading && !track) {
    return <PageLoader label='Loading track…' />;
  }

  if (!track || track.points === 0) {
    return (
      <Container size='xl' p='md'>
        <EmptyState title='This device has recorded no track' actions={emptyActions}>
          Its route appears here once a GPX file it recorded is uploaded, or a phone tracks it live.
        </EmptyState>
      </Container>
    );
  }

  const days = new Set(segments.map((segment) => segment.label)).size;
  const left = rejected.reduce((sum, run) => sum + run.length, 0);

  return (
    <FillWindow>
      <Box h='100%' pos='relative'>
        <MapView style={{ height: '100%' }}>
          <MapTracks tracks={segments} fit />
          <RejectedFixes runs={rejected} />
          <FixPicker path={track.path} fix={picked} onPick={setPicked} />
          <LiveTrackLayers live={live} now={now} following={following} onStopFollowing={stopFollowing} onPick={setFollowing} />
        </MapView>

        <Box className='mrx-map-panel' pos='absolute' bottom={10} left={10} right={10} maw={760} mx='auto' p='sm' style={{ zIndex: 1000 }}>
          <Stack gap='xs'>
            {current && (
              <Group justify='space-between' wrap='nowrap'>
                <Group gap='sm' wrap='nowrap' style={{ minWidth: 0 }}>
                  <Badge color='green' variant='light' leftSection={<Box w={8} h={8} bg='green' style={{ borderRadius: '50%' }} />}>Live</Badge>
                  <Text size='sm' truncate>{liveSummary(current, now)}</Text>
                </Group>
                <FollowButton entry={current} following={following === current.track.path} onFollow={setFollowing} />
              </Group>
            )}
            {picked
              ? <FixPanel path={track.path} fix={picked} runs={rejected} editable={editable} onMarked={marked} onClose={() => setPicked(null)} />
              : left > 0 && (
                <Text size='xs' c='dimmed'>
                  {left.toLocaleString()} fix{left === 1 ? '' : 'es'} left out, drawn faint red. Click near a fix to see what the track made of it.
                </Text>
              )}
            <SimpleGrid cols={{ base: 3, sm: 5 }} spacing='sm' verticalSpacing={4}>
              <Stat label='Points' value={track.points.toLocaleString()} />
              <Stat label='Days' value={String(days || 0)} />
              <Stat label='Distance' value={distance > 0 ? formatDistance(distance, profile.units) : '—'} />
              <Stat label='Avg speed' value={speed !== undefined ? formatSpeed(speed, profile.units) : '—'} />
              <Stat label='Duration' value={duration(track.firstTs, track.lastTs) ?? '—'} />
            </SimpleGrid>
          </Stack>
        </Box>
      </Box>
    </FillWindow>
  );
}
