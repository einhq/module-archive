import type { CommandQueueHandle } from '@ein/ui/hooks';
import { execCommand, notifyProgress, type ProgressToast } from '@ein/ui/signals';
import { useCallback, useRef } from 'react';
import { journalOf, leftOf, progressLine } from '../lib/bulk.ts';
import { type Chunk, type GroupRef, laterChunks, undoCommands } from '../lib/selection-command.ts';

/** A decision over many groups, as a run of calls through the page's queue. */
export type BulkSpec = {
  /** What the progress line calls the work: "Filing", "Discarding". */
  verb: string;
  /** What Z and the Done tab would call it: "Filing 214 groups in “Lake trip 2019”". */
  label: string;
  /** The calls, in order. */
  chunks: Chunk[];
  /** The calls that follow from the first one's answer (the album a new-album run made), counted in `total` already. */
  then?: (answer: unknown) => Chunk[];
  /** What the run decides in all, for the progress line. */
  total: { groups: number; files: number };
  /** The groups decided whole stay in the index changed so (put aside, into another lane), rather than leaving it. */
  stays?: (group: GroupRef) => void;
  /** How the run is undone: its journal entries, or `staging later` the other way round (`off` as the undo passes it). */
  undo: 'journal' | { laterOff: boolean };
  /** What it says once done, from how many groups and pictures it decided. */
  done: (tally: { groups: number; files: number }) => string;
};

/** A run under way or done: what Z holds of it. */
export type BulkHandle = {
  label: string;
  /** Cancel the calls that have not run; false when none was left. */
  cancel: () => boolean;
  /** Undo what it did: cancel what has not run, then undo every journal entry it made (or bring its groups back), newest first. */
  undoAll: () => void;
};

/** What the run asks of the page around it. */
type BulkHost = {
  queue: CommandQueueHandle;
  /** Take groups out of the stream while their call waits, or bring them back. */
  hide: (names: string[]) => void;
  show: (names: string[]) => void;
  /** Groups decided whole: gone from the index. */
  remove: (names: string[]) => void;
  /** Groups changed, or given back: read again, their pictures forgotten. */
  reread: (paths: string[]) => void;
  /** The category's numbers changed. */
  changed: () => void;
};

/**
 * Decisions over many groups at once (`lib/selection-command.ts`): each call of a run waits its
 * turn in the page's serial queue, the groups it decides leave the view as soon as the run starts
 * and come back if their call fails or is cancelled, or if its answer leaves them as they were
 * (they changed meanwhile, or `staging accept` skipped them). A progress toast follows it ("Filing
 * 1,840 of 9,830 photos · 37 of 214 groups") with Cancel, which stops it after the call in flight;
 * once over it says what it did, with Undo all, which undoes every journal entry the run made,
 * newest first, at most 20 a call.
 */
export function useBulkRun(host: BulkHost): (spec: BulkSpec) => BulkHandle {
  const hostRef = useRef(host);
  hostRef.current = host;

  return useCallback((spec: BulkSpec): BulkHandle => {
    const { queue } = hostRef.current;
    const journal: string[] = [];
    /** Groups the run decided whole, in the order their calls answered. */
    const decided: GroupRef[] = [];
    const touched = new Map<string, GroupRef>();
    const queued = new Set<number>();
    const tally = { groups: 0, files: 0 };
    let failures = 0;
    let firstError = '';
    let open = 0;
    let stopping = false;
    let undone = false;

    const toast: ProgressToast = notifyProgress({
      message: progressLine(spec.verb, tally, spec.total),
      progress: 0,
      action: { label: 'Cancel', onClick: () => cancel() },
    });

    const finish = () => {
      const did = spec.done(tally);
      const failed = failures > 0 ? ` ${failures} ${failures === 1 ? 'call' : 'calls'} failed: ${firstError}` : '';
      const undoable = !undone && (spec.undo === 'journal' ? journal.length > 0 : decided.length > 0);
      toast.finish({
        message: `${did}${stopping ? ' (stopped)' : ''}.${failed}`,
        color: failures > 0 ? (tally.groups + tally.files > 0 ? 'yellow' : 'red') : 'green',
        // A run of one decision is undone as one decision is.
        ...(undoable ? { action: { label: journal.length > 1 || decided.length > 1 ? 'Undo all' : 'Undo', onClick: () => undoAll() } } : {}),
      });
      hostRef.current.changed();
    };

    const settle = () => {
      open--;
      const share = spec.total.groups > 0 ? tally.groups / spec.total.groups : spec.total.files > 0 ? tally.files / spec.total.files : 1;
      toast.update({ message: progressLine(spec.verb, tally, spec.total), progress: Math.min(1, share) });
      if (open === 0) finish();
    };

    const names = (chunk: Chunk) => [...chunk.groups, ...chunk.touched].map((group) => group.name);

    const enqueue = (chunk: Chunk) => {
      open++;
      hostRef.current.hide(chunk.groups.map((group) => group.name));
      const id: number = queue.enqueue<unknown>({
        label: `${spec.verb} ${chunk.decides > 0 ? `${chunk.decides} ${chunk.decides === 1 ? 'group' : 'groups'}` : `${chunk.files} photos`}`,
        run: () => execCommand<unknown>(chunk.command),
        onDone: (answer) => {
          queued.delete(id);
          journal.push(...journalOf(answer));
          const left = new Set(leftOf(answer));
          const whole = chunk.groups.filter((group) => !left.has(group.path));
          decided.push(...whole);
          for (const group of chunk.touched) touched.set(group.name, group);
          const host = hostRef.current;
          if (spec.stays) { for (const group of whole) spec.stays(group); }
          else host.remove(whole.map((group) => group.name));
          host.show(names(chunk));
          host.reread([...chunk.groups.filter((group) => left.has(group.path)), ...chunk.touched].map((group) => group.path));
          const kept = whole.length === chunk.groups.length;
          tally.groups += chunk.decides - (chunk.groups.length - whole.length);
          tally.files += kept ? chunk.files : whole.reduce((sum, group) => sum + (group.memberCount ?? 0), 0);
          if (!stopping) { for (const next of spec.then?.(answer) ?? []) enqueue(next); }
          settle();
        },
        onFail: (error) => {
          queued.delete(id);
          queue.dismiss(id);
          failures++;
          firstError ||= error.message;
          hostRef.current.show(names(chunk));
          hostRef.current.reread([...chunk.groups, ...chunk.touched].map((group) => group.path));
          settle();
        },
        onCancel: () => {
          queued.delete(id);
          hostRef.current.show(names(chunk));
          settle();
        },
      });
      queued.add(id);
    };

    const cancel = (): boolean => {
      if (queued.size === 0) return false;
      // Said before the calls are let go, which may end the run at once.
      stopping = true;
      let any = false;
      for (const id of [...queued]) any = queue.cancel(id) || any;
      if (open > 0) toast.update({ message: `${progressLine(spec.verb, tally, spec.total)} · stopping after the one in flight`, action: null });
      return any;
    };

    const undoAll = () => {
      if (undone) return;
      undone = true;
      cancel();
      // Behind whatever the run still has in flight, so what it answers is known by then.
      queue.enqueue<void>({
        label: `Undoing: ${spec.label}`,
        run: async () => {
          const groups = [...decided, ...touched.values()];
          const commands = spec.undo === 'journal' ? undoCommands(journal) : laterChunks(decided, spec.undo.laterOff).map((chunk) => chunk.command);
          const progress = notifyProgress({ message: `Undoing: ${spec.label}`, progress: 0 });
          const failed: string[] = [];
          for (const [at, command] of commands.entries()) {
            try {
              const answer = await execCommand<{ failed?: { reason: string }[] }>(command);
              for (const failure of answer.failed ?? []) failed.push(failure.reason);
            } catch (error) {
              failed.push(error instanceof Error ? error.message : String(error));
            }
            progress.update({ progress: (at + 1) / commands.length });
          }
          hostRef.current.reread(groups.map((group) => group.path));
          hostRef.current.changed();
          progress.finish(
            failed.length > 0
              ? { message: `Undone in part: ${failed[0]}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`, color: 'red' }
              : { message: `Undone: ${spec.label}`, color: 'green' },
          );
        },
      });
    };

    for (const chunk of spec.chunks) enqueue(chunk);
    if (spec.chunks.length === 0) finish();
    return { label: spec.label, cancel, undoAll };
  }, []);
}
