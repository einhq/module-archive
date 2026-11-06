import { Alert, Button, Select, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { baseName, shq } from '@ein/ui/lib';
import { execCommand, invalidateListing } from '@ein/ui/signals';
import { useState } from 'react';
import { useDevices } from '../../device/hooks/useDevices.ts';

/** A `.gpx` file, by its name. */
export const isGpx = (path: string): boolean => path.toLowerCase().endsWith('.gpx');

/**
 * The selected GPX files (`selection`, from the listing in `directory`) imported, one after
 * another, into the track of the one device chosen for them (`track-stage --device`). A file
 * that fails is named with why; the listing is read again after, and `onImported` told.
 */
export function RouteImport({ selection, directory, onImported }: { selection: string[]; directory: string; onImported: () => void }) {
  const { devices } = useDevices();
  const [device, setDevice] = useState<string | null>(null);
  // A touch screen picks rows by a long press (NodeBrowser), so the hint says that instead of the keys.
  const touch = useMediaQuery('(pointer: coarse)', false, { getInitialValueInEffect: false });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const files = selection.filter(isGpx);

  const importSelected = async () => {
    if (!device || files.length === 0) return;
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    for (const file of files) {
      try {
        await execCommand(`track-stage ${shq(file)} --device ${shq(device)}`);
      } catch (err) {
        failed.push(`${baseName(file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setErrors(failed);
    setBusy(false);
    invalidateListing(directory);
    onImported();
  };

  return (
    <Stack gap='xs'>
      <Text size='sm'>
        {files.length === 0
          ? touch
            ? 'Select the files one device recorded: press and hold one, then tap the others.'
            : 'Select the files one device recorded: click one, and Ctrl or Shift and click for more, or Ctrl+A for all.'
          : files.length === 1
          ? '1 GPX file selected.'
          : `${files.length} GPX files selected.`}
      </Text>
      <Select
        placeholder='Device that recorded them'
        aria-label='Device'
        searchable
        data={devices.map((entry) => ({ value: entry.path, label: entry.name }))}
        value={device}
        onChange={setDevice}
      />
      <Button disabled={!device || files.length === 0} loading={busy} onClick={() => void importSelected()}>
        {files.length > 1 ? `Import ${files.length} files` : 'Import'}
      </Button>
      {errors.length > 0 && (
        <Alert color='red' variant='light'>
          {errors.map((message) => <Text key={message} size='sm'>{message}</Text>)}
        </Alert>
      )}
    </Stack>
  );
}
