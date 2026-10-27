import { Group, Text } from '@mantine/core';
import { CoverAvatar, TablerIcon } from '@ein/ui/components';

/** A person in a picker's list: their profile picture, or the person icon, beside their name. */
export function PersonOption({ path, name }: { path: string; name: string }) {
  return (
    <Group gap='sm' wrap='nowrap'>
      <CoverAvatar path={path} size={28} color='grape' alt='' fallback={<TablerIcon name='user' size={16} />} />
      <Text size='sm' truncate>{name}</Text>
    </Group>
  );
}
