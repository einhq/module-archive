import { Button, Group, type OptionsFilter, Paper, Select, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { PEOPLE_ROOT } from '@archive/paths';
import { namesHaveWords, nameWords } from '@archive/people/name-match';
import type { PersonEntry } from '../hooks/usePeople.ts';
import type { PersonFace } from '../hooks/usePersonFaces.ts';
import type { PersonVoice } from '../hooks/usePersonVoices.ts';
import { type DetachDestination, detachFromPerson } from '../lib/person-detach.ts';
import type { AppliedFaceChange } from '../lib/face-change.ts';
import { regionCount } from '../lib/face-crop.ts';
import { PersonOption } from './PersonOption.tsx';
import { execCommand } from '@ein/ui/signals';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';

/** The destination being confirmed; null when no dialog is up. */
type Pending = DetachDestination['kind'] | null;

/** A move that went through: the faces as a face change can reconcile them, and the recordings. */
export type EvidenceChange = AppliedFaceChange & { removedVoices: PersonVoice[] };

type Props = {
  /** The picked faces and recordings, in the order they are shown. */
  faces: PersonFace[];
  voices: PersonVoice[];
  /** Every face and recording this person has, so taking all of them is told apart. */
  total: number;
  /** People who already have a name, as a destination for what is picked. */
  named: PersonEntry[];
  onClear: () => void;
  /** A successful change, or null when a partial failure needs a refresh. */
  onDetached: (change: EvidenceChange | null) => void;
  /** "Not a person" with everything picked: the whole person is discarded, which the caller confirms. */
  onDiscard: () => void;
  /**
   * Told when a confirm dialog goes up.
   *
   * The dialog around this one handles Escape itself, and has to stand down while a dialog of
   * ours is on top — otherwise one press closes the whole review instead of the confirm.
   */
  onDialog?: (open: boolean) => void;
};

/** "3 faces", "1 recording", "2 faces and 1 tag and 1 recording". */
const pickedCount = (faces: PersonFace[], voices: PersonVoice[]): string => {
  const tags = faces.filter((face) => !face.hasFace).length;
  const parts = faces.length > 0 ? [regionCount(faces.length - tags, tags)] : [];
  if (voices.length > 0) parts.push(`${voices.length} ${voices.length === 1 ? 'recording' : 'recordings'}`);
  return parts.join(' and ');
};

/**
 * What to do with the faces and recordings picked out of one person.
 *
 * The three things `person-detach` can mean, which are three different findings: these are
 * somebody else, these are *that* person, these are not a person at all. The last one locks them,
 * so the next recognition pass does not put them back. Faces and voices alike: the command takes
 * any detection that carries a person. With everything picked, "Not a person" is said of the person
 * themselves, and the other two are naming them or adding them to someone.
 */
export function EvidenceSelectionBar({ faces, voices, total, named, onClear, onDetached, onDiscard, onDialog }: Props) {
  const [pending, setPending] = useState<Pending>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A searchable list cut to what matches, rather than an avatar row for everyone named.
  const people = useMemo(() => named.map((person) => ({ value: `${PEOPLE_ROOT}/${person.id}`, label: person.name })), [named]);
  const namesOf = useMemo(() => new Map(named.map((person) => [`${PEOPLE_ROOT}/${person.id}`, [person.name, person.fullname, person.birthname]])), [named]);
  /** As the finder matches people: every typed word in one of a person's names, so "Anna Andersson" offers "Anna B Andersson". */
  const filter: OptionsFilter = ({ options, search }) => {
    const words = nameWords(search);
    if (words.length === 0) return options;
    return options.filter((option) => 'value' in option && namesHaveWords(words, namesOf.get(option.value) ?? [option.label]));
  };

  // Reported from one place rather than at each open and close, which is how the two
  // would drift apart and leave Escape stranded.
  useEffect(() => {
    onDialog?.(pending !== null);
  }, [pending]);

  const picked = faces.length + voices.length;
  if (picked === 0 && !busy) return null;

  /** Everything picked: moving it all is naming the person, or adding them to someone. */
  const emptiesPerson = picked >= total;
  const count = pickedCount(faces, voices);

  const close = () => {
    setPending(null);
    setTarget(null);
  };

  const apply = async () => {
    if (!pending) return;
    const destination: DetachDestination = pending === 'person'
      ? { kind: 'person', path: target ?? '' }
      : pending === 'unassign'
      ? { kind: 'unassign' }
      : { kind: 'new-person' };
    if (destination.kind === 'person' && !destination.path) return;

    close();
    setError(null);
    setBusy(true);
    try {
      const paths = [...faces.map((face) => face.facePath), ...voices.map((voice) => voice.voicePath)];
      const landed = await detachFromPerson(execCommand, paths, destination);
      const created = destination.kind === 'new-person' ? landed?.id && landed.name ? [{ person: { id: landed.id, path: landed.path, name: landed.name }, faces }] : null : [];
      if (created === null) throw new Error('person-detach did not report the new person details');
      onClear();
      onDetached({ removedFaces: faces, removedVoices: voices, created });
    } catch (err) {
      // A batch that fails part way through has already moved some, so the refetch the caller
      // does is what makes the review tell the truth either way.
      setError(err instanceof Error ? err.message : String(err));
      onDetached(null);
    } finally {
      setBusy(false);
    }
  };

  const confirm = {
    'new-person': {
      title: `Split off ${count}?`,
      body: 'They become a new unidentified person of their own. Name that person afterwards, or add it to someone.',
    },
    person: {
      title: `Move ${count} to someone?`,
      body: 'They move to the person you pick and count as decided by a human, so no later pass moves them again.',
    },
    unassign: {
      title: `${count}: not a person?`,
      body: 'They lose their identity and are locked, so recognition leaves them alone from now on. Nothing is deleted — this only says who they are not.',
    },
  };

  return (
    <>
      <Paper p='xs' radius='md' bg='var(--mrx-surface-overlay)' shadow='md'>
        <Stack gap={4}>
          <Group gap='xs' wrap='wrap'>
            <Text size='sm' fw={500} pl='xs'>{count} picked</Text>
            <Button
              size='xs'
              variant='light'
              leftSection={<TablerIcon name='user-plus' size={14} />}
              onClick={() => setPending('new-person')}
              loading={busy}
              disabled={emptiesPerson}
            >
              Split off as someone new
            </Button>
            <Button
              size='xs'
              variant='light'
              leftSection={<TablerIcon name='arrow-right' size={14} />}
              onClick={() => setPending('person')}
              disabled={busy || emptiesPerson || named.length === 0}
            >
              Move to…
            </Button>
            <Button
              size='xs'
              variant='light'
              color='orange'
              leftSection={<TablerIcon name='user-minus' size={14} />}
              onClick={() => emptiesPerson ? onDiscard() : setPending('unassign')}
              disabled={busy}
            >
              Not a person
            </Button>
            <Button size='xs' variant='subtle' color='gray' leftSection={<TablerIcon name='x' size={14} />} onClick={onClear} disabled={busy}>
              Clear
            </Button>
          </Group>
          {emptiesPerson && (
            <Text size='xs' c='dimmed' px='xs'>
              That is everything they have. To give all of it to someone, name them or add them to someone above instead. Not a person removes them.
            </Text>
          )}
          {error && <Text size='xs' c='red' px='xs'>{error}</Text>}
        </Stack>
      </Paper>

      <Dialog
        opened={pending !== null}
        onClose={close}
        title={pending ? confirm[pending].title : ''}
        icon={pending === 'unassign' ? 'user-x' : pending === 'person' ? 'arrow-right' : 'cut'}
        pattern='person'
        size='md'
        floating
        zIndex={300}
      >
        <Text size='sm'>{pending ? confirm[pending].body : ''}</Text>
        {pending === 'person' && (
          <Select
            data-autofocus
            searchable
            limit={30}
            label='Who they are'
            placeholder='Pick someone'
            data={people}
            filter={filter}
            renderOption={({ option }) => <PersonOption path={option.value} name={option.label} />}
            value={target}
            onChange={setTarget}
            nothingFoundMessage='Nobody by that name'
          />
        )}
        <DialogActions>
          <Button variant='default' onClick={close}>Cancel</Button>
          <Button onClick={apply} disabled={pending === 'person' && !target}>
            {pending === 'unassign' ? 'Unassign and lock' : pending === 'person' ? 'Move' : 'Split off'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
