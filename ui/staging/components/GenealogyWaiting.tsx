import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';

/**
 * The GEDCOM files waiting in the staging area's `genealogy/` (`count`, from `staging status`),
 * with the way to the page that draws each one's tree beside the archive's and imports it.
 */
export function GenealogyWaiting({ count }: { count: number }) {
  const navigate = useNavigate();
  if (count === 0) return null;
  return (
    <Alert color='yellow' icon={<TablerIcon name='sitemap' size={16} />} title='Needs you'>
      <Group justify='space-between' gap='sm'>
        <Text size='sm'>
          {count === 1
            ? 'A family tree waits for you to say who its people are in the archive.'
            : `${count} family trees wait for you to say who their people are in the archive.`}
        </Text>
        <Button size='xs' variant='light' onClick={() => navigate('/staging/genealogy')}>Review and import</Button>
      </Group>
    </Alert>
  );
}
