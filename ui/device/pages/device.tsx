import { Alert, Anchor, Badge, Button, Card, Code, Container, Grid, Stack, Tabs, Text, Title } from '@mantine/core';
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
import { DeviceOwnersTab } from '../components/DeviceOwnersTab.tsx';
import { TrackView } from '../../location/components/TrackView.tsx';
import { useDevice } from '../hooks/useDevice.ts';
import { type CSSProperties, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CurrentPeopleCard, CurrentPeopleLine } from '../../components/CurrentPeople.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { UserText } from '../../components/UserText.tsx';

const TABS = ['info', 'timeline', 'media', 'track', 'owners'] as const;
type DeviceTab = typeof TABS[number];

const isTab = (value: string | null): value is DeviceTab => value !== null && (TABS as readonly string[]).includes(value);

/** The feed here does not page, so the sentinels have nothing to observe. */
const noSentinel = () => {};

/** A recorded setting. Absent rather than blank when there is nothing to show. */
/** One labelled fact; `written` for text a person wrote, shown as Markdown. */
function InfoRow({ label, value, written = false }: { label: string; value?: string; written?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <Text size='xs' c='dimmed'>{label}</Text>
      {written ? <UserText text={value} size='sm' /> : <Text size='sm' style={{ whiteSpace: 'pre-line' }}>{value}</Text>}
    </div>
  );
}

/** The device's photographic header runs edge to edge. */
export const handle = { fullBleed: true };

export default function DeviceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { device, owners, loading, save, addOwner, removeOwner, relink } = useDevice(id);
  const access = useAccessIds();

  // Settings are what a device page is mostly for, so it opens on them.
  const tab: DeviceTab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as DeviceTab : 'info';
  const setTab = (value: string | null) => setSearchParams(value && value !== 'info' ? { tab: value } : {}, { replace: true });

  const [editing, setEditing] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Computed before the early returns: hooks cannot be skipped.
  const editable = device ? canWrite(device.ownership, access) : false;
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
            <Tabs.Tab value='timeline' leftSection={<TablerIcon name='calendar-event' size={16} />}>Timeline</Tabs.Tab>
            <Tabs.Tab value='media' leftSection={<TablerIcon name='photo' size={16} />}>Media</Tabs.Tab>
            <Tabs.Tab value='track' leftSection={<TablerIcon name='route' size={16} />}>Track</Tabs.Tab>
            <Tabs.Tab value='owners' leftSection={<TablerIcon name='users' size={16} />}>Owners</Tabs.Tab>
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
                {facets.range ? ` · ${facets.range.min}–${facets.range.max}` : ''}
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
            <Grid>
              <Grid.Col span={{ base: 12, md: 7 }}>
                <Stack gap='md'>
                  <Card radius='md'>
                    <Title order={3} size='h4' mb='sm'>
                      Settings
                    </Title>

                    <Stack gap='xs'>
                      <InfoRow label='Make' value={device.make} />
                      <InfoRow label='Model' value={device.model} />
                      <InfoRow label='Serial number' value={device.serial} />
                      <InfoRow label='Timezone' value={device.timezone} />
                      {device.digitizer && (
                        <div>
                          <Text size='xs' c='dimmed'>Capture dates</Text>
                          <Badge size='sm' variant='light' color='yellow'>Scanner dates suppressed</Badge>
                        </div>
                      )}
                      {device.quicktimeUtc && (
                        <div>
                          <Text size='xs' c='dimmed'>Video times</Text>
                          <Badge size='sm' variant='light' color='gray'>UTC</Badge>
                        </div>
                      )}
                      <InfoRow label='Description' value={device.description} written />
                      {!device.make && !device.model && !device.serial && !device.timezone && !device.digitizer && !device.quicktimeUtc && !device.description && (
                        <Text size='sm' c='dimmed'>Nothing recorded beyond the name.</Text>
                      )}
                      {!matchable && (
                        <Text size='xs' c='yellow'>
                          No serial and no make/model — nothing is matched to this device automatically; <Code>device-link --device</Code> links files to it by hand.
                        </Text>
                      )}
                    </Stack>
                  </Card>

                  {editable && matchable && (
                    <Card radius='md'>
                      <Title order={3} size='h4' mb={4}>
                        Link existing media
                      </Title>
                      <Text size='xs' c='dimmed' mb='sm'>
                        Files are linked to their device when they are indexed. A camera registered afterwards leaves its older photos unclaimed; this finds them by
                        fingerprint and attaches them.
                      </Text>
                      <Button size='xs' variant='light' fullWidth leftSection={<TablerIcon name='link' size={14} />} loading={busy} onClick={runRelink}>
                        Link existing media
                      </Button>
                    </Card>
                  )}
                </Stack>
              </Grid.Col>

              <Grid.Col span={{ base: 12, md: 5 }}>
                <CurrentPeopleCard
                  title='Current owners'
                  people={owners}
                  emptyText={owners.length > 0 ? 'Nobody owns it now, as far as the archive knows.' : 'Nobody is recorded as owning this.'}
                  onShowAll={() => setTab('owners')}
                  showAllLabel='All owners'
                />
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
              emptyMessage={`Nothing recorded for ${device.name} yet. Owners with dates, and albums with photos it took, appear on its timeline.`}
            />
          </Tabs.Panel>

          <Tabs.Panel value='media'>
            <MediaTimeline
              device={device.path}
              emptyMessage={matchable
                ? 'Nothing is linked to this device yet. If it was registered after the media was indexed, use “Link existing media”.'
                : 'Nothing is linked to this device yet, and nothing can be: give it a serial number, or both a make and a model.'}
              selectionActions={({ selection, items, reload }) => <SetTimeAction selection={selection} items={items} onApplied={reload} />}
            />
          </Tabs.Panel>

          <Tabs.Panel value='track'>
            <TrackView device={device.id} editable={editable} />
          </Tabs.Panel>

          <Tabs.Panel value='owners'>
            <DeviceOwnersTab device={device} owners={owners} editable={editable} setOwner={setOwner} removeOwner={dropOwner} />
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
