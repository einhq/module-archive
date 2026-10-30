import { Button, type ComboboxItem, Group, Stack, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { PEOPLE_ROOT } from '@archive/paths';
import type { MediaFace, MediaFaceDoubt } from '@archive/media/api';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { detachFromPerson } from '../../people/lib/person-detach.ts';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';

/** Why the face is in question, in a sentence. */
export const doubtReason = (doubt: MediaFaceDoubt): string => 'markedBy' in doubt ? `${doubt.markedBy} is not sure.` : `It looks more like ${doubt.likeName}.`;

/** The picker's value for a person still to be made, followed by their name. */
const NEW_PERSON = 'new:';

type Busy = 'mark' | 'confirm' | 'clear' | 'move';

/**
 * Whether a named person's face in the lightbox really is them, asked in the row's card
 * (`FaceRow`).
 *
 * Whoever may edit the photo can say who the face is instead — somebody already in the archive,
 * or a new person under the name typed — and move it there (`person-detach`), or, not knowing,
 * mark it doubtful (`face-doubt`): the person keeps the face, and their Faces tab lists it under
 * Doubtful until somebody answers. On a doubtful face it asks "Is this <name>?": yes keeps the
 * face as a human's assignment (`face-confirm`), and the same picker says who else. Somebody who
 * may not edit the photo sees only that it is in question.
 */
export function FaceDoubtForm({ face, name, canEdit, onDone, onChanged }: {
  face: MediaFace;
  name: string;
  canEdit: boolean;
  /** Once it is answered, to close the question. */
  onDone: () => void;
  /** After the face's doubt or person changed here, to read the photo again. */
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const { people } = usePeople(PEOPLE_ROOT, canEdit);

  // The name typed becomes an option of its own unless somebody is called exactly that. Once
  // picked, the search shows the option's label, so the name is read from the value instead.
  const newName = target?.startsWith(NEW_PERSON) ? target.slice(NEW_PERSON.length) : search.trim();
  const options = useMemo((): ComboboxItem[] => {
    const known = personOptions(people, face.personPath);
    if (!newName || known.some((option) => option.label.toLowerCase() === newName.toLowerCase())) return known;
    return [{ value: `${NEW_PERSON}${newName}`, label: `New person: ${newName}` }, ...known];
  }, [people, face.personPath, newName]);

  const doubt = face.doubt;

  const run = async (action: Busy, work: () => Promise<unknown>) => {
    setBusy(action);
    setError(null);
    try {
      await work();
      await onChanged();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const command = (line: string) => () => execCommand(`${line} ${shq(face.facePath)}`);

  const move = () =>
    run('move', async () => {
      if (!target) return;
      if (!target.startsWith(NEW_PERSON)) {
        await detachFromPerson(execCommand, [face.facePath], { kind: 'person', path: target });
        return;
      }
      const created = await detachFromPerson(execCommand, [face.facePath], { kind: 'new-person' });
      if (!created?.path) throw new Error('person-detach did not report the person it created');
      await execCommand(`person-name ${shq(created.path)} --name ${shq(target.slice(NEW_PERSON.length))}`);
    });

  return (
    <Stack gap='xs'>
      <Text size='sm' fw={500}>{doubt ? `Is this ${name}?` : `Not sure this is ${name}?`}</Text>
      {doubt && <Text size='xs' c='dimmed'>{doubtReason(doubt)}</Text>}
      {canEdit && doubt && (
        <Group gap='xs'>
          <Button data-autofocus size='xs' color='teal' loading={busy === 'confirm'} disabled={busy !== null} onClick={() => void run('confirm', command('face-confirm'))}>
            Yes
          </Button>
          {'markedBy' in doubt && (
            <Button
              size='xs'
              variant='subtle'
              color='gray'
              loading={busy === 'clear'}
              disabled={busy !== null}
              onClick={() => void run('clear', command('face-doubt --clear'))}
            >
              Withdraw
            </Button>
          )}
        </Group>
      )}
      {canEdit && (
        <Group gap='xs' wrap='nowrap' align='flex-end'>
          <EntityPicker
            kind='person'
            size='xs'
            style={{ flex: 1 }}
            placeholder={doubt ? 'No, it is…' : 'Who it is, or a new name'}
            value={target}
            onChange={setTarget}
            searchValue={search}
            onSearchChange={(value) => {
              setSearch(value);
              // Typing over a new person's label starts a new name.
              if (target?.startsWith(NEW_PERSON) && value !== `New person: ${target.slice(NEW_PERSON.length)}`) setTarget(null);
            }}
            data={options}
            nothingFoundMessage='Type a name to add someone new'
            // Inside the popover, so a click in the list is not a click outside it.
            comboboxProps={{ withinPortal: false }}
          />
          <Button size='xs' loading={busy === 'move'} disabled={!target || busy !== null} onClick={() => void move()}>Move</Button>
        </Group>
      )}
      {canEdit && !doubt && (
        <Button
          data-autofocus
          size='xs'
          variant='light'
          color='orange'
          loading={busy === 'mark'}
          disabled={busy !== null}
          onClick={() => void run('mark', command('face-doubt'))}
        >
          Mark as doubtful
        </Button>
      )}
      {error && <Text size='xs' c='red'>{error}</Text>}
    </Stack>
  );
}
