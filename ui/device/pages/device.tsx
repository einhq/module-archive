import { Alert, Anchor, Container, Grid, Stack, Tabs, Text } from '@mantine/core';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { TimelineFeed } from '../../components/TimelineFeed.tsx';
import { EntityDetailHeader, PageLoader, TablerIcon } from '@ein/ui/components';
import { forgetSubjectFacets, useSubjectFacets } from '../../hooks/useSubjectFacets.ts';
import { useSubjectTimeline } from '../../hooks/useSubjectTimeline.ts';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite, subjectArg } from '@ein/ui/lib';
import { EventModal } from '../../people/components/EventModal.tsx';
import { DeviceEditModal } from '../components/DeviceEditModal.tsx';
import { DeviceInfo } from '../components/DeviceInfo.tsx';
import { DeviceTripsTab } from '../components/DeviceTripsTab.tsx';
import { TrackView } from '../../location/components/TrackView.tsx';
import { useHasTrack } from '../../location/hooks/useTracks.ts';
import { TrackerSetup } from '../components/TrackerSetup.tsx';
import { useDevice } from '../hooks/useDevice.ts';
import { type CSSProperties, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CurrentPeopleLine } from '../../components/CurrentPeople.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { yearSpan } from '../../lib/year-span.ts';

const TABS = ['info', 'media', 'track', 'trips'] as const;
type DeviceTab = typeof TABS[number];

const isTab = (value: string | null): value is DeviceTab => value !== null && (TABS as readonly string[]).includes(value);

/** The tabs only a device that travels has. */
const TRAVEL_TABS: readonly DeviceTab[] = ['track', 'trips'];

/** The feed here does not page, so the sentinels have nothing to observe. */
const noSentinel = () => {};

/** The device's photographic header runs edge to edge. */
export const handle = { fullBleed: true };

export default function DeviceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { device, owners, loading, save, addOwner, removeOwner, relink } = useDevice(id);
  const access = useAccessIds();
  const hasTrack = useHasTrack(id);

  // A device travels once it is said how (`kind`) or it has recorded a track; only then do a
  // track and trips have anything to show.
  const travels = Boolean(device?.kind) || hasTrack === true;

  // What is known about the device, its history beside it, is what the page opens on; the other
  // tabs are linkable. A travel tab asked of a device that does not travel opens Info.
  const asked = searchParams.get('tab');
  const tab: DeviceTab = isTab(asked) && (travels || !TRAVEL_TABS.includes(asked)) ? asked : 'info';
  const setTab = (value: string | null) => setSearchParams(value && value !== 'info' ? { tab: value } : {}, { replace: true });

  const [editing, setEditing] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Computed before the early returns: hooks cannot be skipped.
  const facetFilters = useMemo(() => ({ subjects: device ? [subjectArg('device', device.path)] : undefined }), [device?.path]);
  const { facets } = useSubjectFacets(facetFilters, Boolean(device));
  const { groups, loading: feedLoading, refetch: refetchFeed } = useSubjectTimeline('device-timeline', device?.path ?? null);

  // Only the first load: an owner change re-reads the device, and swapping the
  // page for a loader then would lose the tab being worked in.
  if (loading && !device) {
    return <PageLoader label='Loading device…' />;
  }

  if (!device) {
    return (
      <Container size='xl' py='md'>
        <Stack gap='lg'>
          <Anchor onClick={() => navigate('/devices')} c='dimmed' size='sm'>
            ← Devices
          </Anchor>
          <Text c='dimmed'>Device not found.</Text>
        </Stack>
      </Container>
    );
  }

  const editable = canWrite(device.ownership, access);

  const runRelink = async () => {
    try {
      setBusy(true);
      setError(null);
      setMessage(null);
      const result = await relink();
      forgetSubjectFacets();
      setMessage(
        result.linked > 0 || result.retimed > 0
          ? [
            result.linked > 0 ? `Linked ${result.linked.toLocaleString()} file${result.linked === 1 ? '' : 's'}` : '',
            result.retimed > 0 ? `updated dates on ${result.retimed.toLocaleString()}` : '',
          ].filter(Boolean).join(' and ') + '.'
          : 'Nothing new to link or update — every matching file already has this device policy.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const matchable = Boolean(device.serial || (device.make && device.model));

  // Ownership is on the timeline, so it is re-read along with the owners.
  const setOwner = async (personPath: string, span: { from?: string; to?: string }, update?: boolean) => {
    await addOwner(personPath, span, update);
    refetchFeed();
  };
  const dropOwner = async (personId: string) => {
    await removeOwner(personId);
    refetchFeed();
  };

  // `keepMounted={false}`: the media tab is the expensive one.
  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
            <Tabs.Tab value='media' leftSection={<TablerIcon name='photo' size={16} />}>Media</Tabs.Tab>
            {travels && <Tabs.Tab value='track' leftSection={<TablerIcon name='route' size={16} />}>Track</Tabs.Tab>}
            {travels && <Tabs.Tab value='trips' leftSection={<TablerIcon name='map-route' size={16} />}>Trips</Tabs.Tab>}
          </Tabs.List>
        }
        path={device.path}
        pattern='device'
        title={device.name}
        fallback={<TablerIcon name='device-camera-phone' size={52} />}
        meta={
          <>
            <CurrentPeopleLine people={owners} label='Current owners' />
            {facets && facets.total > 0 && (
              <Text size='sm' c='dimmed'>
                {
                  /* The count stops at the command's scan limit, so past it this
                  is a floor and has to read as one. */
                }
                {facets.total.toLocaleString()}
                {facets.truncated ? '+' : ''} file{facets.total === 1 ? '' : 's'}
                {facets.range ? ` · ${yearSpan(facets.range)}` : ''}
              </Text>
            )}
            <NodeLabels path={device.path} mt={4} />
          </>
        }
        actions={editable
          ? {
            share: device.path,
            edit: () => setEditing(true),
            items: [{ label: 'Add event', icon: 'calendar-event', onClick: () => setAddingEvent(true) }],
            trash: { path: device.path, name: device.name, leaveTo: '/devices' },
          }
          : undefined}
      />

      {
        /* The body pads itself (AppShell's padding is off so the header can bleed); the
          variable tells the media tab's grid how much to cancel on a phone. */
      }
      <Container size='xl' py='md' px='md' style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <Stack gap='lg'>
          {error && (
            <Alert icon={<TablerIcon name='alert-circle' size={16} />} color='red'>
              {error}
            </Alert>
          )}
          {message && (
            <Alert color='marine' variant='light' withCloseButton onClose={() => setMessage(null)}>
              {message}
            </Alert>
          )}

          <Tabs.Panel value='info'>
            {/* What is known about the device comes first on a phone, above the timeline that can run long. */}
            <Grid gap='lg'>
              <Grid.Col span={{ base: 12, md: 7 }} order={{ base: 2, md: 1 }}>
                <TimelineFeed
                  groups={groups}
                  loading={feedLoading}
                  hasMore={false}
                  hasNewer={false}
                  sentinelRef={noSentinel}
                  topSentinelRef={noSentinel}
                  emptyMessage={`Nothing recorded for ${device.name} yet. Owners with dates, and albums with photos it took, appear on its timeline.`}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 5 }} order={{ base: 1, md: 2 }}>
                <DeviceInfo
                  device={device}
                  owners={owners}
                  editable={editable}
                  travels={travels}
                  setOwner={setOwner}
                  removeOwner={dropOwner}
                  onRelink={runRelink}
                  relinking={busy}
                />
              </Grid.Col>
            </Grid>
          </Tabs.Panel>

          <Tabs.Panel value='media'>
            <MediaTimeline
              device={device.path}
              emptyMessage={matchable
                ? 'Nothing is linked to this device yet: no file carries its make and model or serial number. If they changed since it was registered, use “Link existing media” on its Info tab.'
                : 'Nothing is linked to this device yet, and nothing can be: give it a serial number, or both a make and a model.'}
              selectionActions={({ selection, items, reload }) => <SetTimeAction selection={selection} items={items} onApplied={reload} />}
            />
          </Tabs.Panel>

          <Tabs.Panel value='track'>
            <Stack gap='lg'>
              <TrackView device={device.id} kind={device.kind} editable={editable} />
              {editable && <TrackerSetup device={device.id} />}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value='trips'>
            <DeviceTripsTab device={device.path} editable={editable} />
          </Tabs.Panel>
        </Stack>
      </Container>

      <DeviceEditModal
        opened={editing}
        onClose={() => setEditing(false)}
        device={device}
        save={save}
        onSaved={(note) => {
          setError(null);
          setMessage(note ?? null);
        }}
      />
      <EventModal
        ownerPath={device.path}
        ownerName={device.name}
        genericOnly
        opened={addingEvent}
        onClose={() => setAddingEvent(false)}
        onApplied={refetchFeed}
      />
    </Tabs>
  );
}
