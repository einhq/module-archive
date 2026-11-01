import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, Text } from '@mantine/core';

/**
 * The GPX files waiting in the staging area's `routes/` (`count`, from `staging status`) for the
 * device that recorded each, with the way to where it is chosen (`onChoose`).
 */
export function RoutesWaiting({ count, onChoose }: { count: number; onChoose: () => void }) {
  if (count === 0) return null;
  return (
    <Alert color='yellow' icon={<TablerIcon name='route' size={16} />} title='Needs you'>
      <Group justify='space-between' gap='sm'>
        <Text size='sm'>
          {count === 1 ? '1 GPS track waits for the device that recorded it.' : `${count} GPS tracks wait for the devices that recorded them.`}
        </Text>
        <Button size='xs' variant='light' onClick={onChoose}>Choose device</Button>
      </Group>
    </Alert>
  );
}
