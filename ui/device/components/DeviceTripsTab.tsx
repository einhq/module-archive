import { Accordion, Alert, Anchor, Badge, Button, Card, Group, Stack, Table, Text } from '@mantine/core';
import { EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import type { Trip, TripList, TripPlace } from '@archive/location/api';
import { formatDistance } from '@archive/location/track-profile';
import { albumRoute } from '../../media/lib/album-path.ts';
import { useDeviceTrips } from '../hooks/useDeviceTrips.ts';
import { AlbumPickerDialog } from '../../media/components/AlbumPickerDialog.tsx';
import { TripMoveDialog } from './TripMoveDialog.tsx';

const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A local day, `YYYY-MM-DD`, as a date; the day is already the device's, so it is read as UTC. */
const showDay = (day: string): string => dayFormat.format(new Date(`${day}T00:00:00Z`));

const span = (trip: Trip): string => trip.days.length === 1 ? showDay(trip.day) : `${showDay(trip.day)} – ${showDay(trip.days[trip.days.length - 1])}`;

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * What a place a trip or leg starts or ends at was: one of the stays, by the name of its location
 * and linked to it once it has one, or a fix along the way.
 */
function PlaceLabel({ list, place }: { list: TripList; place: Pick<TripPlace, 'stay'> }) {
  const stay = place.stay === undefined ? undefined : list.stays[place.stay];
  if (!stay) return <>a point on the way</>;
  if (stay.location && stay.name) {
    const link = <Anchor component={Link} to={`/locations/${nameOf(stay.location)}`} inherit>{stay.name}</Anchor>;
    return stay.kind === 'home' ? <>home ({link})</> : link;
  }
  if (stay.kind === 'home') return <>{stay.home ? `home (${nameOf(stay.home)})` : 'home'}</>;
  return <>{stay.kind === 'rest' ? 'a long stay' : 'an overnight stay'}</>;
}

/** The day, of the trip's legs, a trip joined to it by a merge began on. */
const joinedDay = (trip: Trip, start: string): string | undefined => trip.legs.find((leg) => leg.start <= start && start <= leg.end)?.day;

/** What a trip's album is to be: a new one (named `name`, or after the trip), one that is there by its path, or none. */
type OnAlbum = (trip: string, album: 'new' | 'detach' | string, name?: string) => void;

/**
 * The album the trip was made, or, until it is one, the albums it may belong to. Whoever may change
 * the device gets **New album**, named after the trip, and **Put in an album…**, which picks any album
 * they may change, the ones its pictures are in first, or names a new one; anyone else gets the list.
 */
function TripAlbum({ trip, editable, busy, onAlbum }: { trip: Trip; editable: boolean; busy: boolean; onAlbum: OnAlbum }) {
  const [picking, setPicking] = useState(false);
  if (trip.album) {
    return (
      <Group gap='xs'>
        <Text size='sm' c='dimmed'>Album:</Text>
        <Anchor component={Link} to={albumRoute(trip.album)} size='sm'>{nameOf(trip.album)}</Anchor>
        {editable && (
          <Button size='compact-xs' variant='subtle' color='gray' disabled={busy} onClick={() => onAlbum(trip.id, 'detach')}>
            Take off the album
          </Button>
        )}
      </Group>
    );
  }
  if (editable) {
    return (
      <Group gap='xs'>
        <Button size='compact-xs' variant='light' disabled={busy} leftSection={<TablerIcon name='photo-plus' size={14} />} onClick={() => onAlbum(trip.id, 'new')}>
          New album
        </Button>
        <Button size='compact-xs' variant='subtle' disabled={busy} leftSection={<TablerIcon name='library-plus' size={14} />} onClick={() => setPicking(true)}>
          Put in an album…
        </Button>
        <AlbumPickerDialog
          opened={picking}
          title='Put the trip in an album'
          subtitle={span(trip)}
          suggested={trip.albums.map((album) => ({ path: album, title: nameOf(album) }))}
          busy={busy}
          onClose={() => setPicking(false)}
          onPick={(choice) => {
            setPicking(false);
            onAlbum(trip.id, choice.create ? 'new' : choice.path, choice.create ? choice.title : undefined);
          }}
        />
      </Group>
    );
  }
  if (trip.albums.length === 0) return null;
  return (
    <Group gap='xs'>
      <Text size='sm' c='dimmed'>Maybe in:</Text>
      {trip.albums.map((album) => <Anchor key={album} component={Link} to={albumRoute(album)} size='sm'>{nameOf(album)}</Anchor>)}
    </Group>
  );
}

function TripCard(
  { list, trip, first, editable, busy, onEdit, onAlbum, onMove }: {
    list: TripList;
    trip: Trip;
    first: boolean;
    editable: boolean;
    busy: boolean;
    onEdit: (name: string, how: 'merge' | 'split') => void;
    onAlbum: OnAlbum;
    /** Move the trip to the device at `to`; settles when it is done or has failed. */
    onMove: (trip: Trip, to: string) => Promise<void>;
  },
) {
  const [moving, setMoving] = useState(false);
  const destination = trip.destination.stay === undefined ? undefined : list.stays[trip.destination.stay];
  // The legs' days are the device's, so their times are told on its clock too.
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: list.timezone ?? 'UTC' });
  return (
    <Card radius='md' withBorder>
      <Stack gap='xs'>
        <Group justify='space-between' wrap='wrap' gap='xs'>
          <Group gap='xs'>
            <Text fw={600}>{span(trip)}</Text>
            {trip.ongoing && <Badge color='green' variant='light'>Ongoing</Badge>}
          </Group>
          {editable && (
            <Group gap='xs'>
              {!first && (
                <Button
                  size='compact-xs'
                  variant='subtle'
                  disabled={busy}
                  leftSection={<TablerIcon name='arrows-join' size={14} />}
                  onClick={() => onEdit(trip.id, 'merge')}
                >
                  Join to the trip before
                </Button>
              )}
              <Button
                size='compact-xs'
                variant='subtle'
                color='gray'
                disabled={busy}
                leftSection={<TablerIcon name='arrows-exchange' size={14} />}
                onClick={() => setMoving(true)}
              >
                Move to device…
              </Button>
            </Group>
          )}
        </Group>
        {moving && (
          <TripMoveDialog
            device={list.device}
            subtitle={span(trip)}
            busy={busy}
            onClose={() => setMoving(false)}
            onMove={async (to) => {
              await onMove(trip, to);
              setMoving(false);
            }}
          />
        )}
        <Text size='sm' c='dimmed'>
          {trip.days.length} {trip.days.length === 1 ? 'day' : 'days'} · {formatDistance(trip.distanceM, list.units)} · {formatDistance(trip.maxDistanceM, list.units)}{' '}
          out at most
        </Text>
        <Text size='sm'>
          From <PlaceLabel list={list} place={trip.from} /> to <PlaceLabel list={list} place={trip.to} />
          {destination && destination.kind !== 'home' && (
            <>
              , farthest at <PlaceLabel list={list} place={trip.destination} />
            </>
          )}
        </Text>
        <TripAlbum trip={trip} editable={editable} busy={busy} onAlbum={onAlbum} />
        {editable && trip.joined?.map((start) => {
          const day = joinedDay(trip, start);
          return day && (
            <Group key={start} gap='xs'>
              <Text size='sm' c='dimmed'>Joined on {showDay(day)}</Text>
              <Button size='compact-xs' variant='subtle' disabled={busy} onClick={() => onEdit(day, 'split')}>Part again</Button>
            </Group>
          );
        })}
        <Accordion variant='default' chevronPosition='left'>
          <Accordion.Item value='legs'>
            <Accordion.Control>
              <Text size='sm'>{trip.legs.length === 1 ? '1 leg' : `${trip.legs.length} legs`}</Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Table.ScrollContainer minWidth={420}>
                <Table verticalSpacing={4}>
                  <Table.Tbody>
                    {trip.legs.map((leg, index) => (
                      <Table.Tr key={leg.day}>
                        <Table.Td>{showDay(leg.day)}</Table.Td>
                        <Table.Td c='dimmed'>{timeFormat.format(new Date(leg.start))}–{timeFormat.format(new Date(leg.end))}</Table.Td>
                        <Table.Td>{formatDistance(leg.distanceM, list.units)}</Table.Td>
                        <Table.Td c='dimmed'>
                          to <PlaceLabel list={list} place={leg.to} />
                        </Table.Td>
                        <Table.Td>
                          {editable && index > 0 && (
                            <Button size='compact-xs' variant='subtle' disabled={busy} onClick={() => onEdit(leg.day, 'split')}>Start a trip here</Button>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Card>
  );
}

/**
 * A device's trips, newest first, as derived from its track: each with its days, distance, where
 * it went, and its album or the albums it may belong to. `device` is the device's path; `editable`
 * offers making a trip an album and taking it off again, joining a trip to the one before it,
 * parting it again, moving it to another device, and deriving them all again.
 */
export function DeviceTripsTab({ device, editable }: { device: string; editable: boolean }) {
  const { trips, loading, error, edit, derive, makeAlbum, move } = useDeviceTrips(device);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(null);
    try {
      await action();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !trips) return <PageLoader label='Loading trips…' />;

  const deriveButton = editable && (
    <Button size='xs' variant='light' loading={busy} leftSection={<TablerIcon name='refresh' size={14} />} onClick={() => run(derive)}>
      {trips?.computedAt ? 'Find trips again' : 'Find trips'}
    </Button>
  );

  return (
    <Stack gap='md'>
      {(error || failed) && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{failed ?? error}</Alert>}
      {!trips || trips.trips.length === 0
        ? (
          <EmptyState title='No trips' actions={deriveButton || undefined}>
            {trips?.computedAt
              ? 'Nothing in the track went 500 m or more from where it started.'
              : 'Trips are found in the track once it has fixes, and kept up to date as it grows.'}
          </EmptyState>
        )
        : (
          <>
            <Group justify='space-between'>
              <Text size='sm' c='dimmed'>{trips.trips.length === 1 ? '1 trip' : `${trips.trips.length} trips`}</Text>
              {deriveButton}
            </Group>
            {trips.trips.map((trip, index) => ({ trip, first: index === 0 })).reverse().map(({ trip, first }) => (
              <TripCard
                key={trip.id}
                list={trips}
                trip={trip}
                first={first}
                editable={editable}
                busy={busy}
                onEdit={(name, how) => run(() => edit(name, how))}
                onAlbum={(name, album, title) =>
                  run(async () => {
                    await makeAlbum(name, album, title);
                  })}
                onMove={(moved, to) => run(() => move(moved, to))}
              />
            ))}
          </>
        )}
    </Stack>
  );
}
