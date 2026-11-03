import { MapMarkers, MapTracks, type MapTrackSpec, TablerIcon, useMap } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { ActionIcon, Button, Group, Text } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackPoint, TrackRead } from '@archive/location/api';

/** What a track left out is drawn in: a faint red, over a map or a satellite picture. */
const REJECTED_COLOR = '#e03131';

/** How near a click, in pixels, a fix has to be to be picked. */
const PICK_PX = 12;

/** Fixes read around a click, at most. */
const PICK_LIMIT = 2000;

/** The fixes a track left out, drawn faintly, a run of them to a line, as children of its `MapView`. */
export function RejectedFixes({ runs }: { runs: TrackPoint[][] }) {
  const lines = useMemo(() =>
    runs.map((points): MapTrackSpec => ({
      id: `rejected|${points[0]?.ts}`,
      points,
      color: REJECTED_COLOR,
      faint: true,
      label: points.length === 1 ? 'Left out' : `${points.length} fixes left out`,
    })), [runs]);

  return <MapTracks tracks={lines} />;
}

/**
 * Picks the fix of the track at `path` nearest a click on the map, drawn or left out, within a
 * few pixels of it, or null when none is; as a child of its `MapView`, which marks the fix picked.
 * The fixes around the click are read from the track itself, so a fix the drawn line thinned
 * away can be picked too.
 */
export function FixPicker({ path, fix, onPick }: { path: string; fix: TrackPoint | null; onPick: (fix: TrackPoint | null) => void }) {
  const map = useMap();
  const handler = useRef(onPick);
  handler.current = onPick;

  useEffect(() => {
    if (!map) return;
    let generation = 0;

    const clicked = async (event: { latlng: { lat: number; lng: number } }) => {
      const at = map.latLngToContainerPoint(event.latlng);
      const northEast = map.containerPointToLatLng([at.x + PICK_PX, at.y - PICK_PX]);
      const southWest = map.containerPointToLatLng([at.x - PICK_PX, at.y + PICK_PX]);
      const bbox = `${northEast.lat},${southWest.lat},${northEast.lng},${southWest.lng}`;
      const mine = ++generation;

      try {
        const read = await execCommand<TrackRead>(`track-read ${shq(path)} --bbox=${bbox} --margin=0 --rejected --limit=${PICK_LIMIT}`);
        if (mine !== generation) return;

        let nearest: TrackPoint | null = null;
        let distance = PICK_PX;
        for (const point of read.segments.flatMap((segment) => segment.points)) {
          const px = map.latLngToContainerPoint([point.lat, point.lng]).distanceTo(at);
          if (px <= distance) {
            nearest = point;
            distance = px;
          }
        }
        handler.current(nearest);
      } catch {
        if (mine === generation) handler.current(null);
      }
    };

    map.on('click', clicked);
    return () => {
      map.off('click', clicked);
    };
  }, [map, path]);

  const markers = useMemo(() => fix ? [{ id: 'picked-fix', lat: fix.lat, lng: fix.lng, color: fix.rejected ? REJECTED_COLOR : undefined }] : [], [fix]);

  return <MapMarkers markers={markers} />;
}

/** The half-open time range that holds exactly these fixes, in time order. */
const spanOf = (fixes: TrackPoint[]): string => {
  const last = Date.parse(fixes[fixes.length - 1].ts ?? '');
  return `--from=${fixes[0].ts} --to=${new Date(last + 1).toISOString()}`;
};

/** What the track made of a fix, and who said so. */
function verdictOf(fix: TrackPoint): string {
  if (fix.rejected === 'manual') return 'left out by hand';
  if (fix.rejected === 'excursion') return 'left out by the rules, as a GPS excursion';
  if (fix.rejected) return `left out by the rules (${fix.rejected})`;
  return fix.manual === 'accept' ? 'kept by hand' : 'kept';
}

type FixPanelProps = {
  /** The track's path. */
  path: string;
  fix: TrackPoint;
  /** The track's runs of rejected fixes, to find the one a rejected fix is in. */
  runs: TrackPoint[][];
  /** Whether the reader may change the track, which is what the actions need. */
  editable: boolean;
  /** The fixes were marked; the track is to be read again. */
  onMarked: () => void;
  onClose: () => void;
};

/**
 * The fix picked on a track's map: when it was recorded and what the track made of it, and, for
 * whoever may change the track, the verdict to give it by hand. A drawn fix can be rejected; a
 * rejected one accepted, with the rest of the run of rejected fixes it is in; and a verdict given
 * by hand undone, which hands the fixes back to the rules (`track-mark`).
 */
export function FixPanel({ path, fix, runs, editable, onMarked, onClose }: FixPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (fix.rejected && runs.find((points) => points.some((point) => point.ts === fix.ts))) || [fix];
  const others = run.length - 1;

  const mark = async (verdict: 'reject' | 'accept' | 'clear', fixes: TrackPoint[]) => {
    setBusy(verdict);
    setError(null);
    try {
      await execCommand(`track-mark ${shq(path)} ${spanOf(fixes)} --${verdict}`);
      onMarked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const when = fix.ts ? new Date(fix.ts).toLocaleString() : '';

  return (
    <Group justify='space-between' wrap='nowrap' gap='xs'>
      <Text size='sm' style={{ minWidth: 0 }}>
        {when} · {verdictOf(fix)}
        {fix.rejected && others > 0 && `, with ${others} fix${others === 1 ? '' : 'es'} beside it`}
        {error && <Text span c='red' size='sm'>{` · ${error}`}</Text>}
      </Text>
      <Group gap='xs' wrap='nowrap'>
        {editable && (fix.rejected
          ? (
            <Button size='xs' variant='light' loading={busy === 'accept'} disabled={busy !== null} onClick={() => mark('accept', run)}>
              {others > 0 ? `Accept all ${run.length}` : 'Accept'}
            </Button>
          )
          : (
            <Button size='xs' variant='light' color='red' loading={busy === 'reject'} disabled={busy !== null} onClick={() => mark('reject', [fix])}>
              Reject
            </Button>
          ))}
        {editable && fix.manual && (
          <Button
            size='xs'
            variant='default'
            loading={busy === 'clear'}
            disabled={busy !== null}
            onClick={() => mark('clear', fix.rejected ? run : [fix])}
          >
            Undo
          </Button>
        )}
        <ActionIcon variant='subtle' color='gray' aria-label='Close' onClick={onClose}>
          <TablerIcon name='x' size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
