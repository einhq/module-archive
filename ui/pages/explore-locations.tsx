import { Box, Card, Skeleton, Text, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { LocationEntry } from '@archive/location/api';
import { ExploreRow, ExploreSection } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { StaticMap } from '../location/components/StaticMap.tsx';

/** How many locations the row offers. */
const LIMIT = 16;
const WIDTH = 200;
const MAP_HEIGHT = 120;

/**
 * The locations most pictures were taken at, as a row of small maps: the Search landing's
 * Locations section (`archive.explore-locations`). Only located ones; nothing while there are none.
 */
export default function ExploreLocations() {
  const { data, loading } = useCommand<LocationEntry[]>('location-list');
  const locations = (data ?? [])
    .filter((location) => location.lat !== undefined && location.lng !== undefined)
    .toSorted((a, b) => (b.locationPoints ?? 0) - (a.locationPoints ?? 0) || a.name.localeCompare(b.name))
    .slice(0, LIMIT);
  if (!loading && locations.length === 0) return null;

  return (
    <ExploreSection icon='map-pin' title='Locations' to='/locations'>
      <ExploreRow>
        {loading && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} width={WIDTH} height={MAP_HEIGHT + 36} radius='md' />)}
        {locations.map((location) => (
          <UnstyledButton key={location.id} component={Link} to={`/locations/${encodeURIComponent(location.id)}`} w={WIDTH}>
            <Card padding={0} radius='md' bg='var(--mrx-surface-raised)'>
              <Box h={MAP_HEIGHT} pos='relative'>
                <StaticMap lat={location.lat!} lng={location.lng!} />
              </Box>
              <Text size='sm' fw={500} px='sm' py={8} truncate>{location.name}</Text>
            </Card>
          </UnstyledButton>
        ))}
      </ExploreRow>
    </ExploreSection>
  );
}
