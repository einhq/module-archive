/**
 * One section of the lightbox sidebar: a fixed icon gutter with the content beside it.
 *
 * The gutter is what makes the sections scannable — the eye runs down a column of icons rather
 * than reading every heading. The icon also folds its section away, to one line naming it, and
 * which sections are folded is remembered in localStorage for every picture and every visit.
 */

import { TablerIcon } from '@ein/ui/components';
import { usePersistedState } from '@ein/ui/hooks';
import { ActionIcon, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';

const SECTION_ICON_SIZE = 32;

/**
 * The sections folded or unfolded by hand, as `id:open` and `id:closed` separated by commas; a
 * section not named is at its default. Every `useSectionOpen` reads the same key, and Mantine's
 * local storage hook keeps them in step.
 */
const SECTIONS_KEY = 'lightbox.sections';

function parseSections(stored: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const entry of stored.split(',')) {
    const [id, state] = entry.split(':');
    if (id && (state === 'open' || state === 'closed')) states.set(id, state === 'open');
  }
  return states;
}

/** Whether section `id` is open, and a toggle that remembers the change. */
export function useSectionOpen(id: string, defaultOpen = true): [boolean, () => void] {
  const [stored, setStored] = usePersistedState<string>(SECTIONS_KEY, '');
  const states = parseSections(stored);
  const open = states.get(id) ?? defaultOpen;
  const toggle = () => {
    if (!open === defaultOpen) states.delete(id);
    else states.set(id, !open);
    setStored([...states].map(([key, value]) => `${key}:${value ? 'open' : 'closed'}`).join(','));
  };
  return [open, toggle];
}

export function SidebarSection({ id, label, icon, count, defaultOpen = true, gap = 6, children }: {
  /** What the folded state is remembered by. */
  id: string;
  /** The section's name, shown beside the icon while it is folded. */
  label: string;
  icon: string;
  /** How many rows the section holds, shown with the name while it is folded. */
  count?: number;
  defaultOpen?: boolean;
  /** The space between the content's rows. */
  gap?: number | 'sm';
  children: ReactNode;
}) {
  const [open, toggle] = useSectionOpen(id, defaultOpen);
  return (
    <Group align={open ? 'flex-start' : 'center'} gap='sm' wrap='nowrap'>
      <ActionIcon
        variant='subtle'
        color='gray'
        size={SECTION_ICON_SIZE}
        onClick={toggle}
        aria-expanded={open}
        aria-label={`${open ? 'Fold' : 'Unfold'} ${label}`}
        title={label}
        style={{ flex: `0 0 ${SECTION_ICON_SIZE}px`, color: 'var(--mantine-color-dimmed)' }}
      >
        <TablerIcon name={icon} size={SECTION_ICON_SIZE} />
      </ActionIcon>
      {open
        ? <Stack gap={gap} style={{ flex: 1, minWidth: 0 }}>{children}</Stack>
        : (
          <UnstyledButton onClick={toggle} aria-hidden tabIndex={-1} style={{ flex: 1, minWidth: 0 }}>
            <Text size='sm' c='dimmed'>{count === undefined ? label : `${label} · ${count}`}</Text>
          </UnstyledButton>
        )}
    </Group>
  );
}
