import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

/**
 * The GPX files waiting in the staging area's `routes/` (`count`, from `staging status`) for the
 * camera that recorded each, with the way to the page where it is chosen.
 */
export function RoutesWaiting({ count }: { count: number }) {
  const navigate = useNavigate();
  if (count === 0) return null;
  return (
    <Alert color='yellow' icon={<TablerIcon name='route' size={16} />} title='Needs you'>
      <Group justify='space-between' gap='sm'>
        <Text size='sm'>
          {count === 1 ? '1 GPS track waits for the camera that recorded it.' : `${count} GPS tracks wait for the cameras that recorded them.`}
        </Text>
        <Button size='xs' variant='light' onClick={() => navigate('/staging/routes')}>Choose camera</Button>
      </Group>
    </Alert>
  );
}
