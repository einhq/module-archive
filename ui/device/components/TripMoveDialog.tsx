import { Button, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { Dialog, DialogActions } from '@ein/ui/components';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';
import { useDevices } from '../hooks/useDevices.ts';

type Props = {
  /** The path of the device the trip is on. */
  device: string;
  /** What the trip is, under the title. */
  subtitle: string;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  /** Move the trip to the device at this path. */
  onMove: (to: string) => void;
};

/**
 * Picks the device a trip recorded on the wrong one is moved to: any device the reader may change,
 * but the one it is on. Mounted only while open, so the devices are listed only then.
 */
export function TripMoveDialog({ device, subtitle, busy, error, onClose, onMove }: Props) {
  const { devices, loading } = useDevices();
  const access = useAccessIds();
  const [target, setTarget] = useState<string | null>(null);

  const options = devices
    .filter((entry) => entry.path !== device && canWrite(entry.ownership, access))
    .map((entry) => ({ value: entry.path, label: entry.name }));

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
          nothingFoundMessage='No other device you may change'
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
