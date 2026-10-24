import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import type { UnknownPeopleMergeChange, UnknownPerson } from '../hooks/useUnknownPeople.ts';
import { execCommand } from '@ein/ui/signals';
import { mergeDestination } from '../lib/merge-destination.ts';
import { shq } from '@ein/ui/lib';

type Props = {
  /** The selected clusters, in grid order. */
  people: UnknownPerson[];
  onClear: () => void;
  /** A successful merge, or null when a partial failure needs a refresh. */
  onMerged: (change: UnknownPeopleMergeChange | null) => void;
  /** Say the selected clusters are not a person at all; they go from the grid once it resolves. */
  onDiscard: (people: UnknownPerson[]) => Promise<void>;
};

/**
 * Actions for the selected clusters, floating over the grid.
 *
 * Recognition splits one person into a big cluster and a tail of small ones, so folding a
 * handful together is the common repair — one exec rather than one dialog per cluster. The
 * other is the clusters that are nobody — hands, cushions, a pattern — discarded together.
 */
export function UnknownSelectionBar({ people, onClear, onMerged, onDiscard }: Props) {
  const [confirmOpen, confirmModal] = useDisclosure(false);
  const [discardOpen, discardModal] = useDisclosure(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (people.length === 0 && !busy) return null;

  const dst = mergeDestination(people);
  const sources = dst ? people.filter((p) => p.path !== dst.path) : [];
  const totalFaces = people.reduce((sum, p) => sum + p.faceCount, 0);

  const handleMerge = async () => {
    if (!dst || sources.length === 0) return;
    confirmModal.close();
    setError(null);
    setBusy(true);
    try {
      // One exec: person-merge takes every source before the destination, and reports which
      // ones landed if a source fails part way through.
      await execCommand(`person-merge ${sources.map((p) => shq(p.path)).join(' ')} ${shq(dst.path)}`);
      onClear();
      onMerged({ sources, destination: dst });
    } catch (err) {
      // A partial batch exits non-zero, so this is also the path where some sources did
      // merge — refetching below is what makes the grid tell the truth either way.
      setError(err instanceof Error ? err.message : String(err));
      onMerged(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    discardModal.close();
    setError(null);
    setBusy(true);
    try {
      await onDiscard(people);
      onClear();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Paper
        shadow='xl'
        radius='md'
        p='xs'
        bg='var(--mrx-surface-overlay)'
        style={{
          position: 'fixed',
          bottom: 'var(--mantine-spacing-lg)',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 200,
        }}
      >
        <Stack gap={4}>
          <Group gap='xs' wrap='nowrap'>
            <Text size='sm' fw={500} pl='xs'>{people.length} selected</Text>
            <Button
              size='xs'
              variant='light'
              leftSection={<TablerIcon name='users-group' size={14} />}
              onClick={confirmModal.open}
              loading={busy}
              disabled={sources.length === 0}
            >
              Merge
            </Button>
            <Button
              size='xs'
              variant='light'
              color='orange'
              leftSection={<TablerIcon name='user-x' size={14} />}
              onClick={discardModal.open}
              disabled={busy}
            >
              Not a person
            </Button>
            <Button
              size='xs'
              variant='subtle'
              color='gray'
              leftSection={<TablerIcon name='x' size={14} />}
              onClick={onClear}
              disabled={busy}
            >
              Clear
            </Button>
          </Group>
          {error && <Text size='xs' c='red' px='xs'>{error}</Text>}
        </Stack>
      </Paper>

      <Dialog opened={confirmOpen} onClose={confirmModal.close} title={`Merge ${people.length} into one person?`} icon='arrows-join' pattern='person' size='md' floating>
        <Stack gap='sm'>
          <Text size='sm'>
            <b>{dst?.name}</b> survives with all {totalFaces} faces. It keeps its own entry and stays unidentified — name it afterwards.
          </Text>
          <Paper p='xs' bg='var(--mrx-surface-sunken)' radius='sm' mah={200} style={{ overflowY: 'auto' }}>
            {sources.map((p) => (
              <Text key={p.path} size='xs' c='dimmed'>
                {p.name} — {p.faceCount} {p.faceCount === 1 ? 'face' : 'faces'}
              </Text>
            ))}
          </Paper>
        </Stack>
        <DialogActions hint='These entries are removed. Their faces are marked as decided by a human, so no later pass undoes it.'>
          <Button variant='default' onClick={confirmModal.close}>Cancel</Button>
          <Button onClick={handleMerge}>Merge</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        opened={discardOpen}
        onClose={discardModal.close}
        title={people.length === 1 ? 'Not a person?' : `${people.length}: not a person?`}
        icon='user-x'
        pattern='person'
        size='md'
        floating
      >
        <Text size='sm'>
          Every face and recording they hold loses its identity and is locked, so recognition leaves it alone from now on, and{' '}
          {people.length === 1 ? 'the entry is' : `the ${people.length} entries are`} removed. The photos and recordings themselves are untouched.
        </Text>
        <DialogActions>
          <Button variant='default' onClick={discardModal.close}>Cancel</Button>
          <Button color='orange' onClick={handleDiscard}>Not a person</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
