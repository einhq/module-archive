import type { DuplicatePage, DuplicateResolveResult, DuplicateSeparateResult, DuplicateSet } from '@archive/media/api';
import type { StagingCategoryStatus, StagingUndoResult } from '@archive/staging/api';
import { Dialog, DialogActions, EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useCommandQueue, useLoadMoreSentinel } from '@ein/ui/hooks';
import { dialogPath, dismissToast, execCommand, isLightboxOpen, notify } from '@ein/ui/signals';
import { Alert, Box, Button, Group, Progress, SegmentedControl, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendSets,
  bulkClass,
  bulkCommand,
  bulkPercent,
  copiesWord,
  DUPLICATE_TABS,
  type DuplicateTab,
  pageCommand,
  resolveCommand,
  separateCommand,
  tabKey,
  undoCommands,
  withoutSets,
} from '../lib/duplicate-sets.ts';
import { keysAllowed, type KeyTarget } from '../lib/triage-keys.ts';
import { CompareDialog } from './CompareDialog.tsx';
import { DuplicateSetView } from './DuplicateSetView.tsx';

type Props = {
  /** The category whose copies are listed and resolved. */
  category: StagingCategoryStatus;
  /** Copies were dropped or came back, so the category's numbers changed. */
  onChanged: () => void;
};

/** A decision of this visit: what it is called, the queue's task, and the journal entries its answer named. */
type Taken = { label: string; queued: number; keys: string[]; journal: string[] };

/** A bulk run: how many copies it dropped, how many are left, its journal entries, and whether it was told to stop. */
type Bulk = { tab: DuplicateTab; dropped: number; remaining: number | null; journal: string[]; stopping: boolean };

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The Duplicates tab: the category's copies and look-alikes, read from the findings each staged
 * photo carries (`staging duplicates`), one class at a time — copies of library photos, copies
 * within this import, photos like library photos, photos alike within this import — a page of
 * sets at a time as the list scrolls. Each set shows the file kept, why, what it would gain, and
 * the files it drops; **Remove** drops them (`staging dedupe`), at once off the list, through the
 * page's serial queue, with Undo in the message, on Z and on the Done tab. **Compare** shows a
 * set's files side by side (`CompareDialog`), where another can be kept; **Not duplicates**
 * records that look-alikes are not (`staging separate`). **Remove all** resolves every set of the
 * class that resolves unasked — copies, and smaller versions of library photos — a bounded call at
 * a time, with its progress, and undoes as one. J and K move between sets, Enter removes what the
 * one marked drops, C compares it.
 */
export function DuplicatesTab({ category, onChanged }: Props) {
  const counts = (tab: DuplicateTab) => (tab.kind === 'exact' ? category.counts.copies : category.counts.near)[tab.where];
  const [current, setCurrent] = useState<string>(() => tabKey(DUPLICATE_TABS.find((tab) => counts(tab) > 0) ?? DUPLICATE_TABS[0]));
  const tab = DUPLICATE_TABS.find((each) => tabKey(each) === current) ?? DUPLICATE_TABS[0];
  const [comparing, setComparing] = useState<DuplicateSet | null>(null);
  const scope = category.path;
  const queue = useCommandQueue();

  const [sets, setSets] = useState<DuplicateSet[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [confirming, setConfirming] = useState(false);
  const latest = useRef<AbortController | null>(null);
  const taken = useRef<Taken[]>([]);
  const toast = useRef<number | null>(null);
  const bulkRef = useRef<Bulk | null>(null);

  /** Read the first page of the class, or the page after `after`; only the latest read is kept. */
  const load = useCallback(async (after: string | null) => {
    latest.current?.abort();
    const run = new AbortController();
    latest.current = run;
    setLoading(true);
    setError(null);
    try {
      const page = await execCommand<DuplicatePage>(pageCommand(scope, tab, after), { signal: run.signal });
      if (run !== latest.current) return;
      setSets((held) => after === null ? page.sets : appendSets(held, page.sets));
      setCursor(page.cursor);
    } catch (err) {
      if (run === latest.current) setError(messageOf(err));
    } finally {
      if (run === latest.current) setLoading(false);
    }
  }, [scope, current]);

  useEffect(() => {
    setSets([]);
    setCursor(null);
    setGone(new Set());
    void load(null);
  }, [load]);
  useEffect(() => () => latest.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (cursor !== null) void load(cursor);
  }, [cursor, load]);
  const sentinelRef = useLoadMoreSentinel(cursor !== null && error === null, loading, loadMore);

  const visible = withoutSets(sets, gone);
  const hide = (keys: string[], hidden: boolean) =>
    setGone((previous) => {
      const next = new Set(previous);
      for (const key of keys) hidden ? next.add(key) : next.delete(key);
      return next;
    });

  const say = useCallback((message: string, undo?: () => void, color?: 'red' | 'yellow' | 'green') => {
    if (toast.current !== null) dismissToast(toast.current);
    toast.current = notify({ message, ...(color ? { color } : {}), ...(undo ? { action: { label: 'Undo', onClick: undo } } : {}) });
  }, []);

  /** Undo a decision of this visit: cancelled when it has not run, otherwise its journal entries undone behind it in the queue. */
  const undo = useCallback((entry: Taken) => {
    taken.current = taken.current.filter((each) => each !== entry);
    if (queue.cancel(entry.queued)) {
      hide(entry.keys, false);
      return;
    }
    queue.enqueue({
      label: `Undoing: ${entry.label}`,
      run: async () => {
        const answers: StagingUndoResult[] = [];
        for (const line of undoCommands(entry.journal)) answers.push(await execCommand<StagingUndoResult>(line));
        return answers;
      },
      onDone: (answers) => {
        const failed = answers.flatMap((answer) => answer.failed);
        hide(entry.keys, false);
        if (entry.keys.length === 0) void load(null);
        say(failed.length > 0 ? `Undone in part: ${failed[0].reason}` : `Undone: ${entry.label}`, undefined, failed.length > 0 ? 'yellow' : undefined);
        onChanged();
      },
      onFail: (err) => say(`Couldn't undo: ${err.message}`, undefined, 'red'),
    });
  }, [queue, say, onChanged, load]);

  /** Resolve one set: off the list at once, its command in the queue, Undo in the message. */
  const resolve = useCallback((set: DuplicateSet, keep?: string) => {
    const index = visible.findIndex((each) => each.key === set.key);
    setFocus(visible[index + 1]?.key ?? visible[index - 1]?.key ?? null);
    hide([set.key], true);
    const entry: Taken = {
      label: `Removing ${set.kind === 'near' ? `${set.discard.length.toLocaleString()} look-alike(s)` : copiesWord(set.discard.length)}`,
      queued: 0,
      keys: [set.key],
      journal: [],
    };
    entry.queued = queue.enqueue({
      label: entry.label,
      run: () => execCommand<DuplicateResolveResult>(resolveCommand(scope, [set.key], keep)),
      onDone: (answer) => {
        if (answer.resolved === 0) {
          taken.current = taken.current.filter((each) => each !== entry);
          hide([set.key], false);
          say(`Left as it is: ${answer.skipped[0]?.reason ?? 'it changed'}`, undefined, 'red');
          return;
        }
        entry.journal = answer.journal ? [answer.journal] : [];
        say(`${answer.discarded.toLocaleString()} removed`, entry.journal.length > 0 ? () => undo(entry) : undefined, 'green');
        onChanged();
      },
      onFail: (err) => {
        taken.current = taken.current.filter((each) => each !== entry);
        hide([set.key], false);
        say(`Couldn't remove the copies: ${err.message}`, undefined, 'red');
      },
      onCancel: () => hide([set.key], false),
    });
    taken.current = [...taken.current, entry];
  }, [visible, queue, scope, say, undo, onChanged]);

  /** Not duplicates: the set off the list at once, the files kept apart through the queue; undone by keeping them apart no longer. */
  const keepApart = useCallback((set: DuplicateSet) => {
    const command = separateCommand(set);
    if (!command) return;
    hide([set.key], true);
    queue.enqueue({
      label: 'Keeping look-alikes apart',
      run: () => execCommand<DuplicateSeparateResult>(command),
      onDone: () => {
        say('Kept apart: not duplicates', () => {
          queue.enqueue({
            label: 'Undoing: kept apart',
            run: () => execCommand<DuplicateSeparateResult>(`${command} --off`),
            onDone: () => {
              hide([set.key], false);
              void load(null);
              onChanged();
            },
            onFail: (err) => say(`Couldn't undo: ${err.message}`, undefined, 'red'),
          });
        }, 'green');
        onChanged();
      },
      onFail: (err) => {
        hide([set.key], false);
        say(`Couldn't keep them apart: ${err.message}`, undefined, 'red');
      },
    });
  }, [queue, say, load, onChanged]);

  /** The next call of a bulk run, from `from`; the run ends when the class is done or it was told to stop. */
  const bulkStep = useCallback((from: string | null) => {
    const run = bulkRef.current;
    if (!run) return;
    queue.enqueue({
      label: `Removing copies: ${copiesWord(run.dropped)} so far`,
      run: () => execCommand<DuplicateResolveResult>(bulkCommand(scope, run.tab, from)),
      onDone: (answer) => {
        const next: Bulk = {
          ...run,
          dropped: run.dropped + answer.discarded,
          remaining: answer.remaining,
          journal: answer.journal ? [...run.journal, answer.journal] : run.journal,
          stopping: bulkRef.current?.stopping ?? false,
        };
        bulkRef.current = next;
        setBulk(next);
        if (answer.more && !next.stopping) {
          bulkStep(answer.cursor);
          return;
        }
        bulkRef.current = null;
        setBulk(null);
        const entry: Taken = { label: `Removing ${copiesWord(next.dropped)}`, queued: 0, keys: [], journal: next.journal };
        if (next.journal.length > 0) taken.current = [...taken.current, entry];
        say(`${copiesWord(next.dropped)} removed`, next.journal.length > 0 ? () => undo(entry) : undefined, 'green');
        void load(null);
        onChanged();
      },
      onFail: (err) => {
        const failed = bulkRef.current;
        bulkRef.current = null;
        setBulk(null);
        const entry: Taken = { label: 'Removing copies', queued: 0, keys: [], journal: failed?.journal ?? [] };
        if (entry.journal.length > 0) taken.current = [...taken.current, entry];
        say(`Stopped: ${err.message}`, entry.journal.length > 0 ? () => undo(entry) : undefined, 'red');
        void load(null);
        onChanged();
      },
    });
  }, [queue, scope, say, undo, load, onChanged]);

  const startBulk = () => {
    setConfirming(false);
    const run: Bulk = { tab, dropped: 0, remaining: counts(tab), journal: [], stopping: false };
    bulkRef.current = run;
    setBulk(run);
    bulkStep(null);
  };

  // J and K move between sets, Enter removes the marked one's copies, Z undoes this visit's last decision.
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyRef.current = (event: KeyboardEvent) => {
    const context = { lightboxOpen: isLightboxOpen.peek(), dialogOpen: dialogPath.peek() !== null, modalOpen: confirming || comparing !== null };
    if (event.ctrlKey || event.metaKey || event.altKey || !keysAllowed(event.target as KeyTarget | null, context, event.key)) return;
    const key = event.key.toLowerCase();
    const at = visible.findIndex((set) => set.key === focus);
    if (key === 'j' || key === 'k') {
      const next = visible[key === 'j' ? at + 1 : Math.max(0, at - 1)];
      if (next) setFocus(next.key);
    } else if (event.key === 'Enter' && at >= 0 && bulk === null && (visible[at].bulk || visible[at].blocked === 'needs-review')) resolve(visible[at]);
    else if (key === 'c' && at >= 0 && bulk === null) setComparing(visible[at]);
    else if (key === 'z') {
      const last = taken.current.at(-1);
      if (last) undo(last);
    } else return;
    event.preventDefault();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (focus === null) return;
    document.querySelector(`[data-duplicate-set="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const backlog = queue.items.filter((item) => item.state !== 'failed').length;
  const label = tab.label;
  const all = counts(tab);

  return (
    <Stack gap='md' px='md'>
      <Group justify='space-between' gap='xs'>
        <SegmentedControl
          size='xs'
          value={current}
          onChange={setCurrent}
          disabled={bulk !== null}
          data={DUPLICATE_TABS.map((each) => ({ value: tabKey(each), label: `${each.label} ${counts(each).toLocaleString()}` }))}
        />
        <Group gap='xs'>
          {backlog > 0 && bulk === null && <Text size='xs' c='dimmed'>◌ {backlog.toLocaleString()} applying</Text>}
          {all > 0 && bulk === null && bulkClass(tab) && (
            <Button
              size='xs'
              variant='light'
              color='red'
              leftSection={<TablerIcon name='trash' size={14} />}
              onClick={() => setConfirming(true)}
            >
              Remove all {tab.kind === 'exact' ? copiesWord(all) : 'smaller versions'}…
            </Button>
          )}
        </Group>
      </Group>

      {bulk && (
        <Stack gap={4}>
          <Group justify='space-between'>
            <Text size='sm'>
              Removing {label.toLowerCase()}: {copiesWord(bulk.dropped)} so far{bulk.remaining !== null ? `, ${bulk.remaining.toLocaleString()} left` : ''}
            </Text>
            <Button
              size='compact-xs'
              variant='subtle'
              disabled={bulk.stopping}
              onClick={() => {
                if (bulkRef.current) bulkRef.current = { ...bulkRef.current, stopping: true };
                setBulk((current) => current && { ...current, stopping: true });
              }}
            >
              {bulk.stopping ? 'Stopping…' : 'Stop'}
            </Button>
          </Group>
          <Progress value={bulkPercent(bulk.dropped, bulk.remaining)} animated={!bulk.stopping} />
        </Stack>
      )}

      {error && visible.length === 0
        ? <Alert color='red'>{error}</Alert>
        : loading && sets.length === 0
        ? <PageLoader label='Reading the copies…' />
        : visible.length === 0 && cursor === null
        ? (
          <EmptyState title='No copies here'>
            {tab.kind === 'exact'
              ? (tab.where === 'library' ? 'No photo of this category is a copy of one in the library.' : 'No photo of this category is a copy of another one here.')
              : (tab.where === 'library' ? 'No photo of this category looks like one in the library.' : 'No two photos of this category look like one picture.')}
          </EmptyState>
        )
        : (
          <Stack gap='sm'>
            {visible.map((set) => (
              <Box key={set.key} data-duplicate-set={set.key}>
                <DuplicateSetView
                  set={set}
                  focused={set.key === focus}
                  disabled={bulk !== null}
                  onResolve={resolve}
                  onFocus={(each) => setFocus(each.key)}
                  onCompare={setComparing}
                  onSeparate={keepApart}
                />
              </Box>
            ))}
            {error && <Alert color='red'>{error}</Alert>}
            <Box ref={sentinelRef} h={1} />
            {loading && sets.length > 0 && <PageLoader label='Reading more copies…' />}
          </Stack>
        )}

      <Dialog opened={confirming} onClose={() => setConfirming(false)} title={`Remove all ${label.toLowerCase()}?`} icon='trash' pattern='staging' size='sm'>
        <Text size='sm'>
          {tab.kind === 'exact' ? copiesWord(all) : 'The staged photos that are smaller versions of library photos'}{' '}
          go to your trash, each once the file kept is filled in with what the dropped one has and it lacks. A set whose kept file is gone or that you cannot fill in is left
          as it is{tab.kind === 'near' ? ', and so is any that may be two shots rather than one picture twice' : ''}. One message undoes it all, and so does the Done tab.
        </Text>
        <DialogActions>
          <Button variant='default' onClick={() => setConfirming(false)}>Cancel</Button>
          <Button color='red' onClick={startBulk}>Remove {tab.kind === 'exact' ? copiesWord(all) : 'them'}</Button>
        </DialogActions>
      </Dialog>

      <CompareDialog
        set={comparing}
        onClose={() => setComparing(null)}
        onResolve={(set, keep) => {
          setComparing(null);
          resolve(set, keep === set.keep ? undefined : keep);
        }}
        onSeparate={(set) => {
          setComparing(null);
          keepApart(set);
        }}
      />
    </Stack>
  );
}
