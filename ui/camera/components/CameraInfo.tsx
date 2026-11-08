import { TablerIcon } from '@ein/ui/components';
import { Badge, Button, Code, Stack, Text } from '@mantine/core';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';
import type { CameraDetail, CameraOwner } from '../hooks/useCamera.ts';
import { CameraOwners } from './CameraOwners.tsx';
import { CameraDevice } from './CameraDevice.tsx';

type CameraInfoProps = {
  camera: CameraDetail;
  owners: CameraOwner[];
  editable: boolean;
  /** `useCamera().addOwner`, with what an owner change re-reads on the page. */
  setOwner: (personPath: string, span: { from?: string; to?: string }, update?: boolean) => Promise<void>;
  removeOwner: (personId: string) => Promise<void>;
  /** Links the media it took that were indexed before it matched them; `relinking` while it runs. */
  onRelink: () => void;
  relinking: boolean;
  /** `useCamera().setDevice`. */
  setDevice: (device: string | null) => Promise<void>;
};

/**
 * Everything known about a camera beside its timeline: its settings, who has owned it, the device it
 * is part of, and what it is.
 */
export function CameraInfo({ camera, owners, editable, setOwner, removeOwner, onRelink, relinking, setDevice }: CameraInfoProps) {
  const matchable = Boolean(camera.serial || (camera.make && camera.model));
  const recorded = camera.make || camera.model || camera.serial || camera.timezone || camera.digitizer || camera.quicktimeUtc;

  return (
    <Stack gap='md'>
      <InfoSection title='Camera'>
        {camera.make && <InfoFact label='Make'>{camera.make}</InfoFact>}
        {camera.model && <InfoFact label='Model'>{camera.model}</InfoFact>}
        {camera.serial && <InfoFact label='Serial number'>{camera.serial}</InfoFact>}
        {camera.timezone && <InfoFact label='Timezone'>{camera.timezone}</InfoFact>}
        {camera.digitizer && (
          <InfoFact label='Capture dates'>
            <Badge size='sm' variant='light' color='yellow'>Scanner dates suppressed</Badge>
          </InfoFact>
        )}
        {camera.quicktimeUtc && (
          <InfoFact label='Video times'>
            <Badge size='sm' variant='light' color='gray'>UTC</Badge>
          </InfoFact>
        )}
        {!recorded && <Text size='sm' c='dimmed'>Nothing recorded beyond the name.</Text>}
        {!matchable && (
          <Text size='xs' c='yellow'>
            No serial and no make/model — nothing is matched to this camera automatically; <Code>camera-link --camera</Code> links files to it by hand.
          </Text>
        )}
        {editable && matchable && (
          <Stack gap={4} align='flex-start' mt={4}>
            <Button size='compact-sm' variant='light' leftSection={<TablerIcon name='link' size={14} />} loading={relinking} onClick={onRelink}>
              Link existing media
            </Button>
            <Text size='xs' c='dimmed'>
              Files are linked to their camera when they are indexed, when it is registered and when its make, model or serial number is changed. This looks again for the
              files that carry its fingerprint and are linked to no camera, such as one indexed while linking was not running.
            </Text>
          </Stack>
        )}
      </InfoSection>

      <CameraOwners camera={camera} owners={owners} editable={editable} setOwner={setOwner} removeOwner={removeOwner} />

      <CameraDevice device={camera.device} name={camera.deviceName} editable={editable} setDevice={setDevice} />

      {camera.description && (
        <InfoSection title='About'>
          <UserText text={camera.description} size='sm' />
        </InfoSection>
      )}
    </Stack>
  );
}
