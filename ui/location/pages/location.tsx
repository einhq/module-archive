import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { TimelineFeed } from '../../components/TimelineFeed.tsx';
import { EntityDetailHeader, MapMarkers, MapShape, MapView, PageLoader, TablerIcon } from '@ein/ui/components';
import { Anchor, Badge, Box, Button, Card, Container, Grid, Group, Stack, Tabs, Text, Title, UnstyledButton } from '@mantine/core';
import { EventModal } from '../../people/components/EventModal.tsx';
import { LocationEditModal } from '../components/LocationEditModal.tsx';
import { LocationResidentsTab } from '../components/LocationResidentsTab.tsx';
import { StaticMap } from '../components/StaticMap.tsx';
import { candidateBounds, candidateMarkers } from '../components/candidates.ts';
import { GeocodeCandidate, useLocationDetail } from '../hooks/useLocationDetail.ts';
import { useSubjectTimeline } from '../../hooks/useSubjectTimeline.ts';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';
import { type CSSProperties, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CurrentPeopleCard, CurrentPeopleLine } from '../../components/CurrentPeople.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { UserText } from '../../components/UserText.tsx';

const TABS = ['info', 'timeline', 'media', 'residents'] as const;
type LocationTab = typeof TABS[number];

const isTab = (value: string | null): value is LocationTab => value !== null && (TABS as readonly string[]).includes(value);

/** The feed here does not page, so the sentinels have nothing to observe. */
const noSentinel = () => {};

export const handle = { fullBleed: true };

export default function LocationDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { location, residents, loading, refetch, saveShape, acceptCandidate } = useLocationDetail(id);
  const access = useAccessIds();

  // The map is the location, so it is what the page opens on; the other tabs are
  // linkable the same way a person's are.
  const tab: LocationTab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as LocationTab : 'info';
  const setTab = (value: string | null) => setSearchParams(value && value !== 'info' ? { tab: value } : {}, { replace: true });

  const { groups, loading: feedLoading, refetch: refetchFeed } = useSubjectTimeline('location-timeline', location?.path ?? null);

  const [editing, setEditing] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Suggestion under the pointer, in the list or on the map — they highlight each other. */
  const [activeCandidate, setActiveCandidate] = useState<number | null>(null);

  // Computed before the early returns below, because hooks cannot be skipped.
  const editable = location ? canWrite(location.ownership, access) : false;
  const candidates = location?.candidates ?? [];
  const showCandidates = !location?.shape && candidates.length > 0;

  const chooseCandidate = async (candidate: GeocodeCandidate) => {
    try {
      setSaving(true);
      setSaveError(null);
      await acceptCandidate(candidate);
      setActiveCandidate(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Pickable here; the edit dialog shows them too, as reference while drawing.
  const markers = useMemo(
    () =>
      showCandidates
        ? candidateMarkers(candidates, {
          active: activeCandidate,
          onHover: setActiveCandidate,
          onClick: editable && !saving ? (candidate) => void chooseCandidate(candidate) : undefined,
        })
        : [],
    [showCandidates, candidates, activeCandidate, editable, saving],
  );
  const bounds = useMemo(() => showCandidates ? candidateBounds(candidates) : undefined, [showCandidates, candidates]);

  // Only the first load: an edit re-reads the location, and swapping the page for
  // a loader then would lose the tab being worked in.
  if (loading && !location) {
    return <PageLoader label='Loading location…' />;
  }

  if (!location) {
    return (
      <Container size='xl' py='md'>
        <Stack gap='lg'>
          <Anchor onClick={() => navigate('/locations')} c='dimmed' size='sm'>
            ← Locations
          </Anchor>
          <Text c='dimmed'>Location not found.</Text>
        </Stack>
      </Container>
    );
  }

  // `keepMounted={false}`: the media tab is the expensive one, and a Leaflet map
  // mounted in a hidden panel measures itself as zero-sized.
  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
            <Tabs.Tab value='timeline' leftSection={<TablerIcon name='calendar-event' size={16} />}>Timeline</Tabs.Tab>
            <Tabs.Tab value='media' leftSection={<TablerIcon name='photo' size={16} />}>Media</Tabs.Tab>
            <Tabs.Tab value='residents' leftSection={<TablerIcon name='users' size={16} />}>Residents</Tabs.Tab>
          </Tabs.List>
        }
        path={location.path}
        pattern='location'
        title={location.name}
        fallback={<TablerIcon name='map-pin' size={52} />}
        // The same picture the location's card shows until it has a cover photo.
        coverArt={location.shape ? <StaticMap lat={location.shape.lat} lng={location.shape.lng} /> : undefined}
        subtitle={location.address && <Text c='dimmed'>{location.address.replace(/\s*\n\s*/g, ', ')}</Text>}
        meta={
          <>
            <CurrentPeopleLine people={residents} label='Current residents' />
            <NodeLabels path={location.path} mt={4} />
          </>
        }
        actions={editable
          ? {
            share: location.path,
            edit: () => setEditing(true),
            items: [{ label: 'Add event', icon: 'calendar-event', onClick: () => setAddingEvent(true) }],
            trash: { path: location.path, name: location.name, leaveTo: '/locations' },
          }
          : undefined}
      />

      {
        /* The body pads itself (AppShell's padding is off so the header can bleed); the
          variable tells the media tab's grid how much to cancel on a phone. */
      }
      <Container size='xl' py='md' px='md' style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <Stack gap='lg'>
          {saveError && (
            <Text c='red' size='sm'>
              {saveError}
            </Text>
          )}

          <Tabs.Panel value='info'>
            <Grid>
              <Grid.Col span={{ base: 12, md: 8 }}>
                <Card radius='md' p={0} style={{ overflow: 'hidden' }}>
                  <Box h={480}>
                    <MapView center={location.shape ?? undefined} zoom={location.shape ? 15 : undefined} bounds={bounds}>
                      {location.shape && <MapShape shape={location.shape} fit />}
                      {markers.length > 0 && <MapMarkers markers={markers} />}
                    </MapView>
                  </Box>
                  {showCandidates && (
                    <Group justify='space-between' wrap='nowrap' p='xs' gap='xs'>
                      <Text c='dimmed' size='xs'>
                        {candidates.length} suggested location{candidates.length === 1 ? '' : 's'}.
                        {editable ? ' Click the numbered pin that looks right, or pick it from the list.' : ''}
                      </Text>
                      {editable && (
                        <Button size='compact-xs' variant='subtle' onClick={() => setEditing(true)} style={{ flexShrink: 0 }}>
                          None of these
                        </Button>
                      )}
                    </Group>
                  )}
                  {!location.shape && !showCandidates && (
                    <Group justify='space-between' wrap='nowrap' p='sm' gap='xs'>
                      <Text c='dimmed' size='sm'>No location set yet.</Text>
                      {editable && (
                        <Button
                          size='compact-xs'
                          variant='light'
                          leftSection={<TablerIcon name='map-pin' size={14} />}
                          onClick={() => setEditing(true)}
                          style={{ flexShrink: 0 }}
                        >
                          Location on map
                        </Button>
                      )}
                    </Group>
                  )}
                </Card>
              </Grid.Col>

              <Grid.Col span={{ base: 12, md: 4 }}>
                <Stack gap='md'>
                  <Card radius='md'>
                    <Title order={3} size='h4' mb='sm'>
                      Details
                    </Title>
                    <Stack gap='xs'>
                      {location.address && (
                        <Group gap='xs' wrap='nowrap' align='flex-start'>
                          <TablerIcon name='map-pin' size={16} color='gray' style={{ flexShrink: 0, marginTop: 3 }} />
                          <Text size='sm' c='dimmed' style={{ whiteSpace: 'pre-line' }}>
                            {location.address}
                          </Text>
                        </Group>
                      )}
                      {location.displayName && location.displayName !== location.address && (
                        <Text size='xs' c='dimmed'>
                          {location.displayName}
                        </Text>
                      )}
                      {(location.city || location.country) && (
                        <Text size='sm' c='dimmed'>
                          {[location.city, location.country].filter(Boolean).join(', ')}
                        </Text>
                      )}
                      {location.description && <UserText text={location.description} size='sm' />}
                      {location.shape && (
                        <Text size='xs' c='dimmed'>
                          {location.shape.polygon
                            ? `Polygon, ${location.shape.polygon.length} points`
                            : location.shape.radius
                            ? `${location.shape.lat.toFixed(5)}, ${location.shape.lng.toFixed(5)} · radius ${Math.round(location.shape.radius)} m`
                            : `${location.shape.lat.toFixed(5)}, ${location.shape.lng.toFixed(5)}`}
                        </Text>
                      )}
                      {location.shape && location.locationSource && (
                        // How the position was arrived at, so a wrong pin can be
                        // argued with: media points are measured, an address is not.
                        <Text size='xs' c='dimmed'>
                          {location.locationSource === 'manual'
                            ? 'Set by hand'
                            : location.locationSource === 'media-centroid'
                            ? `Derived from ${location.locationPoints ?? 0} geotagged photo${location.locationPoints === 1 ? '' : 's'}` +
                              (location.locationSpread !== undefined ? ` spread over ${location.locationSpread} m` : '')
                            : 'Geocoded from the address'}
                        </Text>
                      )}
                    </Stack>
                  </Card>

                  <CurrentPeopleCard
                    title='Current residents'
                    people={residents}
                    emptyText={residents.length > 0 ? 'Nobody lives here now, as far as the archive knows.' : 'No known residents.'}
                    onShowAll={() => setTab('residents')}
                    showAllLabel='All residents'
                  />

                  {showCandidates && (
                    <Card withBorder={editable} radius='md'>
                      <Title order={3} size='h4' mb={4}>
                        Suggested locations
                      </Title>
                      <Text size='xs' c='dimmed' mb='sm'>
                        Geocoding was not confident enough to place this automatically. Pick the right one, or set it by hand.
                      </Text>
                      <Stack gap={4}>
                        {candidates.map((candidate, index) => (
                          <UnstyledButton
                            key={`${candidate.lat},${candidate.lng},${index}`}
                            disabled={!editable || saving}
                            onClick={() => editable && !saving && chooseCandidate(candidate)}
                            onMouseEnter={() => setActiveCandidate(index)}
                            onMouseLeave={() => setActiveCandidate(null)}
                            p={4}
                            style={{
                              borderRadius: 6,
                              // The same highlight the pin takes, so hovering either
                              // half says which map pin this row is.
                              background: activeCandidate === index ? 'var(--mantine-color-yellow-light)' : undefined,
                            }}
                          >
                            <Group gap='xs' wrap='nowrap' align='flex-start'>
                              <Badge
                                size='sm'
                                circle
                                variant='filled'
                                color={activeCandidate === index ? 'yellow' : 'marine'}
                                style={{ flexShrink: 0, marginTop: 2 }}
                              >
                                {index + 1}
                              </Badge>
                              <Box style={{ minWidth: 0 }}>
                                <Text size='sm' lineClamp={2}>
                                  {candidate.displayName}
                                </Text>
                                <Text size='xs' c='dimmed'>
                                  {candidate.type} · {candidate.lat.toFixed(5)}, {candidate.lng.toFixed(5)}
                                </Text>
                              </Box>
                            </Group>
                          </UnstyledButton>
                        ))}
                      </Stack>
                      {editable && (
                        <Button
                          size='xs'
                          variant='default'
                          mt='sm'
                          fullWidth
                          leftSection={<TablerIcon name='map-pin' size={14} />}
                          onClick={() => setEditing(true)}
                        >
                          None of these — place it by hand
                        </Button>
                      )}
                    </Card>
                  )}
                </Stack>
              </Grid.Col>
            </Grid>
          </Tabs.Panel>

          <Tabs.Panel value='timeline'>
            <TimelineFeed
              groups={groups}
              loading={feedLoading}
              hasMore={false}
              hasNewer={false}
              sentinelRef={noSentinel}
              topSentinelRef={noSentinel}
              emptyMessage={`Nothing recorded at ${location.name} yet. Residents with dates, and albums with photos taken here, appear on its timeline.`}
            />
          </Tabs.Panel>

          <Tabs.Panel value='media'>
            <MediaTimeline
              location={location.id}
              emptyMessage={location.shape
                ? 'No photos here yet. Geotagged photos inside its area are linked to it automatically.'
                : 'No photos here yet. Once it has a location, geotagged photos inside its area are linked to it automatically.'}
              selectionActions={({ selection, items, reload }) => <SetTimeAction selection={selection} items={items} onApplied={reload} />}
            />
          </Tabs.Panel>

          <Tabs.Panel value='residents'>
            <LocationResidentsTab
              location={location}
              residents={residents}
              editable={editable}
              onApplied={() => {
                refetch();
                refetchFeed();
              }}
            />
          </Tabs.Panel>
        </Stack>
      </Container>

      <LocationEditModal
        opened={editing}
        onClose={() => setEditing(false)}
        location={location}
        saveShape={saveShape}
        onApplied={() => {
          refetch();
          refetchFeed();
        }}
      />
      <EventModal
        ownerPath={location.path}
        ownerName={location.name}
        genericOnly
        opened={addingEvent}
        onClose={() => setAddingEvent(false)}
        onApplied={refetchFeed}
      />
    </Tabs>
  );
}
