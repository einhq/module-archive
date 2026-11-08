import { Button, Select, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { Dialog, DialogActions } from '@ein/ui/components';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';
import { useCameras } from '../hooks/useCameras.ts';

type Props = {
  /** The path of the camera the trip is on. */
  camera: string;
  /** What the trip is, under the title. */
  subtitle: string;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  /** Move the trip to the camera at this path. */
  onMove: (to: string) => void;
};

/**
 * Picks the camera a trip recorded on the wrong one is moved to: any camera the reader may change,
 * but the one it is on. Mounted only while open, so the cameras are listed only then.
 */
export function TripMoveDialog({ camera, subtitle, busy, error, onClose, onMove }: Props) {
  const { cameras, loading } = useCameras();
  const access = useAccessIds();
  const [target, setTarget] = useState<string | null>(null);

  const options = cameras
    .filter((entry) => entry.path !== camera && canWrite(entry.ownership, access))
    .map((entry) => ({ value: entry.path, label: entry.name }));

  return (
    <Dialog opened onClose={() => !busy && onClose()} title='Move the trip to another camera' subtitle={subtitle} icon='arrows-exchange' size='sm'>
      <Stack gap='sm'>
        <Text size='sm' c='dimmed'>
          Its positions, first to last, leave this camera's track for the other's, and the trips of both are found again.
        </Text>
        <Select
          data-autofocus
          label='Camera'
          placeholder={loading ? 'Loading cameras…' : 'Pick a camera'}
          data={options}
          value={target}
          onChange={setTarget}
          searchable
          nothingFoundMessage='No other camera you may change'
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
