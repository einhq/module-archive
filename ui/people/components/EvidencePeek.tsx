import { Box, HoverCard, Image, Stack, Text } from '@mantine/core';
import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { gridUrl, thumbnailUrl } from '@ein/ui/lib';
import { formatTaken, yearOf } from '../../media/lib/capture-time.ts';

/** How long the pointer rests on a face or voice before its card opens, so a pass over the grid opens none. */
const OPEN_DELAY = 700;

type PeekProps = {
  /** The photo a face was cut from, or the recording a voice is heard in. */
  filePath?: string;
  takenAt?: string;
  /** Lines under the date, such as how long a voice speaks. */
  extra?: ReactNode;
  children: ReactElement;
};

/**
 * The whole picture behind a face or voice, on lingering over it: the photo (a video's poster, a
 * sound's waveform), its path, when it was taken and any extra lines; with none of these it adds nothing.
 */
export function EvidencePeek({ filePath, takenAt, extra, children }: PeekProps) {
  if (!filePath && !takenAt && !extra) return children;
  return (
    <HoverCard openDelay={OPEN_DELAY} closeDelay={100} position='top' withArrow shadow='md' width={260}>
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown p='xs'>
        <Stack gap={6}>
          {filePath && <Picture path={filePath} />}
          {takenAt && <Text size='sm' fw={500}>{formatTaken(takenAt, 'en-GB', { weekday: 'short' })}</Text>}
          {filePath && <Text size='xs' c='dimmed' style={{ wordBreak: 'break-all' }}>{filePath}</Text>}
          {extra && <Text size='xs' c='dimmed'>{extra}</Text>}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
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
