import { Alert, Button, Select, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { baseName, shq } from '@ein/ui/lib';
import { execCommand, invalidateListing } from '@ein/ui/signals';
import { useState } from 'react';
import { useCameras } from '../../camera/hooks/useCameras.ts';

/** A `.gpx` file, by its name. */
export const isGpx = (path: string): boolean => path.toLowerCase().endsWith('.gpx');

/**
 * The selected GPX files (`selection`, from the listing in `directory`) imported, one after
 * another, into the track of the one camera chosen for them (`track-stage --camera`). A file
 * that fails is named with why; the listing is read again after, and `onImported` told.
 */
export function RouteImport({ selection, directory, onImported }: { selection: string[]; directory: string; onImported: () => void }) {
  const { cameras } = useCameras();
  const [camera, setCamera] = useState<string | null>(null);
  // A touch screen picks rows by a long press (NodeBrowser), so the hint says that instead of the keys.
  const touch = useMediaQuery('(pointer: coarse)', false, { getInitialValueInEffect: false });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const files = selection.filter(isGpx);

  const importSelected = async () => {
    if (!camera || files.length === 0) return;
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    for (const file of files) {
      try {
        await execCommand(`track-stage ${shq(file)} --camera ${shq(camera)}`);
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
            ? 'Select the files one camera recorded: press and hold one, then tap the others.'
            : 'Select the files one camera recorded: click one, and Ctrl or Shift and click for more, or Ctrl+A for all.'
          : files.length === 1
          ? '1 GPX file selected.'
          : `${files.length} GPX files selected.`}
      </Text>
      <Select
        placeholder='Camera that recorded them'
        aria-label='Camera'
        searchable
        data={cameras.map((entry) => ({ value: entry.path, label: entry.name }))}
        value={camera}
        onChange={setCamera}
      />
      <Button disabled={!camera || files.length === 0} loading={busy} onClick={() => void importSelected()}>
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
