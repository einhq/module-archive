import { Alert, Button, Select, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { baseName, shq } from '@ein/ui/lib';
import { execCommand, invalidateListing } from '@ein/ui/signals';
import { useState } from 'react';
import { useTracks } from '../hooks/useTracks.ts';

/** A `.gpx` file, by its name. */
export const isGpx = (path: string): boolean => path.toLowerCase().endsWith('.gpx');

/**
 * The selected GPX files (`selection`, from the listing in `directory`) imported, one after
 * another, into the one track chosen for them (`track-stage --track`). A file that fails is named
 * with why; the listing is read again after, and `onImported` told.
 */
export function RouteImport({ selection, directory, onImported }: { selection: string[]; directory: string; onImported: () => void }) {
  const { tracks } = useTracks();
  const [track, setTrack] = useState<string | null>(null);
  // A touch screen picks rows by a long press (NodeBrowser), so the hint says that instead of the keys.
  const touch = useMediaQuery('(pointer: coarse)', false, { getInitialValueInEffect: false });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const files = selection.filter(isGpx);

  const importSelected = async () => {
    if (!track || files.length === 0) return;
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    for (const file of files) {
      try {
        await execCommand(`track-stage ${shq(file)} --track ${shq(track)}`);
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
            ? 'Select the files of one track: press and hold one, then tap the others.'
            : 'Select the files of one track: click one, and Ctrl or Shift and click for more, or Ctrl+A for all.'
          : files.length === 1
          ? '1 GPX file selected.'
          : `${files.length} GPX files selected.`}
      </Text>
      <Select
        placeholder='Track they belong to'
        aria-label='Track'
        searchable
        data={tracks.map((entry) => ({ value: entry.path, label: entry.name }))}
        value={track}
        onChange={setTrack}
      />
      <Button disabled={!track || files.length === 0} loading={busy} onClick={() => void importSelected()}>
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
