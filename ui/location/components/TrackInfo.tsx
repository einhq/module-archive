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

/**
 * Everything known about a track beside its map and trips: how it travels, the timezone its days
 * are cut in, what it holds, where it belongs (its home bases, which `editable` lets the reader
 * change) and what it is.
 */
export function TrackInfo({ track, editable }: { track: TrackDetail; editable: boolean }) {
  return (
    <Stack gap='md'>
      <InfoSection title='Track'>
        <InfoFact label='Travels as'>{isTravelKind(track.kind) ? TRAVEL_KIND_LABELS[track.kind] : 'Not set (read as a car)'}</InfoFact>
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
