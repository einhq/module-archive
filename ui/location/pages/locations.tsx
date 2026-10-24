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
import { LOCATIONS_ROOT } from '@archive/paths';
import { Badge, Box, Button, Stack, Text } from '@mantine/core';
import { isAuthenticated, openDialog } from '@ein/ui/signals';
import { StaticMap } from '../components/StaticMap.tsx';
import { countOf, matchesText } from '@ein/ui/lib';
import { type LocationEntry, useLocations } from '../hooks/useLocations.ts';
import { usePersistedState, useUrlParam } from '@ein/ui/hooks';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type Scope = 'all' | 'unplaced';
type LocationSort = 'name' | 'name-desc';

const locationDescription = (location: LocationEntry): string | undefined => (location.displayName ?? location.address)?.replace(/\s*\n\s*/g, ', ');

/** Where a placed location's position came from, or how many suggestions an unplaced one has. */
const locationHasBadge = (location: LocationEntry): boolean => location.lat !== undefined ? Boolean(location.locationSource) : location.candidateCount > 0;

export const handle = { fullBleed: true };

export default function LocationsPage() {
  const [search, setSearch] = useUrlParam('q');
  const [scope, setScope] = useState<Scope>('all');
  const [sortBy, setSortBy] = usePersistedState<LocationSort>('locations.list.sort', 'name');
  const { locations, loading } = useLocations();
  const navigate = useNavigate();

  const unplaced = locations.filter((p) => p.lat === undefined);
  const scoped = scope === 'unplaced' ? unplaced : locations;
  const filtered = useMemo(() => {
    const matching = scoped.filter((location) => matchesText([location.name, location.address], search));
    return matching.toSorted((a, b) => sortBy === 'name-desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
  }, [scoped, search, sortBy]);

  return (
    <Box>
      <EntityDetailHeader
        title='Locations'
        pattern='location'
        meta={!loading && <HeaderStats items={[countOf(locations.length, 'location', 'locations')]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='locations' />}>
            <HeaderChoices>
              {unplaced.length > 0 && (
                <HeaderChoice
                  label='Show'
                  variant='segmented'
                  value={scope}
                  onChange={(next) => setScope(next as Scope)}
                  options={[
                    { label: `All (${locations.length})`, value: 'all', icon: <TablerIcon name='map-pins' size={18} /> },
                    { label: `Needs location (${unplaced.length})`, value: 'unplaced', icon: <TablerIcon name='map-pin-question' size={18} /> },
                  ]}
                />
              )}
              <HeaderChoice
                label='Sort'
                value={sortBy}
                onChange={(value) => setSortBy(value as LocationSort)}
                options={[
                  { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                  { value: 'name-desc', label: 'Name (Z-A)', icon: <TablerIcon name='sort-descending-letters' size={18} /> },
                ]}
              />
            </HeaderChoices>
          </HeaderFilterBar>
        }
      />

      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {loading ? <PageLoader label='Loading locations…' /> : (
            <>
              <CardGrid
                items={filtered}
                itemKey={(location) => location.id}
                textParts={(location) => ({ description: Boolean(locationDescription(location)), badges: locationHasBadge(location) })}
              >
                {(location) => {
                  const placed = location.lat !== undefined;
                  return (
                    <BrowseEntityCard
                      title={location.name}
                      description={locationDescription(location)}
                      coverPath={`${LOCATIONS_ROOT}/${location.id}`}
                      kind='location'
                      // A location nobody has put on the map says so where the
                      // picture would be; the flag still names it a location.
                      icon={placed ? undefined : <TablerIcon name='map-pin-off' size={48} stroke={1} />}
                      // No photo chosen for it, a placed location shows where it is.
                      coverArt={location.lat !== undefined && location.lng !== undefined ? <StaticMap lat={location.lat} lng={location.lng} /> : undefined}
                      onClick={() => navigate(`/locations/${location.id}`)}
                      badges={!locationHasBadge(location)
                        ? undefined
                        : placed && location.locationSource
                        ? (
                          <Badge size='xs' variant='light' color={location.locationSource === 'media-centroid' ? 'marine' : 'gray'}>
                            {location.locationSource === 'manual'
                              ? 'set by hand'
                              : location.locationSource === 'media-centroid'
                              ? `from ${location.locationPoints ?? 0} photo${location.locationPoints === 1 ? '' : 's'}`
                              : 'from address'}
                          </Badge>
                        )
                        : !placed && location.candidateCount > 0
                        ? <Badge size='xs' variant='light' color='yellow'>{location.candidateCount} suggestion{location.candidateCount === 1 ? '' : 's'}</Badge>
                        : undefined}
                    />
                  );
                }}
              </CardGrid>

              {locations.length === 0 && (
                <EmptyState
                  title='No locations yet'
                  actions={isAuthenticated.value && (
                    <Button
                      variant='light'
                      onClick={() => openDialog('/locations/new')}
                    >
                      New location
                    </Button>
                  )}
                >
                  Homes, churches, summer houses: locations where people lived or pictures were taken.
                </EmptyState>
              )}
              {locations.length > 0 && filtered.length === 0 && (
                <Box ta='center' py='xl'>
                  <Text c='dimmed'>No locations found matching "{search}"</Text>
                </Box>
              )}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
