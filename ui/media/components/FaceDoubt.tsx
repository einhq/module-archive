import { ActionIcon, Box, Button, type ComboboxItem, Group, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { TablerIcon } from '@ein/ui/components';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import { PEOPLE_ROOT } from '@archive/paths';
import type { MediaFace, MediaFaceDoubt } from '@archive/media/api';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { detachFromPerson } from '../../people/lib/person-detach.ts';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';

/** Why the face is in question, in a sentence. */
const reason = (doubt: MediaFaceDoubt): string => 'markedBy' in doubt ? `${doubt.markedBy} is not sure.` : `It looks more like ${doubt.likeName}.`;

/** The picker's value for a person still to be made, followed by their name. */
const NEW_PERSON = 'new:';

/** The question mark's width and the row's gap before it, which it takes as it slides in. */
const BUTTON_WIDTH = 28;
const ROW_GAP = 'var(--mantine-spacing-xs)';

type Busy = 'mark' | 'confirm' | 'clear' | 'move';

/**
 * A question mark beside a named person in the lightbox: whether this face really is them.
 *
 * Whoever may edit the photo can say who the face is instead — somebody already in the archive,
 * or a new person under the name typed — and move it there (`person-detach`), or, not knowing,
 * mark it doubtful (`face-doubt`): the person keeps the face, and their Faces tab lists it under
 * Doubtful until somebody answers. On a doubtful face it is lit and asks "Is this <name>?": yes
 * keeps the face as a human's assignment (`face-confirm`), and the same picker says who else.
 * Somebody who may not edit the photo sees only that it is in question.
 *
 * Until the face is doubtful it slides in only while `revealed`, pushing what stands before it
 * aside, so a list of names is not a column of question marks.
 */
export function FaceDoubt({ face, name, canEdit, revealed, opened, onOpen, onChanged }: {
  face?: MediaFace;
  name: string;
  canEdit: boolean;
  /** The row is pointed at or focused. */
  revealed: boolean;
  opened: boolean;
  onOpen: (open: boolean) => void;
  /** After the face's doubt or person changed here, to read the photo again. */
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const { people } = usePeople(PEOPLE_ROOT, opened && canEdit);

  useEffect(() => {
    if (opened) return;
    setTarget(null);
    setSearch('');
    setError(null);
  }, [opened]);

  // The name typed becomes an option of its own unless somebody is called exactly that. Once
  // picked, the search shows the option's label, so the name is read from the value instead.
  const newName = target?.startsWith(NEW_PERSON) ? target.slice(NEW_PERSON.length) : search.trim();
  const options = useMemo((): ComboboxItem[] => {
    const known = personOptions(people, face?.personPath);
    if (!newName || known.some((option) => option.label.toLowerCase() === newName.toLowerCase())) return known;
    return [{ value: `${NEW_PERSON}${newName}`, label: `New person: ${newName}` }, ...known];
  }, [people, face?.personPath, newName]);

  if (!face?.personId) return null;
  const doubt = face.doubt;
  if (!doubt && !canEdit) return null;
  const shown = !!doubt || opened || revealed;

  const run = async (action: Busy, work: () => Promise<unknown>) => {
    setBusy(action);
    setError(null);
    try {
      await work();
      await onChanged();
      onOpen(false);
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

  const label = doubt ? `Is this ${name}? ${reason(doubt)}` : `Not sure this is ${name}?`;
  return (
    <Box
      style={{
        width: shown ? BUTTON_WIDTH : 0,
        marginLeft: shown ? 0 : `calc(-1 * ${ROW_GAP})`,
        opacity: shown ? 1 : 0,
        overflow: 'hidden',
        flexShrink: 0,
        transition: 'width 150ms ease, margin-left 150ms ease, opacity 150ms ease',
      }}
    >
      <Popover opened={opened} onChange={onOpen} position='bottom-end' withArrow shadow='md' width={280}>
        <Popover.Target>
          <Tooltip label={label} withinPortal multiline maw={260} disabled={opened}>
            <ActionIcon
              size='sm'
              variant={doubt ? 'light' : 'subtle'}
              color={doubt ? 'orange' : 'gray'}
              aria-label={doubt ? `Is this ${name}?` : `Doubt that this is ${name}`}
              onClick={() => onOpen(!opened)}
            >
              <TablerIcon name='help-circle' size={16} />
            </ActionIcon>
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown p='sm'>
          <Stack gap='xs'>
            <Text size='sm' fw={500}>{doubt ? `Is this ${name}?` : `Not sure this is ${name}?`}</Text>
            {doubt && <Text size='xs' c='dimmed'>{reason(doubt)}</Text>}
            {canEdit && doubt && (
              <Group gap='xs'>
                <Button size='xs' color='teal' loading={busy === 'confirm'} disabled={busy !== null} onClick={() => void run('confirm', command('face-confirm'))}>
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
        </Popover.Dropdown>
      </Popover>
    </Box>
  );
}
