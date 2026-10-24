import { TablerIcon } from '@ein/ui/components';
import { LOCATIONS_ROOT } from '@archive/paths';
import { ActionIcon, Alert, Anchor, Badge, Button, Card, Group, Paper, Radio, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PersonHome, PersonInfo } from '../hooks/usePeople.ts';
import { NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { EntityPicker } from '../../components/EntityPicker.tsx';
import { spanLine } from '../../lib/residence-span.ts';
import { personSlug } from '../lib/person-slug.ts';

type PersonHomesTabProps = {
  person: PersonInfo;
  /** The server still authorizes the command; this just keeps controls out of non-admin views. */
  editable: boolean;
  onApplied: () => void;
};

type HomeRow = { path: string; name: string; from?: string; to?: string };
type Editor = { kind: 'add' } | { kind: 'edit'; row: HomeRow };

const rowFor = (home: PersonHome): HomeRow => ({
  path: home.path,
  name: home.name ?? home.path.split('/').pop() ?? home.path,
  from: home.from,
  to: home.to,
});

/** Open homes first, then the latest arrival; undated history comes last. */
const order = (a: HomeRow, b: HomeRow): number => {
  if (Boolean(a.to) !== Boolean(b.to)) return a.to ? 1 : -1;
  return (b.from ?? '').localeCompare(a.from ?? '');
};

/**
 * Homes belong to their own tab so their history does not crowd the identity
 * header. Adding and editing stay on that tab: no context switch to a dialog.
 */
export function PersonHomesTab({ person, editable, onApplied }: PersonHomesTabProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [locationMode, setLocationMode] = useState<'existing' | 'new'>('existing');
  const [pick, setPick] = useState<string | null>(null);
  const [locationName, setLocationName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [locations, setLocations] = useState<{ value: string; label: string }[]>([]);
  const [removing, setRemoving] = useState<HomeRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = person.homes.map(rowFor).sort(order);

  useEffect(() => {
    if (!editor || editor.kind !== 'add') return;
    let cancelled = false;
    (async () => {
      try {
        const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(LOCATIONS_ROOT)}`);
        if (cancelled) return;
        setLocations(
          entries
            .filter((entry) => entry.node.type === 'location')
            .map((entry) => ({ value: `${LOCATIONS_ROOT}/${entry.name}`, label: ((entry.node.attrs as Record<string, unknown>).name as string | undefined) ?? entry.name }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor]);

  const open = (next: Editor) => {
    setEditor(next);
    setLocationMode('existing');
    setPick(null);
    setLocationName('');
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
      let location = editor.kind === 'edit' ? editor.row.path : pick;
      if (editor.kind === 'add' && locationMode === 'new') {
        const name = locationName.trim();
        if (!name) throw new Error('a location name is needed');
        const slug = personSlug(name);
        if (!slug) throw new Error('that name has no letters or digits to make a path from');
        location = `${LOCATIONS_ROOT}/${slug}`;
        await execCommand(`mknode -t location ${shq(location)} --as ${shq(`name=${name}`)}`);
      }
      if (!location) throw new Error('pick a location, or create one');

      const args = [
        from.trim() ? `--from ${shq(from.trim())}` : '',
        to.trim() ? `--to ${shq(to.trim())}` : '',
        editor.kind === 'edit' ? '--update' : '',
      ].filter(Boolean).join(' ');
      await execCommand(`person-set-home ${shq(person.path)} ${shq(location)} ${args}`.trim());
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
      await execCommand(`person-remove-home ${shq(person.path)} ${shq(removing.path)}`);
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
        <Text c='dimmed' size='sm'>Where {person.name} has lived, and when.</Text>
        {editable && <Button size='compact-sm' variant='light' leftSection={<TablerIcon name='plus' size={14} />} onClick={() => open({ kind: 'add' })}>Add home</Button>}
      </Group>

      {editor && (
        <Paper withBorder p='md' radius='md'>
          <Stack gap='md'>
            <Text fw={500}>{editor.kind === 'add' ? 'Add home' : `Edit ${editor.row.name}`}</Text>
            {editor.kind === 'add'
              ? (
                <>
                  <Radio.Group value={locationMode} onChange={(value) => setLocationMode(value as 'existing' | 'new')}>
                    <Group gap='lg'>
                      <Radio value='existing' label='Location already here' />
                      <Radio value='new' label='New location' />
                    </Group>
                  </Radio.Group>
                  {locationMode === 'existing' ? <EntityPicker kind='location' label='Location' data={locations} value={pick} onChange={setPick} /> : (
                    <TextInput
                      label='Location name'
                      value={locationName}
                      onChange={(event) => setLocationName(event.currentTarget.value)}
                      placeholder='Ekbacksvägen 4'
                      data-autofocus
                    />
                  )}
                </>
              )
              : <Anchor component={Link} to={`/locations/${encodeURIComponent(editor.row.path.split('/').pop() ?? '')}`}>{editor.row.name}</Anchor>}
            <Group grow>
              <TextInput label='Moved in' value={from} onChange={(event) => setFrom(event.currentTarget.value)} placeholder='1972, 1972-05 or 1972-05-20' />
              <TextInput label='Moved out' value={to} onChange={(event) => setTo(event.currentTarget.value)} placeholder='(still lives there)' />
            </Group>
            {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
            <Group justify='flex-end'>
              <Button variant='subtle' onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={save} loading={busy}>{editor.kind === 'edit' ? 'Save changes' : 'Add home'}</Button>
            </Group>
          </Stack>
        </Paper>
      )}

      <Card withBorder={editable} radius='md'>
        {rows.length === 0 ? <Text c='dimmed' size='sm'>No homes recorded.</Text> : (
          <Stack gap='xs'>
            {rows.map((row) => {
              const past = Boolean(row.to);
              return (
                <Stack key={row.path} gap='xs'>
                  <Group gap='xs' wrap='nowrap' justify='space-between'>
                    <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
                      <TablerIcon name='home' size={16} color='gray' style={{ flexShrink: 0, opacity: past ? 0.5 : 1 }} />
                      <Anchor
                        component={Link}
                        to={`/locations/${encodeURIComponent(row.path.split('/').pop() ?? '')}`}
                        size='sm'
                        c={past ? 'dimmed' : undefined}
                        lineClamp={1}
                      >
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
                        <Text size='sm'>Remove {row.name} from this home history?</Text>
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
