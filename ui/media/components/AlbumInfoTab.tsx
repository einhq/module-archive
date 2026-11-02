import { CoverAvatar, formatRange, TablerIcon } from '@ein/ui/components';
import { ActionIcon, Anchor, Badge, Button, Group, Loader, SimpleGrid, Text, Tooltip } from '@mantine/core';
import { countOf, paramsFromFilters, type SearchFilters, subjectArg } from '@ein/ui/lib';
import type { AlbumDevice, SubjectTally } from '@archive/media/api';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EntityPicker } from '../../components/EntityPicker.tsx';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';
import { useDevices } from '../../device/hooks/useDevices.ts';
import { useAlbumDevices } from '../hooks/useAlbumDevices.ts';
import { useContainerSubjects } from '../hooks/useContainerSubjects.ts';

type AlbumInfoTabProps = {
  path: string;
  /** Whether the reader may change the album's list of devices: an album they may write. */
  editable: boolean;
  title: string;
  description?: string;
  timeStart?: string;
  timeEnd?: string;
  /** What the album holds by kind, and the labels its media carry; absent while they load. */
  facets?: { kinds: { kind: string; count: number }[]; labels: { label: string; count: number }[] } | null;
};

/** How a kind of media is counted. */
const KIND_WORDS: Record<string, [string, string]> = {
  photo: ['photo', 'photos'],
  video: ['video', 'videos'],
  audio: ['recording', 'recordings'],
  document: ['document', 'documents'],
};

/** Rows a list shows before it is opened in full. */
const SHOWN = 10;

/** Where a subject's own page is, by the root it is under. */
const ROUTES: Record<string, string> = { person: '/people', location: '/locations', device: '/devices' };

const ICONS: Record<string, string> = { person: 'user', location: 'map-pin', device: 'device-camera-phone' };

const slugOf = (path: string): string => encodeURIComponent(path.split('/').pop() ?? path);

/** A search of this album's media, narrowed by `filters`. */
const searchIn = (under: string, filters: SearchFilters): string => `/search?${paramsFromFilters({ ...filters, under })}`;

/**
 * The subjects of one kind, the most counted first: each opens its page, and its count the album's
 * media that have it, when `search` can ask for that (`subject`).
 */
function SubjectList({ under, kind, rows, subject }: { under: string; kind: 'person' | 'location'; rows: SubjectTally[]; subject: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <>
      {shown.map((row) => (
        <Group key={row.path} gap='sm' wrap='nowrap' justify='space-between'>
          <Group gap='sm' wrap='nowrap' style={{ minWidth: 0 }}>
            <CoverAvatar path={row.path} size={28} radius='xl' alt='' fallback={<TablerIcon name={ICONS[kind]} size={16} />} />
            <Anchor component={Link} to={`${ROUTES[kind]}/${slugOf(row.path)}`} size='sm' truncate>{row.name}</Anchor>
          </Group>
          {subject
            ? (
              <Anchor component={Link} to={searchIn(under, { subjects: [subjectArg(kind, row.path)] })} size='xs' c='dimmed' style={{ flexShrink: 0 }}>
                {row.count.toLocaleString()}
              </Anchor>
            )
            : <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{row.count.toLocaleString()}</Text>}
        </Group>
      ))}
      {rows.length > SHOWN && (
        <Button variant='subtle' size='compact-xs' onClick={() => setAll(!all)} style={{ alignSelf: 'flex-start' }}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}
    </>
  );
}

/** One device on the album's list, or removed from it: its page, then its media or how it got there, then the change offered. */
function DeviceRow({ under, device, action }: { under: string; device: AlbumDevice; action?: { label: string; icon: string; run: () => void } }) {
  return (
    <Group gap='sm' wrap='nowrap' justify='space-between'>
      <Group gap='sm' wrap='nowrap' style={{ minWidth: 0 }}>
        <CoverAvatar path={device.path} size={28} radius='xl' alt='' fallback={<TablerIcon name={ICONS.device} size={16} />} />
        <Anchor component={Link} to={`${ROUTES.device}/${slugOf(device.path)}`} size='sm' truncate>{device.name}</Anchor>
      </Group>
      <Group gap='xs' wrap='nowrap' style={{ flexShrink: 0 }}>
        {device.source === 'media'
          ? (
            <Anchor component={Link} to={searchIn(under, { subjects: [subjectArg('device', device.path)] })} size='xs' c='dimmed'>
              {device.media.toLocaleString()}
            </Anchor>
          )
          : <Text size='xs' c='dimmed'>added</Text>}
        {action && (
          <Tooltip label={action.label}>
            <ActionIcon variant='subtle' size='sm' color='gray' aria-label={`${action.label}: ${device.name}`} onClick={action.run}>
              <TablerIcon name={action.icon} size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  );
}

/** Every registered device not on the list, to add one; the registry is read only where this is offered. */
function AddDevice({ listed, onAdd }: { listed: AlbumDevice[]; onAdd: (device: string) => void }) {
  const { devices } = useDevices();
  const options = useMemo(() => {
    const on = new Set(listed.map((device) => device.path));
    return devices
      .filter((device) => !on.has(device.path))
      .map((device) => ({ value: device.path, label: device.name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'sv'));
  }, [listed, devices]);
  return (
    <EntityPicker
      kind='device'
      size='xs'
      mt='xs'
      placeholder='Add a device to the map'
      data={options}
      value={null}
      onChange={(device) => device && onAdd(device)}
    />
  );
}

/**
 * The devices whose routes the album's map draws (`album-device-list`): those that took its media,
 * with how many, and those added by hand. Whoever may write the album adds a device to the list,
 * takes one off, and puts back one of its media's devices that was taken off.
 */
function AlbumDevices({ path, editable }: { path: string; editable: boolean }) {
  const { list, loading, add, remove } = useAlbumDevices(path);
  const [error, setError] = useState<string | null>(null);

  const change = (run: () => Promise<void>) => () => {
    setError(null);
    run().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (loading || !list) return null;
  if (!editable && list.devices.length === 0) return null;

  return (
    <InfoSection title='Devices'>
      {list.devices.length === 0 && <Text size='sm' c='dimmed'>No devices: the map shows no routes.</Text>}
      {list.devices.map((device) => (
        <DeviceRow
          key={device.path}
          under={path}
          device={device}
          action={editable ? { label: 'Take off the map', icon: 'x', run: change(() => remove(device.path)) } : undefined}
        />
      ))}
      {editable && list.removed.length > 0 && (
        <>
          <Text size='xs' c='dimmed' mt='xs'>Taken off the map</Text>
          {list.removed.map((device) => (
            <DeviceRow
              key={device.path}
              under={path}
              device={device}
              action={{ label: 'Put back on the map', icon: 'plus', run: change(() => add(device.path)) }}
            />
          ))}
        </>
      )}
      {editable && <AddDevice listed={list.devices} onAdd={(device) => change(() => add(device))()} />}
      {error && <Text size='xs' c='red'>{error}</Text>}
    </InfoSection>
  );
}

/**
 * What an album is and what is in it: its dates, its media by kind and how many have a position,
 * and who and what its media have — the people in them, where they were taken, who held the camera
 * and the labels they carry (`subjects-in`) — and the devices whose routes its map draws. Each opens
 * its own page, and its count a search of this album's media that have it.
 */
export function AlbumInfoTab({ path, editable, title, description, timeStart, timeEnd, facets }: AlbumInfoTabProps) {
  const { subjects, loading } = useContainerSubjects(path);
  const kinds = (facets?.kinds ?? []).filter((bucket) => KIND_WORDS[bucket.kind]);

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md' maw={1100}>
      <InfoSection title='Album'>
        <InfoFact label='Name'>{title}</InfoFact>
        {timeStart && <InfoFact label='When'>{formatRange(timeStart, timeEnd)}</InfoFact>}
        {kinds.length > 0 && <InfoFact label='Holds'>{kinds.map((bucket) => countOf(bucket.count, ...KIND_WORDS[bucket.kind])).join(' · ')}</InfoFact>}
        {subjects && subjects.total > 0 && (
          <InfoFact label='On the map'>
            {subjects.positioned === subjects.total ? 'All of them' : `${subjects.positioned.toLocaleString()} of ${subjects.total.toLocaleString()}`}
          </InfoFact>
        )}
        {subjects?.truncated && <Text size='xs' c='dimmed'>The album holds more than could be read; what is shown here counts the first 20,000.</Text>}
      </InfoSection>

      {description && (
        <InfoSection title='About'>
          <UserText text={description} size='sm' />
        </InfoSection>
      )}

      {loading && (
        <InfoSection title='People and places'>
          <Group gap='xs'>
            <Loader size='xs' />
            <Text size='sm' c='dimmed'>Reading who and what is in it…</Text>
          </Group>
        </InfoSection>
      )}

      {subjects && subjects.people.length > 0 && (
        <InfoSection title='People'>
          <SubjectList under={path} kind='person' rows={subjects.people} subject />
        </InfoSection>
      )}

      {subjects && subjects.locations.length > 0 && (
        <InfoSection title='Places'>
          <SubjectList under={path} kind='location' rows={subjects.locations} subject />
        </InfoSection>
      )}

      <AlbumDevices path={path} editable={editable} />

      {subjects && subjects.photographers.length > 0 && (
        <InfoSection title='Photographers'>
          <SubjectList under={path} kind='person' rows={subjects.photographers} subject={false} />
        </InfoSection>
      )}

      {facets && facets.labels.length > 0 && (
        <InfoSection title='Labels'>
          <Group gap={6}>
            {facets.labels.map(({ label, count }) => (
              <Badge key={label} variant='default' tt='none' fw={500}>
                <Anchor component={Link} to={searchIn(path, { tags: [label] })} size='xs' fw={500} c='inherit' underline='hover'>
                  {label} <Text span size='xs' c='dimmed'>{count.toLocaleString()}</Text>
                </Anchor>
              </Badge>
            ))}
          </Group>
        </InfoSection>
      )}

      {subjects && !loading && subjects.people.length + subjects.locations.length + subjects.devices.length + subjects.photographers.length === 0 && (
        <InfoSection title='People and places'>
          <Text size='sm' c='dimmed'>Nobody is tagged in this album's media yet, and none of it is linked to a location or a device.</Text>
        </InfoSection>
      )}
    </SimpleGrid>
  );
}
