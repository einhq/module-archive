import { Button, type ButtonProps, type ComboboxItem, Divider, Group, Stack, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { TablerIcon } from '@ein/ui/components';
import { PEOPLE_ROOT } from '@archive/paths';
import type { MediaFace, MediaFaceDoubt } from '@archive/media/api';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { detachFromPerson } from '../../people/lib/person-detach.ts';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';

/** Why the face is in question, in a sentence. */
export const doubtReason = (doubt: MediaFaceDoubt): string => 'markedBy' in doubt ? `${doubt.markedBy} is not sure.` : `It looks more like ${doubt.likeName}.`;

/**
 * Says a face is not a person: a detected face is taken off its person and locked, so recognition
 * does not put it back (`person-detach`); a tag, which only a human drew or an import carried, is
 * removed (`face-remove`).
 */
const dismissFace = (face: MediaFace) => execCommand(`${face.hasFace ? 'person-detach' : 'face-remove'} ${shq(face.facePath)}`);

/** "Not a person", or "Remove tag" for a tag, done on a second click; orange, as the unknown-person dialog's. */
function NotAPersonButton({ face, busy, disabled, onConfirm, variant = 'light', ...props }: ButtonProps & {
  face: MediaFace;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size='xs'
      variant={armed ? 'filled' : variant}
      color='orange'
      leftSection={<TablerIcon name={face.hasFace ? 'user-x' : 'trash'} size={16} />}
      loading={busy}
      disabled={disabled}
      onClick={() => armed ? onConfirm() : setArmed(true)}
      {...props}
    >
      {face.hasFace ? (armed ? 'Confirm not a person' : 'Not a person') : (armed ? 'Confirm remove' : 'Remove tag')}
    </Button>
  );
}

/**
 * What the card of a face nobody has named offers (`FaceRow`): to name them, in the dialog the
 * row's name opens, and — for whoever may edit the photo — to say the face is not a person.
 */
export function UnknownFaceActions({ face, canEdit, onName, onDone, onChanged }: {
  /** The face as the photo holds it; without it, there is only the naming. */
  face?: MediaFace;
  canEdit: boolean;
  onName: () => void;
  onDone: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = async (target: MediaFace) => {
    setBusy(true);
    setError(null);
    try {
      await dismissFace(target);
      await onChanged();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size='xs' variant='subtle' color='gray' justify='flex-start' leftSection={<TablerIcon name='user-edit' size={16} />} disabled={busy} onClick={onName}>
        Name this person
      </Button>
      {canEdit && face && (
        <NotAPersonButton
          face={face}
          busy={busy}
          disabled={busy}
          onConfirm={() => void dismiss(face)}
          variant='subtle'
          justify='flex-start'
        />
      )}
      {error && <Text size='xs' c='red' px='xs'>{error}</Text>}
    </>
  );
}

/** The picker's value for a person still to be made, followed by their name. */
const NEW_PERSON = 'new:';

type Busy = 'mark' | 'confirm' | 'clear' | 'move' | 'unknown' | 'dismiss';

/**
 * That a named person's face in the lightbox is wrong, said in the row's card (`FaceRow`).
 *
 * Whoever may edit the photo can say who the face is instead — somebody already in the archive,
 * or a new person under the name typed — and move it there (`person-detach`), mark it unknown
 * again, on an unidentified person of its own to be named later (`person-detach --to-new-person`),
 * say it is not a person at all (`dismissFace`),
 * or, not knowing, mark it doubtful (`face-doubt`): the person keeps the face, and their Faces tab lists it under
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
      <Text size='sm' fw={500}>{doubt ? `Is this ${name}?` : `Who is this, if not ${name}?`}</Text>
      {doubt && <Text size='xs' c='dimmed'>{doubtReason(doubt)}</Text>}
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
      {canEdit && (
        <>
          <Divider />
          {/* One answer to a line, the width of the card. */}
          <Stack gap={6}>
            {doubt && (
              <Button
                data-autofocus
                size='xs'
                color='teal'
                leftSection={<TablerIcon name='check' size={16} />}
                loading={busy === 'confirm'}
                disabled={busy !== null}
                onClick={() => void run('confirm', command('face-confirm'))}
              >
                Yes
              </Button>
            )}
            {doubt && 'markedBy' in doubt && (
              <Button
                size='xs'
                variant='light'
                color='gray'
                leftSection={<TablerIcon name='arrow-back-up' size={16} />}
                loading={busy === 'clear'}
                disabled={busy !== null}
                onClick={() => void run('clear', command('face-doubt --clear'))}
              >
                Withdraw
              </Button>
            )}
            {!doubt && (
              <Button
                data-autofocus
                size='xs'
                variant='light'
                color='yellow'
                leftSection={<TablerIcon name='help-circle' size={16} />}
                loading={busy === 'mark'}
                disabled={busy !== null}
                onClick={() => void run('mark', command('face-doubt'))}
              >
                Mark as doubtful
              </Button>
            )}
            <Button
              size='xs'
              variant='light'
              color='blue'
              leftSection={<TablerIcon name='user-question' size={16} />}
              loading={busy === 'unknown'}
              disabled={busy !== null}
              onClick={() => void run('unknown', () => detachFromPerson(execCommand, [face.facePath], { kind: 'new-person' }))}
            >
              Mark as unknown
            </Button>
            <NotAPersonButton face={face} busy={busy === 'dismiss'} disabled={busy !== null} onConfirm={() => void run('dismiss', () => dismissFace(face))} />
          </Stack>
        </>
      )}
      {error && <Text size='xs' c='red'>{error}</Text>}
    </Stack>
  );
}
