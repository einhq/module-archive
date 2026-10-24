import { Text, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';
import type { TileBadge } from '../lib/duplicate-sets.ts';

/** A tile's duplicate badge: ⧉ for a copy or look-alike of a library photo, 2× for one of another staged photo; a click compares. */
export const duplicateBadge = (badge: TileBadge, open: () => void): ReactNode => (
  <Tooltip label={badge === 'library' ? 'In the library already: compare' : 'Another one here is the same picture: compare'}>
    <Text
      className='mrx-tile-badge'
      component='span'
      size='xs'
      fw={600}
      px={7}
      py={2}
      style={{ cursor: 'pointer', pointerEvents: 'auto' }}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
    >
      {badge === 'library' ? '⧉' : '2×'}
    </Text>
  </Tooltip>
);
