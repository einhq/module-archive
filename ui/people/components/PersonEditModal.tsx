import { Dialog, DialogActions, MarkdownEditor, TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { PersonContact, PersonInfo } from '../hooks/usePeople.ts';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { LabelsField, useLabelsDraft } from '../../components/NodeLabels.tsx';

type PersonEditModalProps = {
  opened: boolean;
  onClose: () => void;
  person: PersonInfo;
  /** Re-read the header and every derived fact after saving. */
  onApplied: () => void;
};

type ProfileDraft = {
  name: string;
  fullname: string;
  birthname: string;
  gender: string | null;
  born: string;
  died: string;
  contacts: PersonContact[];
  allergies: string;
  description: string;
};

const draftFor = (person: PersonInfo): ProfileDraft => ({
  name: person.name,
  fullname: person.fullname ?? '',
  birthname: person.birthname ?? '',
  gender: person.gender ?? null,
  born: person.born ?? '',
  died: person.died ?? '',
  contacts: person.contact ?? [],
  allergies: person.allergies ?? '',
  description: person.description ?? '',
});

const GENDERS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Unknown' },
];

/**
 * The editable facts carried directly by a person node, in a dialog.
 *
 * The facts are written in one `person-update`. That makes clearing optional
 * fields explicit and keeps the contact list an actual JSON array, rather than a
 * string that merely looks like one. The labels are written with `label`.
 */
export function PersonEditModal({ opened, onClose, person, onApplied }: PersonEditModalProps) {
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFor(person));
  const labels = useLabelsDraft(person.path, opened);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setDraft(draftFor(person));
    setError(null);
  }, [opened, person]);

  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const setContact = (index: number, key: keyof PersonContact, value: string) => {
    setDraft((current) => ({
      ...current,
      contacts: current.contacts.map((contact, contactIndex) => contactIndex === index ? { ...contact, [key]: value } : contact),
    }));
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name) {
      setError('a name is needed');
      return;
    }

    const contacts = draft.contacts
      .map((contact) => ({ type: contact.type.trim(), data: contact.data.trim() }))
      .filter((contact) => contact.type || contact.data);
    if (contacts.some((contact) => !contact.type || !contact.data)) {
      setError('each contact needs both a type and details');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // `person-update` owns the rules — what a date or a gender may be — and clears a field given empty.
      // `--flag=value`, never two words: a value may start with a dash.
      const fields: Array<[string, string]> = [
        ['name', name],
        ['fullname', draft.fullname.trim()],
        ['birthname', draft.birthname.trim()],
        ['born', draft.born.trim()],
        ['died', draft.died.trim()],
        ['allergies', draft.allergies.trim()],
        ['description', draft.description.trim()],
        ['gender', draft.gender ?? ''],
        ['contact', contacts.length ? JSON.stringify(contacts) : ''],
      ];
      await execCommand(`person-update ${shq(person.path)} ${fields.map(([key, value]) => `--${key}=${shq(value)}`).join(' ')}`);
      await labels.save();
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='Edit person' subtitle={person.name} icon='pencil' pattern='person' size='lg' onSubmit={save}>
      <Stack gap='lg'>
        <Text c='dimmed' size='sm'>Leave an optional field empty to remove it.</Text>

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput data-autofocus required label='Name' value={draft.name} onChange={(event) => set('name', event.currentTarget.value)} />
          <TextInput label='Full name' value={draft.fullname} onChange={(event) => set('fullname', event.currentTarget.value)} />
          <TextInput label='Birth name' value={draft.birthname} onChange={(event) => set('birthname', event.currentTarget.value)} />
          <Select label='Gender' data={GENDERS} value={draft.gender} onChange={(value) => set('gender', value)} clearable />
          <TextInput label='Born' value={draft.born} onChange={(event) => set('born', event.currentTarget.value)} placeholder='YYYY, YYYY-MM or YYYY-MM-DD' />
          <TextInput label='Died' value={draft.died} onChange={(event) => set('died', event.currentTarget.value)} placeholder='YYYY, YYYY-MM or YYYY-MM-DD' />
        </SimpleGrid>

        <Stack gap='xs'>
          <Group justify='space-between'>
            <Text fw={500} size='sm'>Contact information</Text>
            <Button
              size='compact-xs'
              variant='light'
              leftSection={<TablerIcon name='plus' size={14} />}
              onClick={() => set('contacts', [...draft.contacts, { type: '', data: '' }])}
            >
              Add contact
            </Button>
          </Group>
          {draft.contacts.map((contact, index) => (
            <Group key={index} align='end' wrap='nowrap'>
              <TextInput
                label={index === 0 ? 'Type' : undefined}
                placeholder='Email, phone, address…'
                value={contact.type}
                onChange={(event) => setContact(index, 'type', event.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <TextInput
                label={index === 0 ? 'Details' : undefined}
                value={contact.data}
                onChange={(event) => setContact(index, 'data', event.currentTarget.value)}
                style={{ flex: 2 }}
              />
              <Button
                variant='subtle'
                color='red'
                px={8}
                aria-label='Remove contact'
                onClick={() => set('contacts', draft.contacts.filter((_, contactIndex) => contactIndex !== index))}
              >
                <TablerIcon name='trash' size={16} />
              </Button>
            </Group>
          ))}
          {draft.contacts.length === 0 && <Text c='dimmed' size='sm'>No contact information recorded.</Text>}
        </Stack>

        <TextInput label='Allergies' value={draft.allergies} onChange={(event) => set('allergies', event.currentTarget.value)} />
        <MarkdownEditor label='Description' placeholder='Optional' value={draft.description} onChange={(value) => set('description', value)} />
        <LabelsField draft={labels} />

        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
