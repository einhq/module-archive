import { Dialog, DialogActions } from '@ein/ui/components';
import { Button, Group, Radio, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import type { MediaFace } from '../hooks/useMediaDetails.ts';
import type { PersonEntry } from '../../people/hooks/usePeople.ts';
import { detachFromPerson, type RematchedFace, rematchFaces } from '../../people/lib/person-detach.ts';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { FaceCrop } from '../../people/components/FaceCrop.tsx';

type Choice = 'person' | 'new-person' | 'rematch';

/** Where the face went. */
export type FacePersonChange =
  | { kind: 'person' }
  /** A new unidentified person, still to be named. */
  | { kind: 'new-person'; personId: string }
  /** Wherever recognition placed it; null when it stayed unassigned. */
  | { kind: 'rematch'; person: RematchedFace['person'] };

type Props = {
  /** The face being decided; null when the dialog is closed. */
  face: MediaFace | null;
  /** People who already have a name, to pick from. */
  named: PersonEntry[];
  onClose: () => void;
  /** After the face has moved, before the dialog closes. */
  onChanged: (change: FacePersonChange) => Promise<void> | void;
};

/** The answers, as the dialog offers them; recognition only for a detected face, which has a vector. */
const choices = (face: MediaFace): { value: Choice; label: string; description: string }[] => [
  { value: 'person', label: 'Someone I know', description: 'Move the face to the person you pick.' },
  { value: 'new-person', label: 'Someone new', description: 'Nobody named yet: the face becomes a new unidentified person, for you to name now or later.' },
  ...(face.hasFace
    ? [{
      value: 'rematch' as const,
      label: 'Let recognition decide',
      description: face.personName
        ? `Matched again against everyone except ${face.personName}: it joins whoever it looks like, or becomes a new unidentified person.`
        : 'Matched again against everyone: it joins whoever it looks like, or becomes a new unidentified person.',
    }]
    : []),
];

/**
 * Who one face in a photo is, when recognition, or a person, got it wrong.
 *
 * The lightbox's face editor opens it for the selected box. The answers are `person-detach`'s, as
 * the person page's "Not …" offers them for many faces at once; leaving a face without anyone is
 * the editor's Remove.
 */
export function FacePersonDialog({ face, named, onClose, onChanged }: Props) {
  const [choice, setChoice] = useState<Choice>('person');
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const facePath = face?.facePath;
  useEffect(() => {
    setChoice('person');
    setTarget(null);
    setError(null);
  }, [facePath]);

  const people = useMemo(() => personOptions(named, face?.personPath), [named, face?.personPath]);

  // Escape closes this dialog alone. The lightbox beneath answers Escape too, from a listener that
  // the re-render closing this one reaches before the key does — so the key is taken here, at the
  // window, first. An open dropdown keeps its own Escape.
  const opened = face !== null;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!opened) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target as Element | null)?.getAttribute?.('data-mantine-stop-propagation') === 'true') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    globalThis.addEventListener('keydown', onKeyDown, true);
    return () => globalThis.removeEventListener('keydown', onKeyDown, true);
  }, [opened]);

  const apply = async () => {
    if (!face || (choice === 'person' && !target)) return;
    setBusy(true);
    setError(null);
    try {
      if (choice === 'rematch') {
        const [placed] = await rematchFaces(execCommand, [face.facePath]);
        await onChanged({ kind: 'rematch', person: placed?.person ?? null });
      } else if (choice === 'new-person') {
        const created = await detachFromPerson(execCommand, [face.facePath], { kind: 'new-person' });
        if (!created?.id) throw new Error('person-detach did not report the person it created');
        await onChanged({ kind: 'new-person', personId: created.id });
      } else {
        await detachFromPerson(execCommand, [face.facePath], { kind: 'person', path: target! });
        await onChanged({ kind: 'person' });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={opened}
      onClose={onClose}
      closeOnEscape={false}
      title='Who is this?'
      subtitle={face?.personName ? `Now marked as ${face.personName}` : 'Not marked as anyone'}
      icon='user-edit'
      pattern='person'
      size='md'
      // Above the lightbox, as its other dialogs are.
      zIndex={300}
    >
      {face && (
        <Stack gap='md'>
          <Group wrap='nowrap' align='flex-start'>
            <FaceCrop facePath={face.facePath} size={72} alt={face.personName ?? 'Face'} />
            <Radio.Group value={choice} onChange={(value) => setChoice(value as Choice)} style={{ flex: 1 }}>
              <Stack gap='xs'>
                {choices(face).map((option) => (
                  <Radio.Card key={option.value} value={option.value} p='sm' radius='md'>
                    <Group wrap='nowrap' align='flex-start'>
                      <Radio.Indicator />
                      <Stack gap={2}>
                        <Text size='sm' fw={500}>{option.label}</Text>
                        <Text size='xs' c='dimmed'>{option.description}</Text>
                      </Stack>
                    </Group>
                  </Radio.Card>
                ))}
              </Stack>
            </Radio.Group>
          </Group>
          {choice === 'person' && (
            <EntityPicker kind='person' label='Who it is' data-autofocus value={target} onChange={setTarget} data={people} comboboxProps={{ zIndex: 400 }} />
          )}
          {error && <Text size='sm' c='red'>{error}</Text>}
        </Stack>
      )}
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void apply()} loading={busy} disabled={choice === 'person' && !target}>
          {choice === 'rematch' ? 'Match again' : 'Move'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
