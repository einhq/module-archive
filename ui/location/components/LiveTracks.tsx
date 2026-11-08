import { MapMarkers, type MapMarkerSpec, MapTracks, type MapTrackSpec, TablerIcon, useMap } from '@ein/ui/components';
import { ActionIcon, Anchor, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useRef } from 'react';
import type { LiveTrack } from '../hooks/useLiveTracks.ts';
import { formatAge, speedOf } from '../lib/live.ts';
import { formatSpeed, trackProfile } from '@archive/location/track-profile';
import { dayColor } from '../lib/track-colors.ts';
import './live-tracks.css';

/** The color a live track is drawn in: its color for the day of its last fix. */
const liveColor = (entry: LiveTrack): string => dayColor(entry.track.path, entry.last.ts?.slice(0, 10) ?? '');

/** `12 km/h · 40 s ago`, in knots for a boat, or the age alone when the speed is not known. */
export function liveSummary(entry: LiveTrack, now: number): string {
  const speed = speedOf(entry.points);
  const age = entry.last.ts ? formatAge(now - Date.parse(entry.last.ts)) : undefined;
  return [speed !== undefined ? formatSpeed(speed, trackProfile(entry.track.kind).units) : undefined, age].filter(Boolean).join(' · ');
}

/** Calls `onDrag` when the map is dragged by hand, which is what ends following. */
function DragWatcher({ onDrag }: { onDrag: () => void }) {
  const map = useMap();
  const handler = useRef(onDrag);
  handler.current = onDrag;

  useEffect(() => {
    if (!map) return;
    const dragged = () => handler.current();
    map.on('dragstart', dragged);
    return () => {
      map.off('dragstart', dragged);
    };
  }, [map]);

  return null;
}

/**
 * What a map draws of the live tracks, as children of its `MapView`: a pin where each one is now,
 * labelled with its speed and the age of the fix, and the line it has drawn since the page opened.
 * While `following` names a track's path the map keeps that track's newest fix in view, until the
 * map is dragged (`onStopFollowing`). A pin's click is `onPick`.
 */
export function LiveTrackLayers({ live, now, following, onStopFollowing, onPick }: {
  live: LiveTrack[];
  now: number;
  following: string | null;
  onStopFollowing: () => void;
  onPick?: (path: string) => void;
}) {
  const markers = useMemo(() =>
    live.map((entry): MapMarkerSpec => ({
      id: `live|${entry.track.path}`,
      lat: entry.last.lat,
      lng: entry.last.lng,
      color: liveColor(entry),
      active: entry.track.path === following,
      label: `${entry.track.name} · ${liveSummary(entry, now)}`,
      onClick: onPick && (() => onPick(entry.track.path)),
    })), [live, now, following, onPick]);

  // `MapTracks` follows its last track, so the followed one goes last.
  const lines = useMemo(() =>
    [...live]
      .sort((a, b) => Number(a.track.path === following) - Number(b.track.path === following))
      .map((entry): MapTrackSpec => ({ id: `live|${entry.track.path}`, points: entry.points, color: liveColor(entry), label: entry.track.name })), [live, following]);

  const followed = following !== null && live.some((entry) => entry.track.path === following);

  return (
    <>
      <MapTracks tracks={lines} follow={followed} />
      <MapMarkers markers={markers} />
      <DragWatcher onDrag={onStopFollowing} />
    </>
  );
}

/** A toggle for following one live track. */
export function FollowButton({ entry, following, onFollow }: { entry: LiveTrack; following: boolean; onFollow: (path: string | null) => void }) {
  const label = following ? `Stop following ${entry.track.name}` : `Follow ${entry.track.name}`;
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant={following ? 'filled' : 'subtle'}
        aria-label={label}
        aria-pressed={following}
        onClick={() => onFollow(following ? null : entry.track.path)}
      >
        <TablerIcon name='current-location' size={18} />
      </ActionIcon>
    </Tooltip>
  );
}

/** One row per live track: its color, its name linking to its page, its speed and the age of its fix, and a Follow toggle. */
export function LiveTrackList({ live, now, following, onFollow }: {
  live: LiveTrack[];
  now: number;
  following: string | null;
  onFollow: (path: string | null) => void;
}) {
  return (
    <Stack gap={4}>
      {live.map((entry) => (
        <Group key={entry.track.path} gap='xs' wrap='nowrap'>
          <Box w={10} h={10} style={{ borderRadius: '50%', background: liveColor(entry), flex: 'none' }} />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Anchor component={Link} to={`/tracks/${encodeURIComponent(entry.track.path)}`} size='sm' fw={500} truncate display='block'>
              {entry.track.name}
            </Anchor>
            <Text size='xs' c='dimmed' truncate>{liveSummary(entry, now)}</Text>
          </Box>
          <FollowButton entry={entry} following={entry.track.path === following} onFollow={onFollow} />
        </Group>
      ))}
    </Stack>
  );
}
