import { TablerIcon } from '@ein/ui/components';
import { Badge, Button, Code, Stack, Text } from '@mantine/core';
import { DEVICE_KIND_LABELS, isDeviceKind } from '@archive/location/track-profile';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';
import type { DeviceDetail, DeviceOwner } from '../hooks/useDevice.ts';
import { DeviceHomes } from './DeviceHomes.tsx';
import { DeviceOwners } from './DeviceOwners.tsx';

type DeviceInfoProps = {
  device: DeviceDetail;
  owners: DeviceOwner[];
  editable: boolean;
  /** Whether it travels, so where it belongs (its home bases) is worth saying. */
  travels: boolean;
  /** `useDevice().addOwner`, with what an owner change re-reads on the page. */
  setOwner: (personPath: string, span: { from?: string; to?: string }, update?: boolean) => Promise<void>;
  removeOwner: (personId: string) => Promise<void>;
  /** Links the media it took that were indexed before it matched them; `relinking` while it runs. */
  onRelink: () => void;
  relinking: boolean;
};

/**
 * Everything known about a device beside its timeline: its settings, who has owned it, where it
 * belongs when it travels, and what it is.
 */
export function DeviceInfo({ device, owners, editable, travels, setOwner, removeOwner, onRelink, relinking }: DeviceInfoProps) {
  const matchable = Boolean(device.serial || (device.make && device.model));
  const recorded = device.make || device.model || device.serial || device.timezone || device.kind || device.digitizer || device.quicktimeUtc;

  return (
    <Stack gap='md'>
      <InfoSection title='Device'>
        {device.make && <InfoFact label='Make'>{device.make}</InfoFact>}
        {device.model && <InfoFact label='Model'>{device.model}</InfoFact>}
        {device.serial && <InfoFact label='Serial number'>{device.serial}</InfoFact>}
        {device.timezone && <InfoFact label='Timezone'>{device.timezone}</InfoFact>}
        {isDeviceKind(device.kind) && <InfoFact label='Travels as'>{DEVICE_KIND_LABELS[device.kind]}</InfoFact>}
        {device.digitizer && (
          <InfoFact label='Capture dates'>
            <Badge size='sm' variant='light' color='yellow'>Scanner dates suppressed</Badge>
          </InfoFact>
        )}
        {device.quicktimeUtc && (
          <InfoFact label='Video times'>
            <Badge size='sm' variant='light' color='gray'>UTC</Badge>
          </InfoFact>
        )}
        {!recorded && <Text size='sm' c='dimmed'>Nothing recorded beyond the name.</Text>}
        {!matchable && (
          <Text size='xs' c='yellow'>
            No serial and no make/model — nothing is matched to this device automatically; <Code>device-link --device</Code> links files to it by hand.
          </Text>
        )}
        {editable && matchable && (
          <Stack gap={4} align='flex-start' mt={4}>
            <Button size='compact-sm' variant='light' leftSection={<TablerIcon name='link' size={14} />} loading={relinking} onClick={onRelink}>
              Link existing media
            </Button>
            <Text size='xs' c='dimmed'>
              Files are linked to their device when it is registered and when they are indexed. A make, model or serial number changed afterwards leaves the files it now
              matches unclaimed; this finds them by fingerprint and attaches them.
            </Text>
          </Stack>
        )}
      </InfoSection>

      <DeviceOwners device={device} owners={owners} editable={editable} setOwner={setOwner} removeOwner={removeOwner} />

      {travels && <DeviceHomes device={device.path} editable={editable} />}

      {device.description && (
        <InfoSection title='About'>
          <UserText text={device.description} size='sm' />
        </InfoSection>
      )}
    </Stack>
  );
}
