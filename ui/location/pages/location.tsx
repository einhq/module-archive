import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { TimelineFeed } from '../../components/TimelineFeed.tsx';
import { EntityDetailHeader, FillWindow, PageLoader, TablerIcon } from '@ein/ui/components';
import { Anchor, Container, Grid, Stack, Tabs, Text } from '@mantine/core';
import { EventModal } from '../../people/components/EventModal.tsx';
import { LocationEditModal } from '../components/LocationEditModal.tsx';
import { LocationInfo } from '../components/LocationInfo.tsx';
import { LocationMap } from '../components/LocationMap.tsx';
import { StaticMap } from '../components/StaticMap.tsx';
import { useLocationDetail } from '../hooks/useLocationDetail.ts';
import { useSubjectTimeline } from '../../hooks/useSubjectTimeline.ts';
import { useSubjectFacets } from '../../hooks/useSubjectFacets.ts';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite, subjectArg } from '@ein/ui/lib';
import { type CSSProperties, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CurrentPeopleLine } from '../../components/CurrentPeople.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';

const TABS = ['info', 'map', 'media'] as const;
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

  // What is known about the place, its history beside it, is what the page opens on; the map and
  // the media are linkable the same way a person's tabs are.
  const tab: LocationTab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as LocationTab : 'info';
  const setTab = (value: string | null) => setSearchParams(value && value !== 'info' ? { tab: value } : {}, { replace: true });

  const { groups, loading: feedLoading, refetch: refetchFeed } = useSubjectTimeline('location-timeline', location?.path ?? null);
  // The question the media tab's rail is sized from, so the two counts agree.
  const facetFilters = useMemo(() => ({ subjects: id ? [subjectArg('location', id)] : undefined }), [id]);
  const { facets } = useSubjectFacets(facetFilters, Boolean(id));

  const [editing, setEditing] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);

  // An edit or a resident changes the header and the timeline both.
  const changed = () => {
    refetch();
    refetchFeed();
  };

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

  const editable = canWrite(location.ownership, access);

  // `keepMounted={false}`: the media tab is the expensive one, and a Leaflet map
  // mounted in a hidden panel measures itself as zero-sized.
  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
            <Tabs.Tab value='map' leftSection={<TablerIcon name='map' size={16} />}>Map</Tabs.Tab>
            <Tabs.Tab value='media' leftSection={<TablerIcon name='photo' size={16} />}>Media</Tabs.Tab>
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
          variable tells the media tab's grid how much to cancel on a phone. The map has none. */
      }
      <Container
        size='xl'
        py='md'
        px='md'
        display={tab === 'map' ? 'none' : undefined}
        style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}
      >
        <Tabs.Panel value='info'>
          {/* What is known about the place comes first on a phone, above the timeline that can run long. */}
          <Grid gap='lg'>
            <Grid.Col span={{ base: 12, md: 7 }} order={{ base: 2, md: 1 }}>
              <TimelineFeed
                groups={groups}
                loading={feedLoading}
                hasMore={false}
                hasNewer={false}
                sentinelRef={noSentinel}
                topSentinelRef={noSentinel}
                emptyMessage={`Nothing recorded at ${location.name} yet. Residents with dates, and albums with photos taken here, appear on its timeline.`}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 5 }} order={{ base: 1, md: 2 }}>
              <LocationInfo
                location={location}
                residents={residents}
                editable={editable}
                media={facets ? { total: facets.total, truncated: facets.truncated, range: facets.range } : undefined}
                onShowMap={() => setTab('map')}
                onEdit={() => setEditing(true)}
                onResidentsChanged={changed}
              />
            </Grid.Col>
          </Grid>
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
      </Container>

      {/* The map takes the window below the header, edge to edge, outside the body's padding. */}
      <Tabs.Panel value='map'>
        <FillWindow>
          <LocationMap location={location} editable={editable} onEdit={() => setEditing(true)} acceptCandidate={acceptCandidate} />
        </FillWindow>
      </Tabs.Panel>

      <LocationEditModal
        opened={editing}
        onClose={() => setEditing(false)}
        location={location}
        saveShape={saveShape}
        onApplied={changed}
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
