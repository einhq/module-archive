import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

/**
 * The GPX files waiting in the staging area's `routes/` (`count`, from `staging status`) for the
 * track each belongs to, with the way to the page where it is chosen.
 */
export function RoutesWaiting({ count }: { count: number }) {
  const navigate = useNavigate();
  if (count === 0) return null;
  return (
    <Alert color='yellow' icon={<TablerIcon name='route' size={16} />} title='Needs you'>
      <Group justify='space-between' gap='sm'>
        <Text size='sm'>
          {count === 1 ? '1 GPX file waits for the track it belongs to.' : `${count} GPX files wait for the tracks they belong to.`}
        </Text>
        <Button size='xs' variant='light' onClick={() => navigate('/staging/routes')}>Choose track</Button>
      </Group>
    </Alert>
  );
}
