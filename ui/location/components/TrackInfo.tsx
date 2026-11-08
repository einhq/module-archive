import { Stack, Text } from '@mantine/core';
import { isTravelKind, TRAVEL_KIND_LABELS } from '@archive/location/track-profile';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';
import type { TrackDetail } from '../hooks/useTrackDetail.ts';
import { TrackHomes } from './TrackHomes.tsx';

const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** `12 Jun 2025 – 3 Aug 2025`, or the one day. */
const span = (first: string, last?: string): string => {
  const from = dayFormat.format(new Date(first));
  const to = last ? dayFormat.format(new Date(last)) : from;
  return from === to ? from : `${from} – ${to}`;
};

/** How the track travels, said: its own kind, else its device's class, else that it reads as a car. */
const travelsAs = (track: TrackDetail): string => {
  if (isTravelKind(track.kind)) return TRAVEL_KIND_LABELS[track.kind];
  if (isTravelKind(track.travels)) return `${TRAVEL_KIND_LABELS[track.travels]} (the device's class)`;
  return 'Not set (read as a car)';
};

/**
 * Everything known about a device's track beside its trips: how it travels, the timezone its days
 * are cut in, what it holds, where it belongs (its home bases, which `editable` lets the reader
 * change) and what it is.
 */
export function TrackInfo({ track, editable }: { track: TrackDetail; editable: boolean }) {
  return (
    <Stack gap='md'>
      <InfoSection title='Travel'>
        <InfoFact label='Travels as'>{travelsAs(track)}</InfoFact>
        <InfoFact label='Timezone'>{track.timezone || 'UTC'}</InfoFact>
        <InfoFact label='Positions'>{track.points.toLocaleString()}</InfoFact>
        {track.firstTs && <InfoFact label='Recorded'>{span(track.firstTs, track.lastTs)}</InfoFact>}
        <InfoFact label='Path'>
          <Text size='sm' ff='monospace' component='span'>{track.path}</Text>
        </InfoFact>
      </InfoSection>

      <TrackHomes track={track.path} editable={editable} />

      {track.description && (
        <InfoSection title='About'>
          <UserText text={track.description} size='sm' />
        </InfoSection>
      )}
    </Stack>
  );
}
