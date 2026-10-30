import { PEOPLE_ROOT } from '@archive/paths';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, SegmentedControl, Select, Stack, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { PersonEntry } from '../hooks/usePeople.ts';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { personSlug } from '../lib/person-slug.ts';

export type RelationKind = 'parent' | 'partner' | 'child';

/** How a parent tie was formed. Blood is the default and is not written down. */
const PARENT_KINDS = [
  { value: 'blood', label: 'Blood' },
  { value: 'adoptive', label: 'Adoptive' },
  { value: 'step', label: 'Step' },
  { value: 'foster', label: 'Foster' },
];

const PARTNER_KINDS = [
  { value: 'partner', label: 'Partner' },
  { value: 'married', label: 'Married' },
];

const TITLES: Record<RelationKind, string> = { parent: 'Add a parent', partner: 'Add a partner', child: 'Add a child' };

const ICONS: Record<RelationKind, string> = { parent: 'user-up', partner: 'heart-handshake', child: 'baby-carriage' };

type RelationModalProps = {
  /** The person the relation is being added to, or null while closed. */
  subject: { path: string; name: string } | null;
  kind: RelationKind;
  /** Everyone already in the archive, to pick from. */
  people: PersonEntry[];
  onClose: () => void;
  /** The relation was written; the caller re-reads the graph. */
  onApplied: () => void;
};

/**
 * Add one relation, to somebody who exists or to somebody who does not yet.
 *
 * The server's refusals are the useful part of this dialog and are shown
 * verbatim: `person-set-parent` rejects a tie that would make somebody their own
 * ancestor, and a duplicate, and knowing *which* is the difference between
 * fixing the data and trying again.
 */
export function RelationModal({ subject, kind, people, onClose, onApplied }: RelationModalProps) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tie, setTie] = useState('blood');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh dialog every time it opens: leaving the last pick in place is how
  // somebody adds a parent to the wrong person.
  useEffect(() => {
    if (!subject) return;
    setMode('existing');
    setPick(null);
    setName('');
    setTie(kind === 'partner' ? 'partner' : 'blood');
    setFrom('');
    setTo('');
    setError(null);
  }, [subject, kind]);

  const options = personOptions(people, subject?.path);

  const submit = async () => {
    if (!subject || busy) return;
    setBusy(true);
    setError(null);

    try {
      let other = pick;

      if (mode === 'new') {
        if (!name.trim()) throw new Error('a name is needed');
        // A name of nothing but punctuation slugs to the empty string, which
        // would name the people folder itself, not a person.
        const segment = personSlug(name);
        if (!segment) throw new Error('that name has no letters or digits to make a path from');
        other = `${PEOPLE_ROOT}/${segment}`;
        await execCommand(`person-create ${shq(other)} --name ${shq(name.trim())}`);
      }
      if (!other) throw new Error('pick somebody, or create them');

      if (kind === 'partner') {
        const dates = [from.trim() ? `--from ${shq(from.trim())}` : '', to.trim() ? `--to ${shq(to.trim())}` : ''].filter(Boolean).join(' ');
        await execCommand(`person-set-partner ${shq(subject.path)} ${shq(other)} --kind ${shq(tie)} ${dates}`.trim());
      } else {
        // One command, both directions — the child is always the first argument.
        const [child, parent] = kind === 'parent' ? [subject.path, other] : [other, subject.path];
        await execCommand(`person-set-parent ${shq(child)} ${shq(parent)} --kind ${shq(tie)}`);
      }

      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={subject !== null}
      onClose={onClose}
      title={TITLES[kind]}
      subtitle={kind === 'parent' ? `Whose child is ${subject?.name}?` : kind === 'partner' ? `Who is ${subject?.name} with?` : `Who is a child of ${subject?.name}?`}
      icon={ICONS[kind]}
      pattern='person'
      size='md'
      onSubmit={submit}
    >
      <Stack gap='md'>
        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(value) => setMode(value as 'existing' | 'new')}
          data={[{ value: 'existing', label: 'Someone already here' }, { value: 'new', label: 'Someone new' }]}
        />

        {mode === 'existing'
          ? <EntityPicker kind='person' label='Who' data={options} value={pick} onChange={setPick} />
          : <TextInput label='Name' value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder='Anna Berg' data-autofocus />}

        {
          /* Partnerships are the only relation here that spans time, and the
            dates are what put a wedding on both people's timelines. */
        }
        <Group grow align='flex-start'>
          <Select
            label={kind === 'partner' ? 'Relationship' : 'Kind'}
            data={kind === 'partner' ? PARTNER_KINDS : PARENT_KINDS}
            value={tie}
            onChange={(value) => setTie(value ?? (kind === 'partner' ? 'partner' : 'blood'))}
            allowDeselect={false}
          />
          {kind === 'partner' && <TextInput label='From' value={from} onChange={(e) => setFrom(e.currentTarget.value)} placeholder='1972-05-20' />}
          {kind === 'partner' && <TextInput label='Until' value={to} onChange={(e) => setTo(e.currentTarget.value)} placeholder='(still together)' />}
        </Group>

        {error && (
          <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>
            {error}
          </Alert>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy}>Add</Button>
      </DialogActions>
    </Dialog>
  );
}
