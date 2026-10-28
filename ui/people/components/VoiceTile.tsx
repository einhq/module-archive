import { ActionIcon, Box, Checkbox, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { formatClock } from '@ein/ui/lib';
import type { PersonVoice } from '../hooks/usePersonVoices.ts';
import { EvidencePeek, YearMark } from './EvidencePeek.tsx';
import { VoiceClip } from './VoiceClip.tsx';

type Props = {
  voice: PersonVoice;
  picked?: boolean;
  /** Tick or untick it; without this the tile cannot be picked. */
  onPick?: (event: { shiftKey: boolean }) => void;
  /** Open the recording in the lightbox at the voice's turn. */
  onOpen?: () => void;
};

/**
 * One recording a voice is heard in, the size of a face: a round button that plays the voice's
 * longest turn with the year on its edge, the recording's name under it, a way to open it in the
 * lightbox, and a box to pick it. Lingering shows the recording, its path, its date and how long
 * they speak in it.
 */
export function VoiceTile({ voice, picked = false, onPick, onOpen }: Props) {
  const name = voice.filePath?.split('/').pop() ?? voice.voicePath.split('/').pop() ?? voice.voicePath;
  const about = `Plays ${formatClock(voice.end - voice.start)} · speaks ${formatClock(voice.talkSeconds)} in it`;

  return (
    <Paper
      w={108}
      p='xs'
      radius='md'
      bg='var(--mrx-surface-raised)'
      pos='relative'
      style={{ outline: picked ? '2px solid var(--mantine-primary-color-filled)' : undefined }}
    >
      {onPick && (
        <Checkbox
          size='xs'
          radius='xl'
          checked={picked}
          readOnly
          aria-label={`Pick ${name}`}
          style={{ position: 'absolute', top: 6, left: 6, zIndex: 1 }}
          styles={{ input: { cursor: 'pointer' } }}
          onClick={(event) => onPick(event)}
        />
      )}
      {onOpen && voice.filePath && (
        <Tooltip label='Open in the lightbox' withArrow openDelay={300}>
          <ActionIcon size='sm' variant='subtle' color='gray' aria-label='Open in the lightbox' onClick={onOpen} style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}>
            <TablerIcon name='external-link' size={14} />
          </ActionIcon>
        </Tooltip>
      )}
      <EvidencePeek filePath={voice.filePath} takenAt={voice.takenAt} extra={about}>
        <Stack align='center' gap={6} pt={4}>
          <Box pos='relative'>
            <VoiceClip clip={{ key: voice.voicePath, ...voice }} size={56} untitled />
            <YearMark takenAt={voice.takenAt} />
          </Box>
          <Text size='xs' c='dimmed' ta='center' truncate w='100%'>{name}</Text>
        </Stack>
      </EvidencePeek>
    </Paper>
  );
}
