import { TablerIcon } from '@ein/ui/components';
import { PEOPLE_ROOT } from '@archive/paths';
import { ActionIcon, Alert, Anchor, Badge, Button, Card, Group, Paper, Radio, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LocationDetail, ResidentEntry } from '../hooks/useLocationDetail.ts';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { spanLine } from '../../lib/residence-span.ts';
import { personSlug } from '../../people/lib/person-slug.ts';

type LocationResidentsTabProps = {
  location: LocationDetail;
  residents: ResidentEntry[];
  /** The server still authorizes the command; this just keeps controls out of read-only views. */
  editable: boolean;
  onApplied: () => void;
};

type ResidentRow = { path: string; slug: string; name: string; from?: string; to?: string };
type Editor = { kind: 'add' } | { kind: 'edit'; row: ResidentRow };

const rowFor = (resident: ResidentEntry): ResidentRow => ({
  path: `${PEOPLE_ROOT}/${resident.id}`,
  slug: resident.id,
  name: resident.name,
  from: resident.from,
  to: resident.to,
});

/** Current residents first, then the latest arrival; undated history comes last. */
const order = (a: ResidentRow, b: ResidentRow): number => {
  if (Boolean(a.to) !== Boolean(b.to)) return a.to ? 1 : -1;
  return (b.from ?? '').localeCompare(a.from ?? '');
};

/**
 * Who has lived at a location, and when — the location-side twin of a person's Homes
 * tab, laid out and edited the same way, so a residence reads alike from
 * either end. Both write through `person-set-home`, which takes the person first.
 */
export function LocationResidentsTab({ location, residents, editable, onApplied }: LocationResidentsTabProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [personMode, setPersonMode] = useState<'existing' | 'new'>('existing');
  const [pick, setPick] = useState<string | null>(null);
  const [personName, setPersonName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [removing, setRemoving] = useState<ResidentRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Listed only while adding: a picker nobody opened is not worth a listing of everyone.
  const { people } = usePeople(PEOPLE_ROOT, editor?.kind === 'add');

  const rows = residents.map(rowFor).sort(order);

  const open = (next: Editor) => {
    setEditor(next);
    setPersonMode('existing');
    setPick(null);
    setPersonName('');
    setFrom(next.kind === 'edit' ? next.row.from ?? '' : '');
    setTo(next.kind === 'edit' ? next.row.to ?? '' : '');
    setError(null);
  };

  const close = () => {
    setEditor(null);
    setError(null);
  };

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      let person = editor.kind === 'edit' ? editor.row.path : pick;
      if (editor.kind === 'add' && personMode === 'new') {
        const name = personName.trim();
        if (!name) throw new Error('a name is needed');
        const slug = personSlug(name);
        if (!slug) throw new Error('that name has no letters or digits to make a path from');
        person = `${PEOPLE_ROOT}/${slug}`;
        await execCommand(`person-create ${shq(person)} --name ${shq(name)}`);
      }
      if (!person) throw new Error('pick somebody, or create them');

      const args = [
        from.trim() ? `--from ${shq(from.trim())}` : '',
        to.trim() ? `--to ${shq(to.trim())}` : '',
        editor.kind === 'edit' ? '--update' : '',
      ].filter(Boolean).join(' ');
      await execCommand(`person-set-home ${shq(person)} ${shq(location.path)} ${args}`.trim());
      close();
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await execCommand(`person-remove-home ${shq(removing.path)} ${shq(location.path)}`);
      setRemoving(null);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap='md' maw={760}>
      <Group justify='space-between'>
        <Text c='dimmed' size='sm'>Who has lived at {location.name}, and when.</Text>
        {editable && <Button size='compact-sm' variant='light' leftSection={<TablerIcon name='plus' size={14} />} onClick={() => open({ kind: 'add' })}>Add resident</Button>}
      </Group>

      {editor && (
        <Paper withBorder p='md' radius='md'>
          <Stack gap='md'>
            <Text fw={500}>{editor.kind === 'add' ? 'Add resident' : `Edit ${editor.row.name}`}</Text>
            {editor.kind === 'add'
              ? (
                <>
                  <Radio.Group value={personMode} onChange={(value) => setPersonMode(value as 'existing' | 'new')}>
                    <Group gap='lg'>
                      <Radio value='existing' label='Person already here' />
                      <Radio value='new' label='New person' />
                    </Group>
                  </Radio.Group>
                  {personMode === 'existing' ? <EntityPicker kind='person' label='Person' data={personOptions(people)} value={pick} onChange={setPick} /> : (
                    <TextInput
                      label='Name'
                      value={personName}
                      onChange={(event) => setPersonName(event.currentTarget.value)}
                      placeholder='Anna Andersson'
                      data-autofocus
                    />
                  )}
                </>
              )
              : <Anchor component={Link} to={`/people/${encodeURIComponent(editor.row.slug)}`}>{editor.row.name}</Anchor>}
            <Group grow>
              <TextInput label='Moved in' value={from} onChange={(event) => setFrom(event.currentTarget.value)} placeholder='1972, 1972-05 or 1972-05-20' />
              <TextInput label='Moved out' value={to} onChange={(event) => setTo(event.currentTarget.value)} placeholder='(still lives there)' />
            </Group>
            {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
            <Group justify='flex-end'>
              <Button variant='subtle' onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={save} loading={busy}>{editor.kind === 'edit' ? 'Save changes' : 'Add resident'}</Button>
            </Group>
          </Stack>
        </Paper>
      )}

      <Card withBorder={editable} radius='md'>
        {rows.length === 0 ? <Text c='dimmed' size='sm'>No known residents.</Text> : (
          <Stack gap='xs'>
            {rows.map((row) => {
              const past = Boolean(row.to);
              return (
                <Stack key={row.path} gap='xs'>
                  <Group gap='xs' wrap='nowrap' justify='space-between'>
                    <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
                      <TablerIcon name='user' size={16} color='gray' style={{ flexShrink: 0, opacity: past ? 0.5 : 1 }} />
                      <Anchor component={Link} to={`/people/${encodeURIComponent(row.slug)}`} size='sm' c={past ? 'dimmed' : undefined} lineClamp={1}>
                        {row.name}
                      </Anchor>
                    </Group>
                    <Group gap='xs' wrap='nowrap' style={{ flexShrink: 0 }}>
                      <Text size='xs' c='dimmed'>{spanLine(row)}</Text>
                      {!past && row.from && <Badge size='xs' variant='light'>current</Badge>}
                      {editable && (
                        <>
                          <ActionIcon variant='subtle' size='sm' aria-label={`Edit ${row.name}`} onClick={() => open({ kind: 'edit', row })}>
                            <TablerIcon name='pencil' size={14} />
                          </ActionIcon>
                          <ActionIcon variant='subtle' size='sm' color='red' aria-label={`Remove ${row.name}`} onClick={() => setRemoving(row)}>
                            <TablerIcon name='trash' size={14} />
                          </ActionIcon>
                        </>
                      )}
                    </Group>
                  </Group>
                  {removing?.path === row.path && (
                    <Paper withBorder p='sm' bg='var(--mantine-color-red-light)'>
                      <Group justify='space-between' wrap='wrap'>
                        <Text size='sm'>Remove {row.name} from the residents of {location.name}?</Text>
                        <Group gap='xs'>
                          <Button size='compact-xs' variant='subtle' onClick={() => setRemoving(null)} disabled={busy}>Cancel</Button>
                          <Button size='compact-xs' color='red' onClick={remove} loading={busy}>Remove</Button>
                        </Group>
                      </Group>
                    </Paper>
                  )}
                </Stack>
              );
            })}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
