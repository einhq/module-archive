import { ActionIcon, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { TablerIcon } from '@ein/ui/components';
import { formatClock } from '@ein/ui/lib';
import { type Clip, playingClip, toggleClip } from '../lib/clip-player.ts';

type Props = {
  clip: Clip;
  /** Its diameter: a card's big voice, a preview's small one, a review tile's. */
  size: number;
  /** What the tooltip says besides play or stop: the recording's name. */
  label?: string;
};

/**
 * A voice where a face would be: a round button that plays the voice's longest turn and becomes a
 * stop while it plays. A click stays on the button, so a card under it does not open.
 */
export function VoiceClip({ clip, size, label }: Props) {
  useSignals();
  const playing = playingClip.value === clip.key;
  const action = playing ? 'Stop' : `Play ${formatClock(clip.end - clip.start)}`;

  return (
    <Tooltip label={label ? `${action} · ${label}` : action} withArrow openDelay={300}>
      <ActionIcon
        size={size}
        radius={size}
        variant={playing ? 'filled' : 'light'}
        color='grape'
        disabled={!clip.filePath}
        aria-label={playing ? 'Stop' : 'Play the voice'}
        aria-pressed={playing}
        onClick={(event) => {
          event.stopPropagation();
          toggleClip(clip);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <TablerIcon name={playing ? 'player-stop-filled' : 'player-play-filled'} size={Math.max(10, Math.round(size * 0.4))} />
      </ActionIcon>
    </Tooltip>
  );
}
