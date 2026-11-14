import { ActionIcon, Badge, Box, Center, Group, Image, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { type RefObject, useRef, useState } from 'react';
import { Dialog, TablerIcon } from '@ein/ui/components';
import { usePhone } from '@ein/ui/hooks';
import { displayDims, gridUrl, lightboxRoute, mediaItemFrom, posterUrl } from '@ein/ui/lib';
import type { PersonFace } from '../hooks/usePersonFaces.ts';
import { useContentRect } from '../../media/hooks/useContentRect.ts';
import { useMediaDetails } from '../../media/hooks/useMediaDetails.ts';
import { formatTaken } from '../../media/lib/capture-time.ts';

/** The photos behind a row of faces, one for each photo, and the one on show. */
export type PhotoView = { photos: PersonFace[]; index: number };

/**
 * The photos behind faces, in the order shown and without repeats, opened at `opened`'s; null when
 * it has none. A photo stands for the first of the faces in it, but the one opened for `opened`
 * itself, whose box is the one marked.
 */
export function photoViewOf(among: PersonFace[], opened: PersonFace): PhotoView | null {
  const seen = new Set<string>();
  const photos: PersonFace[] = [];
  for (const face of among) {
    if (!face.filePath || seen.has(face.filePath)) continue;
    seen.add(face.filePath);
    photos.push(face.filePath === opened.filePath ? opened : face);
  }
  const index = photos.findIndex((face) => face.filePath === opened.filePath);
  return index < 0 ? null : { photos, index };
}

type Props = {
  /** What to show; null closes the dialog. */
  view: PhotoView | null;
  onChange: (view: PhotoView | null) => void;
};

/**
 * The photo a face was cut from, large, over the dialog the face was picked in (a video's face, the
 * video to play): the lightbox is a
 * full-screen route under every dialog, so a review cannot open it and stay in sight. The arrows,
 * and ← →, step through the photos of the faces it was opened among — a group, or all of them —
 * so a group can be checked by flicking through it. A photo shows every face box on it, the face
 * it was opened for marked, and the link beside the title opens it in the lightbox in a new tab.
 * Escape is the review dialog's to hand out: it closes this first.
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
      aside={face?.filePath && (
        <Group gap='xs' wrap='nowrap'>
          {count > 1 && view && <Badge variant='light'>{view.index + 1} of {count}</Badge>}
          <Tooltip label='Open in the lightbox, in a new tab'>
            <ActionIcon
              component='a'
              href={lightboxRoute(face.filePath)}
              target='_blank'
              rel='noopener'
              variant='subtle'
              color='gray'
              aria-label='Open in the lightbox, in a new tab'
            >
              <TablerIcon name='external-link' size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
      icon={face?.mimetype?.startsWith('video/') ? 'movie' : 'photo'}
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

/**
 * The photo's display size, then its grid size, then nothing: a file may have neither, with its
 * face boxes over it. A video is played from its poster, without boxes: a video's box holds at one
 * moment only. Keyed by the file, so each starts at the top.
 */
function Photo({ face }: { face: PersonFace }) {
  const imageRef = useRef<HTMLImageElement>(null);
  // The stored size picks the largest display size the photo has, rather than one never made for a small source.
  const ref = { path: face.filePath!, mimetype: face.mimetype, width: face.width, height: face.height, angle: face.angle };
  const item = mediaItemFrom(ref);
  const [fallback, setFallback] = useState(0);
  if (item.type === 'video') {
    return (
      <video
        src={item.fullUrl}
        poster={posterUrl(item.path, 'video', true, displayDims(ref)) || undefined}
        controls
        preload='metadata'
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    );
  }
  if (fallback > 1) return <TablerIcon name='photo-off' size={48} color='var(--mantine-color-gray-6)' />;
  const src = fallback === 0 ? item.fullUrl : gridUrl(item.path, true);
  return (
    <>
      <Image
        ref={imageRef}
        src={src}
        srcSet={fallback === 0 && item.srcSet ? item.srcSet : undefined}
        sizes='min(1200px, 96vw)'
        alt=''
        fit='contain'
        w='100%'
        h='100%'
        onError={() => setFallback((current) => current + 1)}
      />
      <FaceBoxes imageRef={imageRef} filePath={face.filePath!} marked={face.facePath} />
    </>
  );
}

/**
 * Every face box on the photo, as the lightbox has them (`media-details`), over where the
 * contained picture is drawn: the marked face in the accent with the rest of the photo dimmed, the
 * others faint, a tag dashed. They are only a picture: the arrows and the photo stay reachable.
 */
function FaceBoxes({ imageRef, filePath, marked }: { imageRef: RefObject<HTMLImageElement | null>; filePath: string; marked: string }) {
  const { details, detailsPath } = useMediaDetails(filePath);
  const rect = useContentRect(imageRef);
  if (!rect || detailsPath !== filePath || !details) return null;
  return (
    <Box style={{ position: 'absolute', ...rect, pointerEvents: 'none', overflow: 'hidden' }}>
      {details.faces.map((face) => {
        const active = face.facePath === marked;
        return (
          <Box
            key={face.facePath}
            data-face-path={face.facePath}
            data-marked={active || undefined}
            title={face.personName ?? 'Unassigned'}
            style={{
              position: 'absolute',
              left: `${face.faceBox.x * 100}%`,
              top: `${face.faceBox.y * 100}%`,
              width: `${face.faceBox.width * 100}%`,
              height: `${face.faceBox.height * 100}%`,
              border: `2px ${face.hasFace ? 'solid' : 'dashed'} ${active ? 'var(--mrx-accent)' : 'rgba(255,255,255,0.6)'}`,
              borderRadius: 3,
              boxShadow: active ? '0 0 0 9999px rgba(0,0,0,0.35)' : undefined,
              zIndex: active ? 1 : undefined,
              animation: 'mrx-fade-in 150ms ease-out',
            }}
          />
        );
      })}
    </Box>
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
