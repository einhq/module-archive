import { Alert, Button, Select, SimpleGrid, Stack, TextInput } from '@mantine/core';
import { PEOPLE_ROOT } from '@archive/paths';
import { currentUser, execCommand, notify } from '@ein/ui/signals';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogActions, MarkdownEditor, TablerIcon } from '@ein/ui/components';
import { bucketLabel, shq } from '@ein/ui/lib';
import type { TrashPutResult } from '@ein/api';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { usePeople } from '../hooks/usePeople.ts';

// Quote a value for the shell (double-quote, escaping the chars the shell expands)
function q(s: string): string {
  return `"${s.replace(/([\\"$`])/g, '\\$1')}"`;
}

const EVENT_TYPE_OPTIONS = [
  { value: 'generic', label: 'Generic' },
  { value: 'birth', label: 'Birth' },
  { value: 'death', label: 'Death' },
  { value: 'marriage', label: 'Marriage' },
  { value: 'engagement', label: 'Engagement' },
];

/** An event file as the dialog changes it: its date, its text, and the person its `writer` link names. */
type EditableEvent = { path: string; date: string; text: string; writer?: { path: string } };

type EventModalProps =
  & {
    /** Albums are narrative timelines, so their events deliberately have no life-event subtype. */
    genericOnly?: boolean;
    /** The date a new event starts with, until the reader types one; it may arrive after the dialog opens. */
    defaultDate?: string;
    opened: boolean;
    onClose: () => void;
    onApplied: () => void;
  }
  & (
    /** The person or album a new event is added to. */
    | { ownerPath: string; ownerName: string; event?: undefined }
    /** The event to change. */
    | { event: EditableEvent; ownerPath?: undefined; ownerName?: undefined }
  );

/**
 * Add a dated note to the person or album currently being viewed (`person-add-event` names
 * it), or change an existing one's date, text and writer, or delete it. Changing one keeps its
 * type: a person's `born` / `died` is set from a birth or death as it is added. The writer is a
 * person, linked as the event's `writer`; an event without one is by whoever added it. A new
 * event starts as written by the reader's own person, when their account is linked to one.
 */
export function EventModal({ ownerPath, ownerName, event, genericOnly = false, defaultDate, opened, onClose, onApplied }: EventModalProps) {
  const [eventType, setEventType] = useState('generic');
  const [date, setDate] = useState('');
  const [body, setBody] = useState('');
  const [writer, setWriter] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the reader has set these themselves, so a default arriving late leaves them be.
  const dateTouched = useRef(false);
  const writerTouched = useRef(false);

  useEffect(() => {
    if (!opened) return;
    setEventType('generic');
    setDate(event?.date ?? '');
    setBody(event?.text ?? '');
    setWriter(event?.writer?.path ?? null);
    setError(null);
    dateTouched.current = false;
    writerTouched.current = false;
  }, [opened, ownerPath, event]);

  // Listed only while the dialog is open: a picker nobody sees is not worth a listing of everyone.
  const { people } = usePeople(PEOPLE_ROOT, opened);
  const writerOptions = useMemo(() => personOptions(people), [people]);

  useEffect(() => {
    if (opened && !event && !dateTouched.current) setDate(defaultDate ?? '');
  }, [opened, event, defaultDate]);

  // The account's person may have been deleted since it was linked: only one the picker lists is offered.
  const ownPerson = currentUser.value?.personPath;
  useEffect(() => {
    if (!opened || event || writerTouched.current) return;
    setWriter(ownPerson && writerOptions.some((option) => option.value === ownPerson) ? ownPerson : null);
  }, [opened, event, ownPerson, writerOptions]);

  // An album shows an event as dated text, so it needs both; a person's timeline
  // has a use for either alone.
  const incomplete = genericOnly ? !date.trim() || !body.trim() : !date.trim() && !body.trim();

  const command = (): string | undefined => {
    if (!event) {
      let line = `person-add-event ${q(ownerPath)} --type ${genericOnly ? 'generic' : eventType}`;
      if (date.trim()) line += ` --date ${q(date.trim())}`;
      if (body.trim()) line += ` --body ${q(body.trim())}`;
      if (writer) line += ` --writer ${q(writer)}`;
      return line;
    }
    const steps: string[] = [];
    if (date.trim() !== event.date) steps.push(date.trim() ? `attrs -s ${q(`date=${date.trim()}`)} ${q(event.path)}` : `attrs -d date ${q(event.path)}`);
    if (body.trim() !== event.text) steps.push(`printf '%s' ${q(body.trim())} > ${q(event.path)}`);
    if ((writer ?? undefined) !== event.writer?.path) {
      const link = q(`${event.path}/writer`);
      steps.push(writer ? `ln -s -f ${q(writer)} ${link}` : `rm ${link}`);
    }
    return steps.length > 0 ? steps.join(' && ') : undefined;
  };

  const submit = async () => {
    if (incomplete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const line = command();
      if (line) await execCommand(line);
      onClose();
      if (line) onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // To the reader's trash, so nothing asks first; the toast's Undo puts it back.
  const remove = async () => {
    if (!event || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const { entries } = await execCommand<TrashPutResult>(`trash put ${shq(event.path)}`);
      onClose();
      onApplied();
      notify({
        message: 'Event moved to the trash',
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await execCommand(`trash restore ${entries.map((entry) => shq(entry.id)).join(' ')}`);
              onApplied();
            } catch (err) {
              notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
            }
          },
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const action = event ? 'Save' : 'Add event';
  const withType = !genericOnly && !event;

  return (
    // In the colour of the page it is added from: an album's, or a person's.
    <Dialog
      opened={opened}
      onClose={onClose}
      title={event ? 'Edit event' : 'Add event'}
      subtitle={event ? bucketLabel(event.date.slice(0, 10)) : `To ${ownerName}`}
      icon='calendar-event'
      pattern={genericOnly ? 'album' : 'person'}
      size='lg'
      onSubmit={submit}
    >
      <Stack gap='md'>
        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
        <SimpleGrid cols={{ base: 1, sm: withType ? 2 : 1 }} spacing='md'>
          {withType && (
            <Select
              label='Type'
              data={EVENT_TYPE_OPTIONS}
              value={eventType}
              onChange={(value) => setEventType(value ?? 'generic')}
              allowDeselect={false}
            />
          )}
          <TextInput
            label='Date'
            placeholder={genericOnly ? '2005-06-15' : 'Optional (2005-06-15)'}
            value={date}
            onChange={(change) => {
              dateTouched.current = true;
              setDate(change.currentTarget.value);
            }}
            required={genericOnly}
            data-autofocus={event ? undefined : true}
          />
        </SimpleGrid>
        <MarkdownEditor
          label='Description'
          placeholder={genericOnly ? 'What happened' : 'Optional'}
          value={body}
          onChange={setBody}
          required={genericOnly}
          minRows={4}
          autoFocus={Boolean(event)}
        />
        <EntityPicker
          kind='person'
          label='Written by'
          placeholder={event ? 'Whoever added it' : 'You'}
          data={writerOptions}
          value={writer}
          onChange={(value) => {
            writerTouched.current = true;
            setWriter(value);
          }}
          clearable
        />
      </Stack>
      <DialogActions>
        {event && (
          <Button
            variant='light'
            color='red'
            mr='auto'
            leftSection={<TablerIcon name='trash' size={16} />}
            onClick={remove}
            loading={deleting}
            disabled={submitting}
          >
            Delete
          </Button>
        )}
        <Button variant='default' onClick={onClose} disabled={submitting || deleting}>Cancel</Button>
        <Button type='submit' loading={submitting} disabled={incomplete || deleting}>{action}</Button>
      </DialogActions>
    </Dialog>
  );
}
