import { PEOPLE_ROOT } from '@archive/paths';
import { ActionIcon, Alert, Anchor, Badge, Button, Card, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DeviceDetail, DeviceOwner } from '../hooks/useDevice.ts';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { TablerIcon } from '@ein/ui/components';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { spanLine } from '../../lib/residence-span.ts';

type DeviceOwnersTabProps = {
  device: DeviceDetail;
  owners: DeviceOwner[];
  /** The server still authorizes the command; this just keeps controls out of read-only views. */
  editable: boolean;
  /** `useDevice().addOwner`: adds, or with `update` rewrites the dates. It re-reads the device itself. */
  setOwner: (personPath: string, span: { from?: string; to?: string }, update?: boolean) => Promise<void>;
  removeOwner: (personId: string) => Promise<void>;
};

type Editor = { kind: 'add' } | { kind: 'edit'; owner: DeviceOwner };

/** Current owners first, then the latest to get it; undated history comes last. */
const order = (a: DeviceOwner, b: DeviceOwner): number => {
  if (Boolean(a.to) !== Boolean(b.to)) return a.to ? 1 : -1;
  return (b.from ?? '').localeCompare(a.from ?? '');
};

/**
 * Who has owned a device, and when — laid out and edited like a person's Homes
 * tab and a location's Residents, so a dated tie to a person reads the same on
 * every page that has one.
 */
export function DeviceOwnersTab({ device, owners, editable, setOwner, removeOwner }: DeviceOwnersTabProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [removing, setRemoving] = useState<DeviceOwner | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Listed only while adding: a picker nobody opened is not worth a listing of everyone.
  const { people } = usePeople(PEOPLE_ROOT, editor?.kind === 'add');

  const rows = [...owners].sort(order);
  const options = personOptions(people).filter((option) => !owners.some((owner) => owner.path === option.value));

  const open = (next: Editor) => {
    setEditor(next);
    setPick(null);
    setFrom(next.kind === 'edit' ? next.owner.from ?? '' : '');
    setTo(next.kind === 'edit' ? next.owner.to ?? '' : '');
    setError(null);
  };

  const close = () => {
    setEditor(null);
    setError(null);
  };

  const save = async () => {
    if (!editor) return;
    const person = editor.kind === 'edit' ? editor.owner.path : pick;
    if (!person) {
      setError('pick somebody');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setOwner(person, { from: from.trim() || undefined, to: to.trim() || undefined }, editor.kind === 'edit');
      close();
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
      await removeOwner(removing.id);
      setRemoving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap='md' maw={760}>
      <Group justify='space-between'>
        <Text c='dimmed' size='sm'>Who has owned {device.name}, and when.</Text>
        {editable && <Button size='compact-sm' variant='light' leftSection={<TablerIcon name='plus' size={14} />} onClick={() => open({ kind: 'add' })}>Add owner</Button>}
      </Group>

      {editor && (
        <Paper withBorder p='md' radius='md'>
          <Stack gap='md'>
            <Text fw={500}>{editor.kind === 'add' ? 'Add owner' : `Edit ${editor.owner.name}`}</Text>
            {editor.kind === 'add'
              ? <EntityPicker kind='person' label='Person' data={options} value={pick} onChange={setPick} />
              : <Anchor component={Link} to={`/people/${encodeURIComponent(editor.owner.id)}`}>{editor.owner.name}</Anchor>}
            <Group grow>
              <TextInput label='From' value={from} onChange={(event) => setFrom(event.currentTarget.value)} placeholder='2005, 2005-06 or 2005-06-20' />
              <TextInput label='To' value={to} onChange={(event) => setTo(event.currentTarget.value)} placeholder='(still owns it)' />
            </Group>
            {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
            <Group justify='flex-end'>
              <Button variant='subtle' onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={save} loading={busy}>{editor.kind === 'edit' ? 'Save changes' : 'Add owner'}</Button>
            </Group>
          </Stack>
        </Paper>
      )}

      {!editor && error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}

      <Card withBorder={editable} radius='md'>
        {rows.length === 0 ? <Text c='dimmed' size='sm'>Nobody is recorded as owning this.</Text> : (
          <Stack gap='xs'>
            {rows.map((owner) => {
              const past = Boolean(owner.to);
              return (
                <Stack key={owner.id} gap='xs'>
                  <Group gap='xs' wrap='nowrap' justify='space-between'>
                    <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
                      <TablerIcon name='user' size={16} color='gray' style={{ flexShrink: 0, opacity: past ? 0.5 : 1 }} />
                      <Anchor component={Link} to={`/people/${encodeURIComponent(owner.id)}`} size='sm' c={past ? 'dimmed' : undefined} lineClamp={1}>
                        {owner.name}
                      </Anchor>
                    </Group>
                    <Group gap='xs' wrap='nowrap' style={{ flexShrink: 0 }}>
                      <Text size='xs' c='dimmed'>{spanLine(owner)}</Text>
                      {!past && owner.from && <Badge size='xs' variant='light'>current</Badge>}
                      {editable && (
                        <>
                          <ActionIcon variant='subtle' size='sm' aria-label={`Edit ${owner.name}`} onClick={() => open({ kind: 'edit', owner })}>
                            <TablerIcon name='pencil' size={14} />
                          </ActionIcon>
                          <ActionIcon variant='subtle' size='sm' color='red' aria-label={`Remove ${owner.name}`} onClick={() => setRemoving(owner)}>
                            <TablerIcon name='trash' size={14} />
                          </ActionIcon>
                        </>
                      )}
                    </Group>
                  </Group>
                  {removing?.id === owner.id && (
                    <Paper withBorder p='sm' bg='var(--mantine-color-red-light)'>
                      <Group justify='space-between' wrap='wrap'>
                        <Text size='sm'>Remove {owner.name} as an owner of {device.name}?</Text>
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
