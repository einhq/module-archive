import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

/** One box of an Info tab: a heading, with what can be done to its rows beside it, over the rows. */
export function InfoSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Paper p='md' radius='md' bg='var(--mrx-surface-raised)'>
      <Stack gap='xs'>
        {action
          ? (
            <Group justify='space-between' wrap='nowrap'>
              <Title order={4}>{title}</Title>
              {action}
            </Group>
          )
          : <Title order={4}>{title}</Title>}
        {children}
      </Stack>
    </Paper>
  );
}

/** A label and its value, one row of a section. */
export function InfoFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap='md' align='baseline' wrap='nowrap'>
      <Text size='sm' c='dimmed' w={{ base: 80, sm: 110 }} style={{ flexShrink: 0 }}>{label}</Text>
      <Text size='sm' component='div' style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Text>
    </Group>
  );
}
