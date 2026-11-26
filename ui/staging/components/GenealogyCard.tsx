import { TablerIcon } from '@ein/ui/components';
import { usePhone } from '@ein/ui/hooks';
import { Box, Button, Group, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { frameStyle, SECTION_METRICS } from './GroupSection.tsx';

/**
 * The GEDCOM files waiting in the staging area's `genealogy/` (`count`, from `staging status`), as
 * a card at the head of the Sort stream, framed like a group's, with the way to the page that draws
 * each one's tree beside the archive's and imports it.
 */
export function GenealogyCard({ count }: { count: number }) {
  const phone = usePhone();
  const navigate = useNavigate();
  if (count === 0) return null;
  return (
    <Box px='md' pb={12} data-genealogy-card>
      <Box px='sm' style={frameStyle(false, false)}>
        <Group gap='sm' mih={phone ? SECTION_METRICS.phone.header : SECTION_METRICS.desktop.header} align='center' wrap='nowrap'>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap={6} wrap='nowrap'>
              <TablerIcon name='sitemap' size={16} />
              <Text fw={600} truncate>{count === 1 ? 'A family tree' : `${count.toLocaleString()} family trees`}</Text>
            </Group>
            <Text size='xs' c='dimmed' mt={2} truncate>
              {count === 1 ? 'Say who its people are in the archive' : 'Say who their people are in the archive'}
            </Text>
          </Box>
          <Button size='compact-sm' variant='default' onClick={() => navigate('/staging/genealogy')}>Review and import</Button>
        </Group>
      </Box>
    </Box>
  );
}
