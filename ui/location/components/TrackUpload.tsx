import { Button, FileButton } from '@mantine/core';
import { useState } from 'react';
import { TEMP_PATH } from '@ein/paths';
import { TablerIcon } from '@ein/ui/components';
import { fileUrl, shq, uuidv4 } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import type { TrackStageResult } from '@archive/location/api';

/**
 * Put a GPX file in /tmp and answer the path it got. Nothing there is indexed, and `track-stage`
 * removes it once its fixes are in the track; one it refuses is swept a day later.
 */
const putInTemp = async (file: File): Promise<string> => {
  const name = `track-${uuidv4()}.gpx`;
  const response = await fetch(`${fileUrl(TEMP_PATH)}/?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/gpx+xml' },
    body: file,
  });
  if (!response.ok) throw new Error(`${file.name} could not be sent (HTTP ${response.status})`);
  const answer = await response.json() as { path?: unknown };
  if (typeof answer.path !== 'string') throw new Error(`${file.name} was sent but no path came back`);
  return answer.path;
};

/**
 * GPX files into one device's track. The device is the one whose page this is, so the files go
 * straight into its track rather than through staging, which would have to guess it from the file.
 * `device` is the device's slug or path.
 */
export function TrackUpload({ device, onImported }: { device: string; onImported?: () => void }) {
  const [sending, setSending] = useState(false);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setSending(true);
    let points = 0;
    try {
      for (const file of files) {
        const path = await putInTemp(file);
        const result = await execCommand<TrackStageResult>(`track-stage ${shq(path)} --device ${shq(device)}`);
        if (result.status === 'imported') points += result.imported;
      }
      notify({
        message: points > 0 ? `${points.toLocaleString()} new point${points === 1 ? '' : 's'} added to the track` : 'The track already had every point in it',
        color: 'green',
      });
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setSending(false);
      onImported?.();
    }
  };

  return (
    <FileButton onChange={upload} accept='.gpx,.GPX,application/gpx+xml' multiple>
      {(props) => (
        <Button {...props} variant='default' size='sm' leftSection={<TablerIcon name='upload' size={16} />} loading={sending}>
          Upload GPX
        </Button>
      )}
    </FileButton>
  );
}
