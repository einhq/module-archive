import { EmptyState, FillWindow, MapTracks, MapView, PageLoader, TablerIcon } from '@ein/ui/components';
import { Badge, Box, Button, Collapse, Container, Group, Paper, ScrollArea, SimpleGrid, Stack, Text } from '@mantine/core';
import { useTrack } from '../hooks/useTracks.ts';
import { useLiveTracks } from '../hooks/useLiveTracks.ts';
import { TrackUpload } from './TrackUpload.tsx';
import { FollowButton, liveSummary, LiveTrackLayers } from './LiveTracks.tsx';
import { movingSpeed, trackDistance } from '../lib/track-segments.ts';
import { formatDistance, formatSpeed, trackProfile } from '@archive/location/track-profile';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
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
      <Text size='md' fw={500}>{value}</Text>
    </Box>
  );
}

type TrackViewProps = {
  /** The device's slug. */
  device: string;
  /** How it travels, which says the units: knots and nautical miles for a boat, km/h and km otherwise. */
  kind?: string;
  /** Offers GPX files to add to the track. */
  editable: boolean;
  /** More about recording the track, after the files it was read from: setting up live tracking. */
  more?: ReactNode;
};

/**
 * A device's track: its route on a map that fills the window, and over the map's foot what the
 * route adds up to. While its last fix is recent, the panel says how fast it is going and how old
 * the fix is, and the map draws where it is now and can follow it. The panel's details hold the
 * track's span, the GPX files it was read from, the upload and `more`. A device with no track yet
 * gets the upload and `more` on the page instead.
 */
export function TrackView({ device, kind, editable, more }: TrackViewProps) {
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
  const [details, setDetails] = useState(false);

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
        <Stack gap='lg'>
          <EmptyState title='This device has recorded no track' actions={upload}>
            {editable ? 'Upload a GPX file it recorded, and its route appears here.' : 'Its route appears here once a GPX file it recorded is uploaded.'}
          </EmptyState>
          {more}
        </Stack>
      </Container>
    );
  }

  const days = new Set(segments.map((segment) => segment.label)).size;

  return (
    <FillWindow>
      <Box h='100%' pos='relative'>
        <MapView style={{ height: '100%' }}>
          <MapTracks tracks={segments} fit />
          <LiveTrackLayers live={live} now={now} following={following} onStopFollowing={stopFollowing} onPick={setFollowing} />
        </MapView>

        <Paper
          pos='absolute'
          bottom={10}
          left={10}
          right={10}
          maw={760}
          mx='auto'
          p='sm'
          radius='md'
          shadow='md'
          style={{ zIndex: 1000 }}
        >
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
            <Group justify='space-between' align='flex-start' wrap='nowrap' gap='xs'>
              <SimpleGrid cols={{ base: 3, sm: 5 }} spacing='sm' verticalSpacing={4} style={{ flex: 1 }}>
                <Stat label='Points' value={track.points.toLocaleString()} />
                <Stat label='Days' value={String(days || 0)} />
                <Stat label='Distance' value={distance > 0 ? formatDistance(distance, profile.units) : '—'} />
                <Stat label='Avg speed' value={speed !== undefined ? formatSpeed(speed, profile.units) : '—'} />
                <Stat label='Duration' value={duration(track.firstTs, track.lastTs) ?? '—'} />
              </SimpleGrid>
              <Button
                size='compact-sm'
                variant='subtle'
                rightSection={<TablerIcon name={details ? 'chevron-down' : 'chevron-up'} size={14} />}
                onClick={() => setDetails((open) => !open)}
                style={{ flexShrink: 0 }}
              >
                Details
              </Button>
            </Group>

            <Collapse expanded={details}>
              <ScrollArea.Autosize mah='50dvh' type='auto'>
                <Stack gap='sm' pt='xs'>
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
                    <Stack gap='xs'>
                      <Text size='xs' c='dimmed' tt='uppercase' fw={500}>Read from</Text>
                      <SourceFiles files={files} />
                    </Stack>
                  )}
                  {upload && <Group>{upload}</Group>}
                  {more}
                </Stack>
              </ScrollArea.Autosize>
            </Collapse>
          </Stack>
        </Paper>
      </Box>
    </FillWindow>
  );
}
