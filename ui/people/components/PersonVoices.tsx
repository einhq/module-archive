import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Center, Group, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { usePersonVoices } from '../hooks/usePersonVoices.ts';
import { execCommand } from '@ein/ui/signals';
import { detachFromPerson } from '../lib/person-detach.ts';
import { stopClip } from '../lib/clip-player.ts';
import { VoiceTile } from './VoiceTile.tsx';

type Props = {
  /** Person whose voices to show; null renders nothing. */
  personPath: string | null;
  /** Open a recording at a moment, so the rest of it can be heard. */
  onPlay?: (filePath: string, atSeconds: number) => void;
  /** The grid's own height bound. */
  maxHeight?: number;
  /** What to say for a person heard nowhere; without it nothing is shown (see below). */
  emptyText?: string;
};

/**
 * Every recording a named person is heard in, and the way to correct a wrong one: a tile per
 * recording that plays the voice's longest turn where it is and opens the recording at it. The
 * recordings the person speaks most in come first, because those are worth the seconds it takes.
 *
 * The only correction offered here is "not this person" — unassign and lock, which is what
 * `person-detach` does with no destination.
 */
export function PersonVoices({ personPath, onPlay, maxHeight = 420, emptyText }: Props) {
  const { voices, total, loading, error, removeVoices } = usePersonVoices(personPath);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => stopClip, []);

  if (!personPath) return null;
  if (loading) {
    return (
      <Center py='sm'>
        <Loader size='xs' />
      </Center>
    );
  }
  if (error) {
    return <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error.message}</Alert>;
  }
  // A person found by face recognition has no voices, and an empty box saying so would be noise
  // unless the page asks for it.
  if (total === 0) return emptyText ? <Text size='sm' c='dimmed'>{emptyText}</Text> : null;

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const detach = async () => {
    const paths = [...selected];
    if (paths.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await detachFromPerson(execCommand, paths, { kind: 'unassign' });
      removeVoices(paths);
      setSelected(new Set());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap='xs'>
      <Group justify='space-between' align='center'>
        <Text size='sm' fw={600}>
          Heard in
          <Text component='span' size='xs' c='dimmed' ml={6}>
            {total} recording{total === 1 ? '' : 's'}
          </Text>
        </Text>
        {selected.size > 0 && (
          <Button size='compact-xs' variant='light' color='red' loading={busy} onClick={detach}>
            Not this person ({selected.size})
          </Button>
        )}
      </Group>

      {actionError && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{actionError}</Alert>}

      <ScrollArea.Autosize mah={maxHeight} type='auto'>
        <Group gap='xs'>
          {voices.map((voice) => (
            <VoiceTile
              key={voice.voicePath}
              voice={voice}
              picked={selected.has(voice.voicePath)}
              onPick={() => toggle(voice.voicePath)}
              onOpen={voice.filePath && onPlay ? () => onPlay(voice.filePath!, voice.start) : undefined}
            />
          ))}
        </Group>
      </ScrollArea.Autosize>
    </Stack>
  );
}
