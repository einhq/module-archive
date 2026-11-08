import { Alert, Anchor, Button, Container, Grid, Group, Stack, Tabs, Text } from '@mantine/core';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { TimelineFeed } from '../../components/TimelineFeed.tsx';
import { Dialog, EntityDetailHeader, PageLoader, TablerIcon } from '@ein/ui/components';
import { forgetSubjectFacets, useSubjectFacets } from '../../hooks/useSubjectFacets.ts';
import { useSubjectTimeline } from '../../hooks/useSubjectTimeline.ts';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite, subjectArg } from '@ein/ui/lib';
import { EventModal } from '../../people/components/EventModal.tsx';
import { CameraEditModal } from '../components/CameraEditModal.tsx';
import { CameraInfo } from '../components/CameraInfo.tsx';
import { CameraTripsTab } from '../components/CameraTripsTab.tsx';
import { TrackView } from '../../location/components/TrackView.tsx';
import { useHasTrack } from '../../location/hooks/useTracks.ts';
import { useTrackUpload } from '../../location/hooks/useTrackUpload.tsx';
import { TrackerSetup } from '../components/TrackerSetup.tsx';
import { useCamera } from '../hooks/useCamera.ts';
import { type CSSProperties, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CurrentPeopleLine } from '../../components/CurrentPeople.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { yearSpan } from '../../lib/year-span.ts';

const TABS = ['info', 'media', 'track', 'trips'] as const;
type CameraTab = typeof TABS[number];

const isTab = (value: string | null): value is CameraTab => value !== null && (TABS as readonly string[]).includes(value);

/** The tabs only a camera that travels has. */
const TRAVEL_TABS: readonly CameraTab[] = ['track', 'trips'];

/** The feed here does not page, so the sentinels have nothing to observe. */
const noSentinel = () => {};

/** The camera's photographic header runs edge to edge. */
export const handle = { fullBleed: true };

export default function CameraDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { camera, owners, loading, save, addOwner, removeOwner, relink } = useCamera(id);
  const access = useAccessIds();
  const hasTrack = useHasTrack(id);

  // A camera travels once it is said how (`kind`) or it has recorded a track; only then do a
  // track and trips have anything to show.
  const travels = Boolean(camera?.kind) || hasTrack === true;

  // What is known about the camera, its history beside it, is what the page opens on; the other
  // tabs are linkable. A travel tab asked of a camera that does not travel opens Info.
  const asked = searchParams.get('tab');
  const tab: CameraTab = isTab(asked) && (travels || !TRAVEL_TABS.includes(asked)) ? asked : 'info';
  const setTab = (value: string | null) => setSearchParams(value && value !== 'info' ? { tab: value } : {}, { replace: true });

  const [editing, setEditing] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [tracking, setTracking] = useState(false);
  // Raised by an upload, so the Track tab reads the track again.
  const [trackRead, setTrackRead] = useState(0);
  const upload = useTrackUpload(id ?? '', () => setTrackRead((n) => n + 1));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Computed before the early returns: hooks cannot be skipped.
  const facetFilters = useMemo(() => ({ subjects: camera ? [subjectArg('camera', camera.path)] : undefined }), [camera?.path]);
  const { facets } = useSubjectFacets(facetFilters, Boolean(camera));
  const { groups, loading: feedLoading, refetch: refetchFeed } = useSubjectTimeline('camera-timeline', camera?.path ?? null);

  // Only the first load: an owner change re-reads the camera, and swapping the
  // page for a loader then would lose the tab being worked in.
  if (loading && !camera) {
    return <PageLoader label='Loading camera…' />;
  }

  if (!camera) {
    return (
      <Container size='xl' py='md'>
        <Stack gap='lg'>
          <Anchor onClick={() => navigate('/cameras')} c='dimmed' size='sm'>
            ← Cameras
          </Anchor>
          <Text c='dimmed'>Camera not found.</Text>
        </Stack>
      </Container>
    );
  }

  const editable = canWrite(camera.ownership, access);
  // Recording a track is for a camera that is said to travel, by whoever may change it.
  const records = editable && Boolean(camera.kind);

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
          : 'Nothing new to link or update — every matching file already has this camera policy.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const matchable = Boolean(camera.serial || (camera.make && camera.model));

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
        path={camera.path}
        pattern='camera'
        title={camera.name}
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
            <NodeLabels path={camera.path} mt={4} />
          </>
        }
        actions={editable
          ? {
            share: camera.path,
            edit: () => setEditing(true),
            items: [
              ...(records
                ? [{ label: upload.sending ? 'Uploading GPX…' : 'Upload GPX', icon: 'upload', button: true, lead: true, disabled: upload.sending, onClick: upload.open }]
                : []),
              { label: 'Add event', icon: 'calendar-event', onClick: () => setAddingEvent(true) },
              ...(records ? [{ label: 'Live tracking', icon: 'broadcast', onClick: () => setTracking(true) }] : []),
            ],
            trash: { path: camera.path, name: camera.name, leaveTo: '/cameras' },
          }
          : undefined}
      />

      {
        /* The body pads itself (AppShell's padding is off so the header can bleed); the
          variable tells the media tab's grid how much to cancel on a phone. The track has none. */
      }
      <Container
        size='xl'
        py='md'
        px='md'
        display={tab === 'track' ? 'none' : undefined}
        style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}
      >
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
            {/* What is known about the camera comes first on a phone, above the timeline that can run long. */}
            <Grid gap='lg'>
              <Grid.Col span={{ base: 12, md: 7 }} order={{ base: 2, md: 1 }}>
                <TimelineFeed
                  groups={groups}
                  loading={feedLoading}
                  hasMore={false}
                  hasNewer={false}
                  sentinelRef={noSentinel}
                  topSentinelRef={noSentinel}
                  emptyMessage={`Nothing recorded for ${camera.name} yet. Owners with dates, and albums with photos it took, appear on its timeline.`}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 5 }} order={{ base: 1, md: 2 }}>
                <CameraInfo
                  camera={camera}
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
              camera={camera.path}
              emptyMessage={matchable
                ? 'Nothing is linked to this camera yet: no file carries its make and model or serial number. If files from it are missing, “Link existing media” on its Info tab looks again.'
                : 'Nothing is linked to this camera yet, and nothing can be: give it a serial number, or both a make and a model.'}
              selectionActions={({ selection, items, reload }) => <SetTimeAction selection={selection} items={items} onApplied={reload} />}
            />
          </Tabs.Panel>

          <Tabs.Panel value='trips'>
            <CameraTripsTab camera={camera.path} editable={editable} />
          </Tabs.Panel>
        </Stack>
      </Container>

      {/* The track's map takes the window below the header, edge to edge, outside the body's padding. */}
      <Tabs.Panel value='track'>
        <TrackView
          key={trackRead}
          camera={camera.id}
          kind={camera.kind}
          editable={editable}
          emptyActions={records && (
            <Group gap='xs' justify='center'>
              <Button variant='light' leftSection={<TablerIcon name='upload' size={16} />} loading={upload.sending} onClick={upload.open}>Upload GPX</Button>
              <Button variant='default' leftSection={<TablerIcon name='broadcast' size={16} />} onClick={() => setTracking(true)}>Live tracking</Button>
            </Group>
          )}
        />
      </Tabs.Panel>

      <CameraEditModal
        opened={editing}
        onClose={() => setEditing(false)}
        camera={camera}
        save={save}
        onSaved={(note) => {
          setError(null);
          setMessage(note ?? null);
        }}
      />
      {records && upload.input}
      {records && (
        <Dialog
          opened={tracking}
          onClose={() => setTracking(false)}
          title='Live tracking from a phone'
          subtitle={camera.name}
          icon='broadcast'
          pattern='camera'
          size='lg'
        >
          <TrackerSetup camera={camera.id} />
        </Dialog>
      )}
      <EventModal
        ownerPath={camera.path}
        ownerName={camera.name}
        genericOnly
        opened={addingEvent}
        onClose={() => setAddingEvent(false)}
        onApplied={refetchFeed}
      />
    </Tabs>
  );
}
