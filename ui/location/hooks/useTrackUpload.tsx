import { type ReactNode, useRef, useState } from 'react';
import { TEMP_PATH } from '@ein/paths';
import { fileUrl, shq, uuidv4 } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import type { TrackStageResult } from '@archive/location/api';

/**
 * Put a GPX file in /tmp and answer the path it got. Nothing there is indexed, and `track-stage`
 * moves it to the device's `routes/` once its fixes are in the track; one it refuses is swept a
 * day later.
 */
const putInTemp = async (file: File): Promise<string> => {
  const name = `track-${uuidv4()}.gpx`;
  const response = await fetch(`${fileUrl(TEMP_PATH)}/?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/gpx+xml' },
    body: file,
  });
  if (!response.ok) throw new Error(`it could not be sent (HTTP ${response.status})`);
  const answer = await response.json() as { path?: unknown };
  if (typeof answer.path !== 'string') throw new Error('it was sent but no path came back');
  return answer.path;
};

/**
 * GPX files into one device's track. The device is the one whose page this is, so the files go
 * straight into its track rather than through staging, which would have to guess it from the file.
 * `device` is the device's slug or path. `open` raises a file picker that offers GPX files only;
 * `input`, the picker, has to be rendered somewhere on the page, and `sending` is true while files go.
 */
export function useTrackUpload(device: string, onImported?: () => void): { open: () => void; sending: boolean; input: ReactNode } {
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setSending(true);
    let points = 0;
    let untimed = 0;
    let added = 0;
    // Each file on its own: one that fails says so, and what the others added is still told.
    for (const file of files) {
      try {
        const path = await putInTemp(file);
        const result = await execCommand<TrackStageResult>(`track-stage ${shq(path)} --device ${shq(device)} --name ${shq(file.name)}`);
        if (result.status === 'imported') {
          points += result.imported;
          untimed += result.untimed;
          added++;
        }
      } catch (error) {
        notify({ message: `${file.name}: ${error instanceof Error ? error.message : String(error)}`, color: 'red' });
      }
    }
    setSending(false);
    if (added > 0) {
      const left = untimed > 0 ? `; ${untimed.toLocaleString()} without a time left out` : '';
      notify({
        message: points > 0 ? `${points.toLocaleString()} new point${points === 1 ? '' : 's'} added to the track${left}` : `The track already had every point in it${left}`,
        color: 'green',
      });
    }
    onImported?.();
  };

  const input = (
    <input
      ref={picker}
      type='file'
      accept='.gpx,.GPX,application/gpx+xml'
      multiple
      hidden
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        // Emptied, so the same file chosen again still changes it.
        event.currentTarget.value = '';
        void upload(files);
      }}
    />
  );

  return { open: () => picker.current?.click(), sending, input };
}
