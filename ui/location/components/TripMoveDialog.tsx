import { Button, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { Dialog, DialogActions } from '@ein/ui/components';
import { useTracks } from '../hooks/useTracks.ts';

type Props = {
  /** The path of the track the trip is on. */
  track: string;
  /** What the trip is, under the title. */
  subtitle: string;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  /** Move the trip to the track at this path. */
  onMove: (to: string) => void;
};

/**
 * Picks the device a trip recorded on the wrong one is moved to: the track of any other device
 * (`track-list`). Mounted only while open, so the tracks are listed only then; one the reader may
 * not change refuses the move.
 */
export function TripMoveDialog({ track, subtitle, busy, error, onClose, onMove }: Props) {
  const { tracks, loading } = useTracks();
  const [target, setTarget] = useState<string | null>(null);

  const options = tracks.filter((entry) => entry.path !== track).map((entry) => ({ value: entry.path, label: entry.name }));

  return (
    <Dialog opened onClose={() => !busy && onClose()} title='Move the trip to another device' subtitle={subtitle} icon='arrows-exchange' size='sm'>
      <Stack gap='sm'>
        <Text size='sm' c='dimmed'>
          Its positions, first to last, leave this device's track for the other's, and the trips of both are found again.
        </Text>
        <Select
          data-autofocus
          label='Device'
          placeholder={loading ? 'Loading devices…' : 'Pick a device'}
          data={options}
          value={target}
          onChange={setTarget}
          searchable
          nothingFoundMessage='No other device'
          comboboxProps={{ withinPortal: false }}
        />
        {error && <Text size='sm' c='red'>{error}</Text>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button loading={busy} disabled={!target} onClick={() => target && onMove(target)}>Move</Button>
      </DialogActions>
    </Dialog>
  );
}
