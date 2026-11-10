import { ActionIcon, Badge, Box, Center, Image } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useState } from 'react';
import { Dialog, TablerIcon } from '@ein/ui/components';
import { usePhone } from '@ein/ui/hooks';
import { gridUrl, mediaItemFrom } from '@ein/ui/lib';
import type { PersonFace } from '../hooks/usePersonFaces.ts';
import { formatTaken } from '../../media/lib/capture-time.ts';

/** The photos behind a row of faces, one for each photo, and the one on show. */
export type PhotoView = { photos: PersonFace[]; index: number };

/** The photos behind faces, in the order shown and without repeats, opened at `filePath`'s; null when it has none. */
export function photoViewOf(among: PersonFace[], filePath?: string): PhotoView | null {
  const seen = new Set<string>();
  const photos: PersonFace[] = [];
  for (const face of among) {
    if (!face.filePath || seen.has(face.filePath)) continue;
    seen.add(face.filePath);
    photos.push(face);
  }
  const index = photos.findIndex((face) => face.filePath === filePath);
  return index < 0 ? null : { photos, index };
}

type Props = {
  /** What to show; null closes the dialog. */
  view: PhotoView | null;
  onChange: (view: PhotoView | null) => void;
};

/**
 * The photo a face was cut from, large, over the dialog the face was picked in: the lightbox is a
 * full-screen route under every dialog, so a review cannot open it and stay in sight. The arrows,
 * and ← →, step through the photos of the faces it was opened among — a group, or all of them —
 * so a group can be checked by flicking through it. Escape is the review dialog's to hand out:
 * it closes this first.
 */
export function FacePhotoDialog({ view, onChange }: Props) {
  const phone = usePhone();
  const face = view?.photos[view.index];
  const count = view?.photos.length ?? 0;
  const step = (by: number) => {
    if (!view) return;
    const index = view.index + by;
    if (index >= 0 && index < count) onChange({ ...view, index });
  };
  useHotkeys(view ? [['ArrowLeft', () => step(-1)], ['ArrowRight', () => step(1)]] : []);

  return (
    <Dialog
      opened={!!face}
      onClose={() => onChange(null)}
      title={face?.filePath?.split('/').pop()}
      subtitle={face?.takenAt ? formatTaken(face.takenAt, undefined, { weekday: 'short' }) : undefined}
      aside={count > 1 && view && <Badge variant='light'>{view.index + 1} of {count}</Badge>}
      icon='photo'
      pattern='media'
      size='min(1200px, 96vw)'
      zIndex={300}
      bleed
      closeOnEscape={false}
    >
      {face?.filePath && (
        <Center
          pos='relative'
          bg='black'
          style={{ flex: phone ? 1 : undefined, height: phone ? undefined : 'min(78dvh, 900px)', minHeight: 240 }}
        >
          <Photo key={face.filePath} face={face} />
          {count > 1 && (
            <>
              <StepButton icon='chevron-left' label='Previous photo' side='left' disabled={view!.index === 0} onClick={() => step(-1)} />
              <StepButton icon='chevron-right' label='Next photo' side='right' disabled={view!.index === count - 1} onClick={() => step(1)} />
            </>
          )}
        </Center>
      )}
    </Dialog>
  );
}

/** The photo's display size, then its grid size, then nothing: a file may have neither. Keyed by the photo, so each starts at the top. */
function Photo({ face }: { face: PersonFace }) {
  // The stored size picks the largest display size the photo has, rather than one never made for a small source.
  const item = mediaItemFrom({ path: face.filePath!, type: 'photo', width: face.width, height: face.height, angle: face.angle });
  const [fallback, setFallback] = useState(0);
  if (fallback > 1) return <TablerIcon name='photo-off' size={48} color='var(--mantine-color-gray-6)' />;
  const src = fallback === 0 ? item.fullUrl : gridUrl(item.path, true);
  return (
    <Image
      src={src}
      srcSet={fallback === 0 && item.srcSet ? item.srcSet : undefined}
      sizes='min(1200px, 96vw)'
      alt=''
      fit='contain'
      w='100%'
      h='100%'
      onError={() => setFallback((current) => current + 1)}
    />
  );
}

function StepButton({ icon, label, side, disabled, onClick }: { icon: string; label: string; side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  return (
    <Box style={{ position: 'absolute', top: '50%', [side]: 8, transform: 'translateY(-50%)' }}>
      <ActionIcon size='xl' radius='xl' variant='filled' color='dark' aria-label={label} disabled={disabled} onClick={onClick} style={{ opacity: disabled ? 0 : 0.8 }}>
        <TablerIcon name={icon} size={24} />
      </ActionIcon>
    </Box>
  );
}
