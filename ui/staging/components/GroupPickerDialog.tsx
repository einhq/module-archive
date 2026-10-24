import { Dialog, formatRange, TablerIcon } from '@ein/ui/components';
import { Box, Group, Kbd, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { GroupRow } from '../hooks/useGroupIndex.ts';

/** Groups the list shows for a search. */
const FOUND_MAX = 20;

type Props = {
  /** What is being moved: the group it is in and how many pictures; null keeps the dialog closed. */
  moving: { from: string; count: number } | null;
  /** The groups around the one the pictures are in, nearest first; what the list offers before a search. */
  neighbours: readonly GroupRow[];
  /** Every group a search may find. */
  all: readonly GroupRow[];
  onClose: () => void;
  /** The group chosen, or `new` for a group of their own. */
  onPick: (to: GroupRow | 'new') => void;
};

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;

/**
 * G on pictures of the open group: the group they move to. A new group of their own first, then the
 * groups around this one; typing searches every group by name. The arrows move the highlight and
 * Enter takes it.
 */
export function GroupPickerDialog({ moving, neighbours, all, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  useEffect(() => {
    if (!moving) return;
    setQuery('');
    setHighlight(0);
  }, [moving]);

  const found = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return neighbours;
    return all.filter((row) => row.title.toLowerCase().includes(wanted)).slice(0, FOUND_MAX);
  }, [query, neighbours, all]);
  const choices: (GroupRow | 'new')[] = useMemo(() => ['new', ...found], [found]);
  const at = Math.min(highlight, choices.length - 1);

  return (
    <Dialog
      opened={moving !== null}
      onClose={onClose}
      title='Move to a group'
      subtitle={moving ? `${photos(moving.count)} from “${moving.from}”` : undefined}
      icon='arrows-transfer-up'
      pattern='album'
      size='sm'
      onSubmit={() => onPick(choices[at])}
    >
      <Stack gap='xs'>
        <TextInput
          data-autofocus
          aria-label='Find a group'
          placeholder='Find a group by name'
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlight(Math.max(0, Math.min(choices.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))));
            }
          }}
        />
        <Stack gap={2} role='listbox' aria-label='Groups'>
          {choices.map((choice, index) => {
            const row = choice === 'new' ? null : choice;
            return (
              <UnstyledButton
                key={row?.name ?? 'new'}
                role='option'
                aria-selected={index === at}
                onClick={() => onPick(choice)}
                onMouseEnter={() => setHighlight(index)}
                px='xs'
                py={6}
                style={{ borderRadius: 'var(--mantine-radius-sm)', background: index === at ? 'var(--mrx-surface-sunken)' : undefined }}
              >
                <Group gap='sm' wrap='nowrap'>
                  <TablerIcon name={row ? 'photo' : 'square-plus'} size={16} />
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text size='sm' truncate>{row ? row.title : 'New group'}</Text>
                    <Text size='xs' c='dimmed' truncate>
                      {row
                        ? [formatRange(row.timeStart, row.timeEnd), row.memberCount !== undefined ? photos(row.memberCount) : ''].filter(Boolean).join(' · ')
                        : 'A group of their own, named by their dates'}
                    </Text>
                  </Box>
                  {index === at && <Kbd size='xs'>Enter</Kbd>}
                </Group>
              </UnstyledButton>
            );
          })}
          {query.trim() && found.length === 0 && <Text size='xs' c='dimmed' px='xs'>No group is called that.</Text>}
        </Stack>
      </Stack>
    </Dialog>
  );
}
