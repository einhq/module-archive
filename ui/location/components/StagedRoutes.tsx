import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Card, Group, Select, Stack, Text } from '@mantine/core';
import { type NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { useCallback, useEffect, useState } from 'react';
import { useDevices } from '../../device/hooks/useDevices.ts';

/** A GPX file waiting in `routes/`, by its path and name. */
type WaitingRoute = { path: string; name: string };

/**
 * The GPX files waiting in a staging area's `routes/` (`routes`): `track-stage` keeps a file there
 * only when it named no single device it knows. Asks which device recorded each, and imports it
 * into that device's track.
 */
export function StagedRoutes({ routes, reloadToken, onImported }: { routes: string; reloadToken: number; onImported: () => void }) {
  const [files, setFiles] = useState<WaitingRoute[]>([]);
  const [chosen, setChosen] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { devices } = useDevices();

  const load = useCallback(async () => {
    const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(routes)}`).catch(() => []);
    setFiles(entries.filter((entry) => entry.node.type === 'file').map((entry) => ({ path: `${routes}/${entry.name}`, name: entry.name })));
  }, [routes]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  if (files.length === 0) return null;

  const importInto = async (file: WaitingRoute) => {
    const device = chosen[file.path];
    if (!device) return;
    setBusy(file.path);
    setError(null);
    try {
      await execCommand(`track-stage ${shq(file.path)} --device ${shq(device)}`);
      await load();
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card withBorder radius='md'>
      <Stack gap='sm'>
        <Group gap='xs'>
          <TablerIcon name='route' size={18} />
          <Text fw={500}>Routes waiting for a device</Text>
        </Group>
        <Text size='sm' c='dimmed'>
          These GPX files do not name a device the archive knows. Say which device recorded each, and its route joins that device's track.
        </Text>
        {error && <Alert color='red'>{error}</Alert>}
        {files.map((file) => (
          <Group key={file.path} gap='sm' wrap='wrap'>
            <Text size='sm' style={{ flex: '1 1 12rem', overflowWrap: 'anywhere' }}>{file.name}</Text>
            <Select
              placeholder='Device'
              searchable
              data={devices.map((device) => ({ value: device.path, label: device.name }))}
              value={chosen[file.path] ?? null}
              onChange={(value) => setChosen((current) => ({ ...current, [file.path]: value }))}
              w={240}
            />
            <Button size='sm' disabled={!chosen[file.path]} loading={busy === file.path} onClick={() => void importInto(file)}>
              Import
            </Button>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}
