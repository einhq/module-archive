import { ActionIcon, FileButton, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { TEMP_PATH } from '@ein/paths';
import { TablerIcon } from '@ein/ui/components';
import { fileUrl, uuidv4 } from '@ein/ui/lib';
import { notify } from '@ein/ui/signals';

/** The longest side a picture is sent at: the embedder looks at 384 px, so more is only bytes. */
const LONGEST_SIDE = 1024;

/**
 * The picture as a JPEG, upright and no larger than LONGEST_SIDE. The browser turns it by its EXIF
 * orientation as it decodes it, which the media service never does on its own; a format the
 * browser cannot decode goes as it is.
 */
const upright = async (file: File): Promise<Blob> => {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const scale = Math.min(1, LONGEST_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
};

/**
 * Put a picture in /tmp to search with, and answer the path it got. Nothing there is indexed, so it
 * never becomes part of the archive, and a sweep removes it a day later. The name is random, so two
 * readers' pictures never meet.
 */
const putInTemp = async (file: File): Promise<string> => {
  const body = await upright(file);
  const extension = body === file ? file.name.split('.').pop() || 'img' : 'jpg';
  const name = `like-${uuidv4()}.${extension}`;
  const response = await fetch(`${fileUrl(TEMP_PATH)}/?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': body.type || 'application/octet-stream' },
    body,
  });
  if (!response.ok) throw new Error(`the picture could not be sent (HTTP ${response.status})`);
  const answer = await response.json() as { path?: unknown };
  if (typeof answer.path !== 'string') throw new Error('the picture was sent but no path came back');
  return answer.path;
};

/**
 * Search with a picture that is not in the archive: one picked from the device, or on a phone one
 * taken with its camera — an old print, a place. `onPicked` gets the path to search `--like`.
 */
export function SearchByPicture({ onPicked }: { onPicked: (path: string) => void }) {
  const [sending, setSending] = useState(false);

  const pick = async (file: File | null) => {
    if (!file) return;
    setSending(true);
    try {
      onPicked(await putInTemp(file));
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setSending(false);
    }
  };

  return (
    <FileButton onChange={pick} accept='image/*'>
      {(props) => (
        <Tooltip label='Search with a picture'>
          <ActionIcon
            {...props}
            variant='light'
            size='input-md'
            loading={sending}
            aria-label='Search with a picture'
          >
            <TablerIcon name='photo-search' size={22} />
          </ActionIcon>
        </Tooltip>
      )}
    </FileButton>
  );
}
