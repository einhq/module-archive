import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Card, Checkbox, Group, Select, Stack, Text } from '@mantine/core';
import { type NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { useCallback, useEffect, useState } from 'react';
import { useDevices } from '../../device/hooks/useDevices.ts';

/** A GPX file waiting in `routes/`: its path, name and the `creator` it says wrote it. */
type WaitingRoute = { path: string; name: string; creator?: string };

/**
 * The GPX files waiting in a staging area's `routes/` (`routes`): `track-stage` keeps a file there
 * only when it named no single device it knows. The files ticked are imported, one after another,
 * into the track of the one device chosen for them.
 */
export function StagedRoutes({ routes, reloadToken, onImported }: { routes: string; reloadToken: number; onImported: () => void }) {
  const [files, setFiles] = useState<WaitingRoute[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [device, setDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const { devices } = useDevices();

  const load = useCallback(async () => {
    const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(routes)}`).catch(() => []);
    const waiting = entries.filter((entry) => entry.node.type === 'file').map((entry) => ({
      path: `${routes}/${entry.name}`,
      name: entry.name,
      creator: (entry.node.attrs as { gpxCreator?: string }).gpxCreator,
    }));
    setFiles(waiting);
    // A file that is no longer waiting is no longer selected.
    setSelected((current) => new Set(waiting.map((file) => file.path).filter((path) => current.has(path))));
  }, [routes]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  if (files.length === 0) return null;

  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const all = selected.size === files.length;

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
        <Group gap='xs'>
          <TablerIcon name='route' size={18} />
          <Text fw={500}>Routes waiting for a device</Text>
        </Group>
        <Text size='sm' c='dimmed'>
          These GPX files do not name a device the archive knows. Tick the ones one device recorded, choose that device, and their routes join its track.
        </Text>
        {errors.length > 0 && (
          <Alert color='red'>
            {errors.map((message) => <Text key={message} size='sm'>{message}</Text>)}
          </Alert>
        )}
        <Checkbox
          label={all ? 'All selected' : selected.size > 0 ? `${selected.size} of ${files.length} selected` : 'Select all'}
          checked={all}
          indeterminate={!all && selected.size > 0}
          onChange={() => setSelected(all ? new Set() : new Set(files.map((file) => file.path)))}
          disabled={busy}
        />
        {files.map((file) => (
          <Checkbox
            key={file.path}
            checked={selected.has(file.path)}
            onChange={() => toggle(file.path)}
            disabled={busy}
            label={
              <Text size='sm' style={{ overflowWrap: 'anywhere' }}>
                {file.name}
                {file.creator && <Text span size='xs' c='dimmed'>{` — creator "${file.creator}"`}</Text>}
              </Text>
            }
          />
        ))}
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
