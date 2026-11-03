import { LOCATIONS_ROOT } from '@archive/paths';
import { ActionIcon, Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TablerIcon } from '@ein/ui/components';
import { NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { EntityPicker } from '../../components/EntityPicker.tsx';
import { InfoSection } from '../../components/InfoSection.tsx';
import { spanLine } from '../../lib/residence-span.ts';
import { useDeviceHomes } from '../hooks/useDeviceHomes.ts';

const locationRoute = (path: string): string => `/locations/${encodeURIComponent(path.split('/').pop() ?? path)}`;

/**
 * Where arriving ends one of the device's trips, as a section of its Info tab: the locations it
 * lists, or, while it lists none, its owners' homes for the time they owned it. `editable` offers
 * adding and removing its own.
 */
export function DeviceHomes({ device, editable }: { device: string; editable: boolean }) {
  const { homes, add, remove } = useDeviceHomes(device);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [locations, setLocations] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const own = homes.filter((home) => home.source === 'device');
  // Owners who lived together give the same place for the same years; it is listed once.
  const owners = homes
    .filter((home) => home.source === 'owner')
    .filter((home, index, all) => all.findIndex((other) => other.location === home.location && spanLine(other) === spanLine(home)) === index);

  // Listed only while adding: a picker nobody opened is not worth a listing of every location.
  useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    (async () => {
      try {
        const entries = await execCommand<NodeChildEntry[]>(`ls -l ${shq(LOCATIONS_ROOT)}`);
        if (cancelled) return;
        setLocations(
          entries
            .filter((entry) => entry.node.type === 'location')
            .map((entry) => ({ value: `${LOCATIONS_ROOT}/${entry.name}`, label: ((entry.node.attrs as Record<string, unknown>).name as string | undefined) ?? entry.name }))
            .filter((option) => !own.some((home) => home.location === option.value))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adding]);

  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await write();
      setAdding(false);
      setPick(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoSection title='Home bases'>
      <Text size='xs' c='dimmed'>Where it belongs: a home berth, a winter yard, the house. Arriving at one ends a trip.</Text>
      {own.map((home) => (
        <Group key={home.location} gap='xs' wrap='nowrap' justify='space-between'>
          <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
            <TablerIcon name='map-pin' size={16} color='gray' style={{ flexShrink: 0 }} />
            <Anchor component={Link} to={locationRoute(home.location)} size='sm' lineClamp={1}>{home.name}</Anchor>
          </Group>
          {editable && (
            <ActionIcon
              variant='subtle'
              color='gray'
              size='sm'
              aria-label={`Remove ${home.name}`}
              disabled={busy}
              onClick={() => run(() => remove(home.location))}
            >
              <TablerIcon name='x' size={14} />
            </ActionIcon>
          )}
        </Group>
      ))}
      {own.length === 0 && (
        <Text size='sm' c='dimmed'>
          {owners.length > 0 ? 'None set, so its owners’ homes count:' : 'None set, and none of its owners has a home recorded.'}
        </Text>
      )}
      {owners.map((home) => (
        <Group key={`${home.location}|${spanLine(home)}`} gap='xs' wrap='nowrap' justify='space-between'>
          <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
            <TablerIcon name='home' size={16} color='gray' style={{ flexShrink: 0 }} />
            <Anchor component={Link} to={locationRoute(home.location)} size='sm' lineClamp={1}>{home.name}</Anchor>
          </Group>
          <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{spanLine(home)}</Text>
        </Group>
      ))}
      {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      {editable && (adding
        ? (
          <Group gap='xs' align='flex-end' wrap='nowrap'>
            <EntityPicker kind='location' data={locations} value={pick} onChange={setPick} style={{ flex: 1 }} size='xs' />
            <Button size='xs' loading={busy} disabled={!pick} onClick={() => pick && run(() => add(pick))}>Add</Button>
            <Button size='xs' variant='default' disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>
          </Group>
        )
        : (
          <Button size='compact-xs' variant='subtle' leftSection={<TablerIcon name='plus' size={14} />} onClick={() => setAdding(true)} style={{ alignSelf: 'flex-start' }}>
            Add home base
          </Button>
        ))}
    </InfoSection>
  );
}
