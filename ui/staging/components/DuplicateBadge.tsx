import { TablerIcon } from '@ein/ui/components';
import { Group, Text, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';
import type { TileBadge } from '../lib/duplicate-sets.ts';

/**
 * A tile's duplicate badge: a copy icon and how many files hold its bytes, itself included, with a
 * library icon when one of them is in the library; a click compares them.
 */
export const duplicateBadge = (badge: TileBadge, open: () => void): ReactNode => (
  <Tooltip label={`${badge.files.toLocaleString()} identical files${badge.library ? ', one in the library' : ''}: compare`}>
    <Text
      className='mrx-tile-badge'
      component='span'
      size='xs'
      fw={600}
      px={7}
      py={2}
      data-duplicates={badge.files}
      style={{ cursor: 'pointer', pointerEvents: 'auto' }}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
    >
      <Group component='span' gap={3} wrap='nowrap'>
        <TablerIcon name='copy' size={13} />
        {badge.files.toLocaleString()}
        {badge.library && <TablerIcon name='library' size={13} />}
      </Group>
    </Text>
  </Tooltip>
);
