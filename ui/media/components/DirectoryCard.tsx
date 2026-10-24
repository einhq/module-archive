import { TablerIcon } from '@ein/ui/components';
import { Badge, Box, Card, Stack, Text, Tooltip } from '@mantine/core';
import type { DirectoryEntry } from '@ein/ui/signals';
import type { ReactNode } from 'react';

/**
 * Column breakpoints for the subfolder grid. Directories stay a square card grid — they
 * are labels, not pictures, so there is no aspect ratio to justify them by.
 */
export const DIRECTORY_GRID_COLS = { base: 3, sm: 4, md: 6, lg: 8 };

type DirectoryCardProps = {
  directory: DirectoryEntry;
  /** Lock the card of a folder that keeps its own sharing: for a reader who may change the album's. */
  markPinned?: boolean;
  /** What can be done to the folder, in the card's corner: a menu, whose clicks do not open the folder. */
  menu?: ReactNode;
  /** A word or two under its name about what it holds, such as the source it looks like it came from. */
  note?: string;
  onClick: () => void;
};

export function DirectoryCard({ directory, markPinned = false, menu, note, onClick }: DirectoryCardProps) {
  return (
    <Card
      p={0}
      radius='md'
      style={{
        cursor: 'pointer',
        aspectRatio: '1',
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--mrx-surface-raised)',
      }}
      onClick={onClick}
    >
      {menu && (
        <Box style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }} onClick={(event) => event.stopPropagation()}>
          {menu}
        </Box>
      )}
      {markPinned && directory.pinned && (
        <Tooltip label='Keeps its own sharing'>
          <Box data-folder-pinned aria-label='Keeps its own sharing' style={{ position: 'absolute', top: 8, right: 8, display: 'flex', color: 'var(--mantine-color-dimmed)' }}>
            <TablerIcon name='lock' size={16} />
          </Box>
        </Tooltip>
      )}
      <Stack align='center' justify='center' h='100%' gap='xs'>
        <TablerIcon name='folder' size={48} color='var(--mrx-accent)' />
        <Text size='sm' fw={500} ta='center' lineClamp={2} px='xs'>
          {directory.title}
        </Text>
        {directory.childCount > 0 && (
          <Badge size='xs' variant='light' color='gray'>
            {directory.childCount}
          </Badge>
        )}
        {note && (
          <Badge size='xs' variant='light' color='blue' leftSection={<TablerIcon name='wand' size={10} />} maw='90%'>
            {note}
          </Badge>
        )}
      </Stack>
    </Card>
  );
}
