import { ActionIcon, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { TablerIcon } from '@ein/ui/components';
import { formatClock } from '@ein/ui/lib';
import { playbackPosition, playbackSeek } from '../signals/playback.ts';

/** Where a face is next on screen after `position`, coming round to its first sighting at the end. */
const nextAppearance = (appearances: [number, number][], position: number): [number, number] | undefined =>
  appearances.find(([start]) => start > position + 0.5) ?? appearances[0];

/**
 * A button beside a face or a person in a video's sidebar that plays from the next moment they
 * are on screen. Nothing while no player is mounted, or for a face no video shows.
 */
export function SeenAt({ appearances, name }: { appearances?: [number, number][]; name: string }) {
  useSignals();
  const seek = playbackSeek.value;
  if (!seek || !appearances || appearances.length === 0) return null;
  const next = nextAppearance(appearances, playbackPosition.value)!;
  const times = appearances.length === 1 ? 'once' : `${appearances.length} times`;
  return (
    <Tooltip label={`Seen ${times} · next at ${formatClock(next[0])}`} withinPortal>
      <ActionIcon size='sm' variant='subtle' color='gray' aria-label={`Play from where ${name} is seen`} onClick={() => seek(next[0])}>
        <TablerIcon name='player-play' size={14} />
      </ActionIcon>
    </Tooltip>
  );
}
