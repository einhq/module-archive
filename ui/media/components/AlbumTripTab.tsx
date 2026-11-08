import { Anchor, Badge, Button, Card, Group, Stack, Table, Text } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { type StatNode, useAccessIds, useIdentities, useNodeEvents } from '@ein/ui/hooks';
import { canWrite, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TripStay, TripWeather } from '@archive/location/api';
import { formatDistance, trackProfile } from '@archive/location/track-profile';
import { compassPoint, oneDecimal } from '../../location/lib/weather.ts';
import { useTracks } from '../../location/hooks/useTracks.ts';
import type { AlbumTrip } from '@archive/media/api';
import { EventModal } from '../../people/components/EventModal.tsx';
import { type AlbumEvent, useAlbumEvents } from '../hooks/useAlbumEvents.ts';
import { AlbumEventNote } from './AlbumEventNote.tsx';

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** A local day, `YYYY-MM-DD`, as a date; the day is already the track's, so it is read as UTC. */
const showDay = (day: string): string => dayFormat.format(new Date(`${day}T00:00:00Z`));

const slugOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const DAY_AND_CLOCK: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };

/**
 * Times in the track's timezone, as its days are: UTC for a track without a timezone, and for one
 * whose timezone the browser does not know.
 */
const formatIn = (timezone: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: timezone ?? 'UTC' });
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
  }
};

/** The weather of a leg or trip in a line: wind, temperature and cloud cover, those it has. */
const weatherLine = (weather: TripWeather): string | undefined => {
  const parts: string[] = [];
  if (weather.windSpeed !== undefined) {
    parts.push(
      `Wind ${oneDecimal.format(weather.windSpeed)}\u00a0m/s` +
        (weather.windMax !== undefined && weather.windMax > weather.windSpeed ? `, at most ${oneDecimal.format(weather.windMax)}` : '') +
        (weather.windDirection !== undefined ? `, from ${compassPoint(weather.windDirection)}` : ''),
    );
  }
  if (weather.temperatureMin !== undefined && weather.temperatureMax !== undefined) {
    const [min, max] = [oneDecimal.format(weather.temperatureMin), oneDecimal.format(weather.temperatureMax)];
    parts.push(min === max ? `${min}\u00a0°C` : `${min} to ${max}\u00a0°C`);
  }
  if (weather.cloudCover !== undefined) parts.push(`${weather.cloudCover}\u00a0% cloud`);
  return parts.length ? parts.join(' · ') : undefined;
};

/** A leg's or trip's weather, as `track-weather` gave it; nothing when it has none. */
function WeatherText({ weather }: { weather?: TripWeather }) {
  const line = weather && weatherLine(weather);
  if (!line) return null;
  return (
    <Group gap={6} wrap='nowrap' align='flex-start'>
      <TablerIcon name='cloud' size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <Text size='sm'>{line}</Text>
    </Group>
  );
}

const STAY_KINDS: Record<TripStay['kind'], string> = { home: 'Home', rest: 'Long stay', overnight: 'Overnight' };

/** The track's name and kind (`track-list`), and the names of the locations the stays are at, read once. */
function useTripNames(trip: AlbumTrip): { trackName: string; units: 'nautical' | 'metric'; names: Map<string, string> } {
  const { tracks } = useTracks();
  const [names, setNames] = useState(new Map<string, string>());
  const places = useMemo(() => [...new Set(trip.stays.flatMap((stay) => stay.location ?? stay.home ?? []))], [trip.stays]);
  const track = tracks.find((entry) => entry.path === trip.track);

  useEffect(() => {
    let cancelled = false;
    Promise.all(places.map((path) => execCommand<StatNode>(`stat ${shq(path)}`).then((node) => [path, node.attrs.name] as const, () => [path, undefined] as const)))
      .then((read) => {
        if (cancelled) return;
        setNames(new Map(read.flatMap(([path, name]) => typeof name === 'string' && name ? [[path, name]] : [])));
      });
    return () => {
      cancelled = true;
    };
  }, [places]);

  return { trackName: track?.name ?? 'Track', units: trackProfile(track?.kind).units, names };
}

/**
 * The trip an album was made (`trip-album`): its days, distance, where it went and its weather, and
 * a card for each leg with that day's weather and notes, which are the album's events of that day. `editable` offers
 * adding a note to a day and changing the notes the reader may change. `onChanged` is called when
 * the album changes, as it does when its trip is written anew.
 */
export function AlbumTripTab(
  { album, title, trip, editable, onChanged }: { album: string; title: string; trip: AlbumTrip; editable: boolean; onChanged: () => void },
) {
  const { trackName, units, names } = useTripNames(trip);
  const { events, reload } = useAlbumEvents(album);
  const access = useAccessIds();
  const { users } = useIdentities();
  const authors = useMemo(() => new Map(users.map((user) => [user.uid, user.title || user.username])), [users]);
  const clock = useMemo(() => formatIn(trip.timezone, CLOCK), [trip.timezone]);
  const when = useMemo(() => formatIn(trip.timezone, DAY_AND_CLOCK), [trip.timezone]);
  const [addingOn, setAddingOn] = useState<string | undefined>(undefined);
  const [edited, setEdited] = useState<AlbumEvent | undefined>(undefined);

  useNodeEvents({ pathPrefix: album, nodeTypes: ['album'], eventTypes: ['updated'] }, (event) => {
    if (event.path === album) onChanged();
  });

  const eventsOn = useMemo(() => {
    const byDay = new Map<string, AlbumEvent[]>();
    for (const event of events) {
      const day = event.date.slice(0, 10);
      byDay.set(day, [...byDay.get(day) ?? [], event]);
    }
    return (day: string) => byDay.get(day) ?? [];
  }, [events]);

  /** Where a trip or leg starts or ends: its stay's location when it has one, else what kind of stay. */
  const place = (at: { stay?: number }): ReactNode => {
    const stay = at.stay === undefined ? undefined : trip.stays[at.stay];
    if (!stay) return 'a point on the way';
    const where = stay.location ?? stay.home;
    const label = where ? names.get(where) ?? slugOf(where) : stay.kind === 'home' ? 'home' : stay.kind === 'rest' ? 'a long stay' : 'an overnight stay';
    return where ? <Anchor component={Link} to={`/locations/${encodeURIComponent(slugOf(where))}`} size='sm'>{label}</Anchor> : label;
  };

  const last = trip.legs[trip.legs.length - 1]?.day ?? trip.day;
  const destination = trip.destination.stay === undefined ? undefined : trip.stays[trip.destination.stay];

  return (
    <Stack gap='md'>
      <Card radius='md' withBorder>
        <Stack gap='xs'>
          <Group justify='space-between' wrap='wrap' gap='xs'>
            <Group gap='xs'>
              <Text fw={600}>{trip.day === last ? showDay(trip.day) : `${showDay(trip.day)} – ${showDay(last)}`}</Text>
              {trip.ongoing && <Badge color='green' variant='light'>Ongoing</Badge>}
            </Group>
            <Anchor component={Link} to={`/tracks/${encodeURIComponent(trip.track)}?tab=trips`} size='sm'>
              <Group gap={4} wrap='nowrap'>
                <TablerIcon name='map-route' size={14} />
                {trackName}
              </Group>
            </Anchor>
          </Group>
          <Text size='sm' c='dimmed'>
            {trip.legs.length} {trip.legs.length === 1 ? 'day' : 'days'} · {formatDistance(trip.distanceM, units)}
          </Text>
          <Text size='sm'>
            From {place(trip.from)} to {place(trip.to)}
            {destination && destination.kind !== 'home' && trip.destination.stay !== trip.to.stay && <>, farthest at {place(trip.destination)}</>}
          </Text>
          <WeatherText weather={trip.weather} />
        </Stack>
      </Card>

      {trip.legs.map((leg) => (
        <Card key={leg.day} radius='md' withBorder>
          <Stack gap='xs'>
            <Group justify='space-between' wrap='wrap' gap='xs'>
              <Text fw={600}>{showDay(leg.day)}</Text>
              {editable && (
                <Button size='compact-xs' variant='subtle' leftSection={<TablerIcon name='pencil-plus' size={14} />} onClick={() => setAddingOn(leg.day)}>
                  Add note
                </Button>
              )}
            </Group>
            <Text size='sm' c='dimmed'>
              {clock.format(new Date(leg.start))}–{clock.format(new Date(leg.end))} · {formatDistance(leg.distanceM, units)}
            </Text>
            <Text size='sm'>From {place(leg.from)} to {place(leg.to)}</Text>
            <WeatherText weather={leg.weather} />
            {eventsOn(leg.day).map((event) => (
              <AlbumEventNote
                key={event.path}
                text={event.text}
                author={event.writer?.name ?? authors.get(event.creator)}
                onEdit={canWrite(event.ownership, access) ? () => setEdited(event) : undefined}
              />
            ))}
          </Stack>
        </Card>
      ))}

      {trip.stays.length > 0 && (
        <Card radius='md' withBorder>
          <Text fw={600} mb='xs'>Stays</Text>
          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing={4}>
              <Table.Tbody>
                {trip.stays.map((stay, index) => (
                  <Table.Tr key={stay.start}>
                    <Table.Td>{place({ stay: index })}</Table.Td>
                    <Table.Td c='dimmed'>{STAY_KINDS[stay.kind]}</Table.Td>
                    <Table.Td c='dimmed'>{when.format(new Date(stay.start))} – {when.format(new Date(stay.end))}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      <EventModal
        ownerPath={album}
        ownerName={title}
        genericOnly
        defaultDate={addingOn}
        opened={addingOn !== undefined}
        onClose={() => setAddingOn(undefined)}
        onApplied={reload}
      />
      {edited && <EventModal event={edited} genericOnly opened onClose={() => setEdited(undefined)} onApplied={reload} />}
    </Stack>
  );
}
