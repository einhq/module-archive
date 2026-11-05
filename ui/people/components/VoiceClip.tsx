import { useEffect, useState } from 'react';
import { ActionIcon, Box, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { TablerIcon } from '@ein/ui/components';
import { fileUrl, formatClock } from '@ein/ui/lib';
import { type Clip, clipTime, playingClip, toggleClip } from '../lib/clip-player.ts';
import { coverTile, tileTimes } from '../../media/lib/storyboard.ts';

type Props = {
  clip: Clip;
  /** Its diameter: a card's big voice, a preview's small one, a review tile's. */
  size: number;
  /** What the tooltip says besides play or stop: the recording's name. */
  label?: string;
  /** Leave out the tooltip, where a card around the button says more. */
  untitled?: boolean;
};

/** How long each frame of the turn shows while the pointer rests on a video's voice. */
const SKIM_MS = 400;

/**
 * A voice where a face would be: a round button that plays the voice's longest turn and becomes a
 * stop while it plays. A click stays on the button, so a card under it does not open.
 *
 * A voice heard in a video shows the video inside the button, from its storyboard: the frame in the
 * middle of the turn, the turn's frames one after another while the pointer rests on it, and the
 * frame at what is heard while it plays.
 */
export function VoiceClip({ clip, size, label, untitled = false }: Props) {
  useSignals();
  const playing = playingClip.value === clip.key;
  const action = playing ? 'Stop' : `Play ${formatClock(clip.end - clip.start)}`;
  const sheet = clip.filePath ? clip.storyboard : undefined;
  const [hovered, setHovered] = useState(false);
  const [skim, setSkim] = useState<number | null>(null);

  useEffect(() => {
    if (!sheet || !hovered || playing) return;
    const times = tileTimes(sheet, clip.start, clip.end);
    if (times.length < 2) return;
    let i = 0;
    setSkim(times[0]);
    const timer = setInterval(() => setSkim(times[i = (i + 1) % times.length]), SKIM_MS);
    return () => {
      clearInterval(timer);
      setSkim(null);
    };
  }, [sheet, hovered, playing, clip.start, clip.end]);

  const seconds = playing ? clipTime.value : skim ?? (clip.start + clip.end) / 2;
  const iconSize = Math.max(10, Math.round(size * 0.4));
  const icon = <TablerIcon name={playing ? 'player-stop-filled' : 'player-play-filled'} size={iconSize} />;

  const button = (
    <ActionIcon
      size={size}
      radius={size}
      variant={playing && !sheet ? 'filled' : 'light'}
      color='grape'
      disabled={!clip.filePath}
      aria-label={playing ? 'Stop' : 'Play the voice'}
      aria-pressed={playing}
      onClick={(event) => {
        event.stopPropagation();
        toggleClip(clip);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={sheet
        ? {
          position: 'relative',
          overflow: 'hidden',
          outline: playing ? '2px solid var(--mantine-color-grape-filled)' : undefined,
          outlineOffset: 1,
        }
        : undefined}
    >
      {sheet
        ? (
          <>
            <img
              src={`${fileUrl(clip.filePath!)}/thumbnails/${sheet.name}?sha=${sheet.sha256.slice(0, 16)}`}
              alt=''
              loading='lazy'
              draggable={false}
              style={{ position: 'absolute', maxWidth: 'none', height: 'auto', pointerEvents: 'none', ...coverTile(sheet, seconds, size) }}
            />
            {
              /* The play sign over the picture, on a shade that keeps it legible on any frame;
                the shade lifts while the pointer rests there, so the frames are seen whole. */
            }
            <Box
              c='white'
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: hovered && !playing ? 'transparent' : 'rgba(0, 0, 0, 0.3)',
                filter: 'drop-shadow(0 0 2px rgba(0, 0, 0, 0.6))',
                opacity: hovered && !playing ? 0.6 : 1,
              }}
            >
              {icon}
            </Box>
          </>
        )
        : icon}
    </ActionIcon>
  );
  if (untitled) return button;
  return (
    <Tooltip label={label ? `${action} · ${label}` : action} withArrow openDelay={300}>
      {button}
    </Tooltip>
  );
}
