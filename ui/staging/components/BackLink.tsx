import { TablerIcon } from '@ein/ui/components';
import { Anchor } from '@mantine/core';
import { Link } from 'react-router-dom';

/**
 * A page header's way back, as its eyebrow: an arrow and the name of where it leads (`← Staging`),
 * in the header's light text, underlined under the pointer.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Anchor component={Link} to={to} size='sm' c='gray.2' underline='hover' style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <TablerIcon name='arrow-left' size={14} />
      {label}
    </Anchor>
  );
}
