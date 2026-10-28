import { Box, getDefaultZIndex, Image, Paper, Portal, Stack, Text } from '@mantine/core';
import { cloneElement, type MouseEvent, type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { gridUrl, thumbnailUrl } from '@ein/ui/lib';
import { formatTaken, yearOf } from '../../media/lib/capture-time.ts';

/** How long the pointer rests on a face or voice before its card opens, so a pass over the grid opens none. */
const OPEN_DELAY = 700;
const CARD_WIDTH = 260;
const GAP = 8;
/** Below this much room above the anchor the card opens under it instead. */
const ROOM_ABOVE = 280;

type PeekProps = {
  /** The photo a face was cut from, or the recording a voice is heard in. */
  filePath?: string;
  takenAt?: string;
  /** Lines under the date, such as how long a voice speaks. */
  extra?: ReactNode;
  /** One element that takes mouse handlers; it is not wrapped, so the grid's DOM stays as it was. */
  children: ReactElement<{ onMouseEnter?: (event: MouseEvent<HTMLElement>) => void; onMouseLeave?: (event: MouseEvent<HTMLElement>) => void }>;
};

/**
 * The whole picture behind a face or voice, on lingering over it: the photo (a video's poster, a
 * sound's waveform), its path, when it was taken and any extra lines; with none of these it adds nothing.
 *
 * A review grid holds hundreds of tiles, so a closed card costs a tile two mouse handlers and
 * nothing else: no popover state, no listeners, no DOM. The card is built when the pointer has
 * rested on the tile, placed once from the tile's box, and dropped when the pointer leaves or the
 * page scrolls under it.
 */
export function EvidencePeek({ filePath, takenAt, extra, children }: PeekProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => globalThis.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    // The card is placed once; anything that moves the tile takes it away instead of leaving it behind.
    globalThis.addEventListener('scroll', close, true);
    globalThis.addEventListener('resize', close);
    return () => {
      globalThis.removeEventListener('scroll', close, true);
      globalThis.removeEventListener('resize', close);
    };
  }, [anchor]);

  if (!filePath && !takenAt && !extra) return children;

  const target = cloneElement(children, {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      const element = event.currentTarget;
      globalThis.clearTimeout(timer.current);
      timer.current = globalThis.setTimeout(() => setAnchor(element.getBoundingClientRect()), OPEN_DELAY);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      globalThis.clearTimeout(timer.current);
      setAnchor(null);
    },
  });

  return (
    <>
      {target}
      {anchor && (
        <Portal>
          <PeekCard anchor={anchor}>
            {filePath && <Picture path={filePath} />}
            {takenAt && <Text size='sm' fw={500}>{formatTaken(takenAt, 'en-GB', { weekday: 'short' })}</Text>}
            {filePath && <Text size='xs' c='dimmed' style={{ wordBreak: 'break-all' }}>{filePath}</Text>}
            {extra && <Text size='xs' c='dimmed'>{extra}</Text>}
          </PeekCard>
        </Portal>
      )}
    </>
  );
}

/** The card itself, centred over the anchor (under it when there is no room above), kept on screen. */
function PeekCard({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const above = anchor.top >= ROOM_ABOVE;
  const left = Math.min(Math.max(GAP, anchor.left + anchor.width / 2 - CARD_WIDTH / 2), globalThis.innerWidth - CARD_WIDTH - GAP);
  return (
    <Paper
      shadow='md'
      withBorder
      p='xs'
      w={CARD_WIDTH}
      style={{
        position: 'fixed',
        left,
        ...(above ? { bottom: globalThis.innerHeight - anchor.top + GAP } : { top: anchor.bottom + GAP }),
        zIndex: getDefaultZIndex('popover'),
        // Never under the pointer's way: the card only shows, and the tile keeps its hover.
        pointerEvents: 'none',
      }}
    >
      <Stack gap={6}>{children}</Stack>
    </Paper>
  );
}

/** The file's grid rendition, then its square thumbnail, then nothing: a file may have neither. */
function Picture({ path }: { path: string }) {
  const sources = [gridUrl(path, true), thumbnailUrl(path, true)];
  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [path]);
  if (step >= sources.length) return null;
  return <Image src={sources[step]} alt='' mah={200} fit='contain' radius='sm' onError={() => setStep((current) => current + 1)} />;
}

/**
 * The year a face or voice was captured, on the bottom edge of its circle. The parent is
 * positioned and as wide as the circle.
 */
export function YearMark({ takenAt }: { takenAt?: string }) {
  const year = yearOf(takenAt);
  if (!year) return null;
  return (
    <Box
      component='span'
      style={{
        position: 'absolute',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '0 5px',
        borderRadius: 8,
        background: 'rgba(0, 0, 0, 0.6)',
        color: 'white',
        fontSize: 10,
        lineHeight: '15px',
        fontVariantNumeric: 'tabular-nums',
        pointerEvents: 'none',
      }}
    >
      {year}
    </Box>
  );
}
