import { ActionIcon, Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DeviceSummary } from '@ein/api';
import { TablerIcon } from '@ein/ui/components';
import { execCommand } from '@ein/ui/signals';
import { EntityPicker } from '../../components/EntityPicker.tsx';
import { InfoSection } from '../../components/InfoSection.tsx';
import { deviceRoute } from '../../location/lib/device-route.ts';

/** The devices that keep a track, to link a camera to; read only while picking one. */
function useTrackingDevices(asked: boolean): DeviceSummary[] {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  useEffect(() => {
    if (!asked) return;
    let cancelled = false;
    execCommand<DeviceSummary[]>('devices')
      .then((listed) => !cancelled && setDevices(listed.filter((device) => device.tracks)))
      .catch(() => !cancelled && setDevices([]));
    return () => {
      cancelled = true;
    };
  }, [asked]);
  return devices;
}

/**
 * The device a camera is part of, as a section of its Info tab: a phone's camera and the phone,
 * whose track says where the camera was. A link to the device's page, and for the camera's editors
 * the way to set it, from the devices that keep a track (`devices`), or clear it. `device` is the
 * device's path and `name` its label; `setDevice` writes the link (`camera-device`).
 */
export function CameraDevice({ device, name, editable, setDevice }: {
  device?: string;
  name?: string;
  editable: boolean;
  setDevice: (device: string | null) => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const devices = useTrackingDevices(picking);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!device && !editable) return null;

  const run = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await setDevice(next);
      setPicking(false);
      setPick(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoSection title='Device'>
      <Text size='xs' c='dimmed'>A phone's camera is part of the phone, whose track says where its pictures were taken.</Text>
      {device
        ? (
          <Group gap='xs' wrap='nowrap' justify='space-between'>
            <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
              <TablerIcon name='device-mobile' size={16} color='gray' style={{ flexShrink: 0 }} />
              <Anchor component={Link} to={deviceRoute(device) ?? '/devices'} size='sm' lineClamp={1}>{name ?? device}</Anchor>
            </Group>
            {editable && (
              <ActionIcon variant='subtle' color='gray' size='sm' aria-label='Take the device away' disabled={busy} onClick={() => run(null)}>
                <TablerIcon name='x' size={14} />
              </ActionIcon>
            )}
          </Group>
        )
        : <Text size='sm' c='dimmed'>It is part of no device.</Text>}
      {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      {editable && (picking
        ? (
          <Group gap='xs' align='flex-end' wrap='nowrap'>
            <EntityPicker
              kind='device'
              data={devices.filter((entry) => entry.path !== device).map((entry) => ({ value: entry.path, label: entry.label }))}
              value={pick}
              onChange={setPick}
              style={{ flex: 1 }}
              size='xs'
            />
            <Button size='xs' loading={busy} disabled={!pick} onClick={() => pick && run(pick)}>Set</Button>
            <Button size='xs' variant='default' disabled={busy} onClick={() => setPicking(false)}>Cancel</Button>
          </Group>
        )
        : (
          <Button
            size='compact-xs'
            variant='subtle'
            leftSection={<TablerIcon name='device-mobile' size={14} />}
            onClick={() => setPicking(true)}
            style={{ alignSelf: 'flex-start' }}
          >
            {device ? 'Change device' : 'Set device'}
          </Button>
        ))}
    </InfoSection>
  );
}
