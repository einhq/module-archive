import type { StagingJournalEntry, StagingJournalPage, StagingUndoResult } from '@archive/staging/api';
import { EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { Alert, Anchor, Badge, Box, Button, Group, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { albumRoute } from '../../media/lib/album-path.ts';
import * as commands from '../lib/decision-commands.ts';

/** Entries per page of the journal. */
const PAGE = 50;

const ENTRY_ICONS: Record<StagingJournalEntry['action'], string> = {
  promote: 'photo-check',
  file: 'photo-check',
  discard: 'trash',
  dedupe: 'copy',
  edit: 'pencil',
  reject: 'circle-x',
};

type Props = {
  /** The category whose decisions are listed. */
  category: string;
  /** Something was undone, so the category's numbers changed. */
  onChanged: () => void;
};

const time = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Everything decided, or only the changes of the groups (`--action edit`). */
type Shown = 'all' | 'edit';

/**
 * The Done tab: what was decided in a category, newest first, a page at a time
 * (`staging journal <category>`) — what was filed and discarded, and how the groups were changed:
 * split, moved between, merged, made, renamed, said to be no group — each with Undo while it can
 * be undone. **Regrouping** shows the changes of the groups alone. Its totals are those of every
 * decision not undone.
 */
export function DoneTab({ category, onChanged }: Props) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<StagingJournalEntry[]>([]);
  const [totals, setTotals] = useState<StagingJournalPage['totals'] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>('all');

  const load = useCallback(async (after: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await execCommand<StagingJournalPage>(
        `staging journal ${shq(category)} --limit ${PAGE}${shown === 'edit' ? ' --action edit' : ''}${after ? ` --cursor ${shq(after)}` : ''}`,
      );
      setEntries((previous) => after ? [...previous, ...page.entries] : page.entries);
      setTotals(page.totals);
      setCursor(page.cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [category, shown]);

  useEffect(() => {
    void load(null);
  }, [load]);

  const undo = async (entry: StagingJournalEntry) => {
    setUndoing(entry.id);
    try {
      const result = await execCommand<StagingUndoResult>(commands.undoEntries([entry.id]));
      const failed = result.failed[0];
      notify(failed ? { message: `Undone in part: ${failed.reason}`, color: 'yellow' } : { message: `Undone: ${entry.summary}`, color: 'green' });
      onChanged();
      await load(null);
    } catch (err) {
      notify({ message: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, color: 'red' });
    } finally {
      setUndoing(null);
    }
  };

  if (error && entries.length === 0) return <Alert color='red' m='md'>{error}</Alert>;
  if (loading && entries.length === 0 && shown === 'all') return <PageLoader label='Reading what was decided…' />;
  if (entries.length === 0 && shown === 'all') {
    return <EmptyState title='Nothing decided yet'>What you file and discard here, and how you change the groups, is listed, with Undo.</EmptyState>;
  }

  return (
    <Box px='md'>
      <Group justify='space-between' mb='sm' gap='xs'>
        <Text size='sm' c='dimmed'>
          {totals ? `${totals.filed.toLocaleString()} filed · ${totals.discarded.toLocaleString()} discarded` : ''}
        </Text>
        <SegmentedControl
          size='xs'
          value={shown}
          onChange={(value) => setShown(value as Shown)}
          data={[{ value: 'all', label: 'Everything' }, { value: 'edit', label: 'Regrouping' }]}
        />
      </Group>
      {entries.length === 0 && !loading && <Text size='sm' c='dimmed'>No group has been changed by hand here yet.</Text>}
      <Stack gap={4}>
        {entries.map((entry) => (
          <Group key={entry.id} justify='space-between' wrap='nowrap' gap='sm' py={6} style={{ borderBottom: '1px solid var(--mrx-border-subtle)' }}>
            <Group gap='sm' wrap='nowrap' style={{ minWidth: 0 }}>
              <TablerIcon name={ENTRY_ICONS[entry.action]} size={16} />
              <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{time(entry.at)}</Text>
              <Box style={{ minWidth: 0 }}>
                <Text size='sm' truncate td={entry.undoneAt ? 'line-through' : undefined}>
                  {entry.destination && entry.action !== 'discard'
                    ? (
                      <>
                        {entry.files.toLocaleString()} {entry.files === 1 ? 'file' : 'files'} →{' '}
                        <Anchor component='button' type='button' size='sm' onClick={() => navigate(albumRoute(entry.destination!.path))}>{entry.destination.title}</Anchor>
                      </>
                    )
                    : entry.summary}
                </Text>
                {entry.groups && entry.groups.length > 0 && <Text size='xs' c='dimmed' truncate>{entry.groups.map((group) => group.name).join(', ')}</Text>}
              </Box>
              {entry.share === 'private' && <Badge size='xs' variant='light' color='gray'>only you</Badge>}
              {entry.edit && !entry.undoneAt && (
                <Tooltip label='The organizer keeps this change on every run until it is undone'>
                  <Badge size='xs' variant='light' color='grape'>kept</Badge>
                </Tooltip>
              )}
              {entry.state === 'partial' && <Badge size='xs' variant='light' color='yellow'>in part</Badge>}
            </Group>
            {entry.undoneAt
              ? <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>undone {time(entry.undoneAt)}</Text>
              : (
                <Button size='compact-xs' variant='subtle' loading={undoing === entry.id} disabled={undoing !== null} onClick={() => void undo(entry)}>
                  Undo
                </Button>
              )}
          </Group>
        ))}
      </Stack>
      {cursor && (
        <Group justify='center' mt='md'>
          <Button variant='light' size='xs' loading={loading} onClick={() => void load(cursor)}>Show older</Button>
        </Group>
      )}
    </Box>
  );
}
