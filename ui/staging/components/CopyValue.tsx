import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Code, CopyButton, Group, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';

/** A value to type elsewhere, a path or an address, with a button that copies it and what follows it, such as a link to how. */
export function CopyValue({ value, label, children }: { value: string; label: string; children?: ReactNode }) {
  return (
    <Group gap='xs' wrap='nowrap'>
      <Code style={{ overflowWrap: 'anywhere' }}>{value}</Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : label}>
            <ActionIcon variant='subtle' color={copied ? 'teal' : 'gray'} onClick={copy} aria-label={label}>
              <TablerIcon name={copied ? 'check' : 'copy'} size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
      {children}
    </Group>
  );
}
