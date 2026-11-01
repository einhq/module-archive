import { EmptyState } from '@ein/ui/components';
import { Alert, Box, Button, Card, Checkbox, Group, Select, Stack, Table, Text, UnstyledButton } from '@mantine/core';
import { formatBytes, formatDuration, type NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { GpxInfo } from '@archive/location/api';
import { useDevices } from '../../device/hooks/useDevices.ts';

/** A GPX file waiting in `routes/`: its path and name, and what `gpx-info` says of it once read. */
type WaitingRoute = { path: string; name: string; info?: GpxInfo };

/** `2001-01-01T10:00:00.000Z` as `2001-01-01 10:00`. */
const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

/** When the points were recorded: the day and time of the first, the time (or day) of the last, and how long between. */
const recorded = (start: string, end?: string): string => {
  if (!end || end === start) return `${minute(start)} UTC`;
  const last = end.slice(0, 10) === start.slice(0, 10) ? minute(end).slice(11) : minute(end);
  return `${minute(start)} – ${last} UTC (${formatDuration(Date.parse(end) - Date.parse(start))})`;
};

/** The line under a file's name in the list: its own name or first track's, the day it starts and its points. */
const summary = (info?: GpxInfo): string => {
  if (!info) return '';
  if ('error' in info) return 'cannot be read';
  return [info.name ?? info.tracks[0], info.start?.slice(0, 10), `${info.points.toLocaleString()} ${info.points === 1 ? 'point' : 'points'}`].filter(Boolean).join(' · ');
};

/** What one waiting file says about itself, as rows of a table. */
function RouteDetails({ file }: { file: WaitingRoute }) {
  const info = file.info;
  if (!info) return <Text size='sm' c='dimmed'>Reading…</Text>;
  if ('error' in info) return <Alert color='red' variant='light'>{info.error}</Alert>;

  const rows: [string, ReactNode][] = [
    ['Name', info.name],
    ['Description', info.description],
    ['Tracks', info.tracks.length > 0 ? info.tracks.join(', ') : undefined],
    ['Creator', info.creator],
    ['Recorded', info.start ? recorded(info.start, info.end) : 'no point has a time'],
    ['Points', `${info.points.toLocaleString()}${info.timed < info.points ? ` (${info.timed.toLocaleString()} with a time)` : ''}`],
    ['File time', info.time ? `${minute(info.time)} UTC` : undefined],
    ['Size', formatBytes(info.size)],
    ['Devices named', info.devices.length > 0 ? `${info.devices.map((device) => device.name).join(', ')}: more than one, choose which` : 'none registered'],
  ];

  return (
    <Stack gap={4}>
      <Text size='sm' fw={600} style={{ overflowWrap: 'anywhere' }}>{file.name}</Text>
      <Table verticalSpacing={2} withRowBorders={false}>
        <Table.Tbody>
          {rows.filter(([, value]) => value !== undefined).map(([label, value]) => (
            <Table.Tr key={label}>
              <Table.Td w='8rem' style={{ verticalAlign: 'top' }}>
                <Text size='xs' c='dimmed'>{label}</Text>
              </Table.Td>
              <Table.Td>
                <Text size='xs' style={{ overflowWrap: 'anywhere' }}>{value}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/**
 * The GPX files waiting in a staging area's `routes/` (`routes`): `track-stage` keeps a file there
 * only when it named no single device it knows. A list of them beside what the one picked says
 * of itself (`gpx-info`); the files ticked are imported, one after another, into the track of the
 * one device chosen for them.
 */
export function StagedRoutes({ routes, onImported }: { routes: string; onImported: () => void }) {
  const [files, setFiles] = useState<WaitingRoute[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [device, setDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const { devices } = useDevices();

  const load = useCallback(async () => {
    const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(routes)}`).catch(() => []);
    const waiting: WaitingRoute[] = entries.filter((entry) => entry.node.type === 'file').map((entry) => ({ path: `${routes}/${entry.name}`, name: entry.name }));
    setFiles(waiting);
    // A file that is no longer waiting is no longer selected, nor shown.
    const paths = new Set(waiting.map((file) => file.path));
    setSelected((was) => new Set([...was].filter((path) => paths.has(path))));
    setCurrent((was) => was && paths.has(was) ? was : waiting[0]?.path ?? null);
    if (waiting.length === 0) return;
    // `gpx-info` answers for every file, the unreadable ones with why; it only fails as a whole when it cannot run.
    const infos = await execCommand<GpxInfo[]>(`gpx-info ${waiting.map((file) => shq(file.path)).join(' ')}`).catch((err) =>
      waiting.map((file) => ({ path: file.path, error: err instanceof Error ? err.message : String(err) }))
    );
    const byPath = new Map(infos.map((info) => [info.path, info]));
    setFiles(waiting.map((file) => ({ ...file, info: byPath.get(file.path) })));
  }, [routes]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!files) return <Text size='sm' c='dimmed'>Reading…</Text>;
  if (files.length === 0) {
    return <EmptyState title='No route waits'>A GPX file dropped in staging that names no device the archive knows waits here for you to say which recorded it.</EmptyState>;
  }

  const toggle = (path: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const all = selected.size === files.length;
  const shown = files.find((file) => file.path === current) ?? files[0];

  const importSelected = async () => {
    if (!device || selected.size === 0) return;
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    for (const file of files.filter((file) => selected.has(file.path))) {
      try {
        await execCommand(`track-stage ${shq(file.path)} --device ${shq(device)}`);
      } catch (err) {
        failed.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setErrors(failed);
    setBusy(false);
    await load();
    onImported();
  };

  return (
    <Card withBorder radius='md'>
      <Stack gap='sm'>
        <Text size='sm' c='dimmed'>Click a file to see what it says about itself.</Text>
        {errors.length > 0 && (
          <Alert color='red'>
            {errors.map((message) => <Text key={message} size='sm'>{message}</Text>)}
          </Alert>
        )}
        <Group align='flex-start' gap='md' wrap='wrap'>
          <Stack gap={2} style={{ flex: '1 1 18rem', minWidth: 0 }}>
            <Checkbox
              mb={4}
              label={all ? 'All selected' : selected.size > 0 ? `${selected.size} of ${files.length} selected` : 'Select all'}
              checked={all}
              indeterminate={!all && selected.size > 0}
              onChange={() => setSelected(all ? new Set() : new Set(files.map((file) => file.path)))}
              disabled={busy}
            />
            <Box mah='24rem' style={{ overflowY: 'auto' }}>
              {files.map((file) => (
                <Group
                  key={file.path}
                  gap='xs'
                  wrap='nowrap'
                  px={6}
                  py={4}
                  style={{ borderRadius: 'var(--mantine-radius-sm)', background: file.path === shown.path ? 'var(--mantine-color-default-hover)' : undefined }}
                >
                  <Checkbox aria-label={`Select ${file.name}`} checked={selected.has(file.path)} onChange={() => toggle(file.path)} disabled={busy} />
                  <UnstyledButton onClick={() => setCurrent(file.path)} style={{ flex: 1, minWidth: 0 }} aria-current={file.path === shown.path || undefined}>
                    <Text size='sm' style={{ overflowWrap: 'anywhere' }}>{file.name}</Text>
                    <Text size='xs' c='dimmed' truncate>{summary(file.info)}</Text>
                  </UnstyledButton>
                </Group>
              ))}
            </Box>
          </Stack>
          <Box
            p='sm'
            style={{ flex: '1 1 18rem', minWidth: 0, borderLeft: '1px solid var(--mantine-color-default-border)' }}
          >
            <RouteDetails file={shown} />
          </Box>
        </Group>
        <Group gap='sm' wrap='wrap'>
          <Select
            placeholder='Device'
            aria-label='Device'
            searchable
            data={devices.map((entry) => ({ value: entry.path, label: entry.name }))}
            value={device}
            onChange={setDevice}
            w={240}
          />
          <Button size='sm' disabled={!device || selected.size === 0} loading={busy} onClick={() => void importSelected()}>
            {selected.size > 1 ? `Import ${selected.size} files` : 'Import'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
