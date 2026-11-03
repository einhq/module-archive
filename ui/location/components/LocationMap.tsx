import { MapMarkers, MapShape, TablerIcon } from '@ein/ui/components';
import { Badge, Box, Button, Group, Paper, ScrollArea, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import type { PositionPoint, PositionShape } from '@ein/ui/lib';
import { useMemo, useState } from 'react';
import { MediaMap } from '../../components/MediaMap.tsx';
import type { MapFilters } from '../../lib/map-params.ts';
import { candidateMarkers } from './candidates.ts';
import type { GeocodeCandidate, LocationDetail } from '../hooks/useLocationDetail.ts';

/** Metres in a degree of latitude, near enough for fitting a view. */
const METRES_PER_DEGREE = 111_320;

const NONE: GeocodeCandidate[] = [];

/** The points a shape's extent runs through: a polygon's corners, a circle's four edges. */
function shapePoints(shape: PositionShape): PositionPoint[] {
  if (shape.polygon) return shape.polygon;
  if (!shape.radius) return [shape];
  const lat = shape.radius / METRES_PER_DEGREE;
  const lng = shape.radius / (METRES_PER_DEGREE * Math.cos(shape.lat * Math.PI / 180));
  return [
    { lat: shape.lat + lat, lng: shape.lng },
    { lat: shape.lat - lat, lng: shape.lng },
    { lat: shape.lat, lng: shape.lng + lng },
    { lat: shape.lat, lng: shape.lng - lng },
  ];
}

type LocationMapProps = {
  location: LocationDetail;
  /** The server still authorizes the change; this just keeps the picking out of read-only views. */
  editable: boolean;
  /** Opens the edit dialog, where the shape is drawn by hand. */
  onEdit: () => void;
  acceptCandidate: (candidate: GeocodeCandidate) => Promise<void>;
};

/**
 * A location's shape and the media linked to it, on a map that opens fitted to both.
 *
 * Until it has a shape, the geocoder's suggestions are numbered pins with their list over the map's
 * foot: pointing at either lights up the other, and clicking one places the location there.
 */
export function LocationMap({ location, editable, onEdit, acceptCandidate }: LocationMapProps) {
  const { shape } = location;
  const candidates = shape ? NONE : location.candidates;
  const [active, setActive] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (candidate: GeocodeCandidate) => {
    try {
      setSaving(true);
      setError(null);
      await acceptCandidate(candidate);
      setActive(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const pick = editable && !saving ? choose : undefined;

  const filters = useMemo((): MapFilters => ({ location: location.path }), [location.path]);
  const around = useMemo(() => [...(shape ? shapePoints(shape) : []), ...candidates], [shape, candidates]);
  const pins = candidateMarkers(candidates, { active, onHover: setActive, onClick: pick && ((candidate) => void pick(candidate)) });

  return (
    <MediaMap
      filters={filters}
      around={around}
      layers={
        <>
          {shape && <MapShape shape={shape} />}
          {pins.length > 0 && <MapMarkers markers={pins} />}
        </>
      }
      note={() =>
        candidates.length > 0 && (
          <Paper p='sm' radius='md' shadow='sm' w={380} maw='100%'>
            <Title order={4} size='h5' mb={4}>Suggested locations</Title>
            <Text size='xs' c='dimmed' mb='xs'>
              Geocoding was not confident enough to place this automatically. {editable ? 'Pick the right one, or set it by hand.' : ''}
            </Text>
            <ScrollArea.Autosize mah='35vh'>
              <Stack gap={4}>
                {candidates.map((candidate, index) => (
                  <UnstyledButton
                    key={`${candidate.lat},${candidate.lng},${index}`}
                    disabled={!pick}
                    onClick={() => pick?.(candidate)}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                    p={4}
                    style={{
                      borderRadius: 6,
                      // The same highlight the pin takes, so hovering either half says which pin this row is.
                      background: active === index ? 'var(--mantine-color-yellow-light)' : undefined,
                    }}
                  >
                    <Group gap='xs' wrap='nowrap' align='flex-start'>
                      <Badge size='sm' circle variant='filled' color={active === index ? 'yellow' : 'marine'} style={{ flexShrink: 0, marginTop: 2 }}>
                        {index + 1}
                      </Badge>
                      <Box style={{ minWidth: 0 }}>
                        <Text size='sm' lineClamp={2}>{candidate.displayName}</Text>
                        <Text size='xs' c='dimmed'>{candidate.type} · {candidate.lat.toFixed(5)}, {candidate.lng.toFixed(5)}</Text>
                      </Box>
                    </Group>
                  </UnstyledButton>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            {error && <Text c='red' size='sm' mt='xs'>{error}</Text>}
            {editable && (
              <Button size='xs' variant='default' mt='sm' fullWidth leftSection={<TablerIcon name='map-pin' size={14} />} onClick={onEdit}>
                None of these — place it by hand
              </Button>
            )}
          </Paper>
        )}
      empty={
        <Stack align='center' gap='sm' p='xl'>
          <Text c='dimmed'>No location set yet.</Text>
          {editable && (
            <Button size='xs' variant='light' leftSection={<TablerIcon name='map-pin' size={14} />} onClick={onEdit}>
              Location on map
            </Button>
          )}
        </Stack>
      }
    />
  );
}
