import type { DuplicateResolveResult, DuplicateSeparateResult, DuplicateSet } from '@archive/media/api';
import type { StagingUndoResult } from '@archive/staging/api';
import { shq } from '@ein/ui/lib';
import { closeLightboxWithoutReturn, currentMediaItem, execCommand, mediaRestored, notify } from '@ein/ui/signals';
import { useCallback } from 'react';
import { mediaMoved } from '../../media/signals/album.ts';
import { droppedPaths, resolveCommand, separateCommand } from '../lib/duplicate-sets.ts';

/**
 * What can be done with a duplicate set of the category at `category`: resolve it keeping any
 * staged file (`staging dedupe`), which drops the others from the lists showing them, or say its
 * look-alikes are no duplicates (`staging separate`). Each says so with Undo, and calls `changed`
 * once the sets are different, after the undo too.
 */
export function useSetActions(category: string, changed: () => void): {
  resolve: (set: DuplicateSet, keep: string) => Promise<void>;
  keepApart: (set: DuplicateSet) => Promise<void>;
} {
  const resolve = useCallback(async (set: DuplicateSet, keep: string) => {
    try {
      const answer = await execCommand<DuplicateResolveResult>(resolveCommand(category, [set.key], keep === set.keep ? undefined : keep));
      if (answer.resolved === 0) {
        notify({ message: `Left as it is: ${answer.skipped[0]?.reason ?? 'it changed'}`, color: 'red' });
        changed();
        return;
      }
      const gone = droppedPaths(set, keep, category);
      if (currentMediaItem.value && gone.includes(currentMediaItem.value.path)) closeLightboxWithoutReturn();
      mediaMoved.value = { paths: gone, at: Date.now() };
      changed();
      const journal = answer.journal;
      notify({
        message: `${answer.discarded.toLocaleString()} removed`,
        color: 'green',
        action: journal
          ? {
            label: 'Undo',
            onClick: async () => {
              try {
                await execCommand<StagingUndoResult>(`staging undo ${shq(journal)}`);
                mediaRestored.value = { paths: gone, at: Date.now() };
                changed();
              } catch (err) {
                notify({ message: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, color: 'red' });
              }
            },
          }
          : undefined,
      });
    } catch (err) {
      notify({ message: `Couldn't remove the duplicates: ${err instanceof Error ? err.message : String(err)}`, color: 'red' });
    }
  }, [category, changed]);

  const keepApart = useCallback(async (set: DuplicateSet) => {
    const command = separateCommand(set);
    if (!command) return;
    try {
      await execCommand<DuplicateSeparateResult>(command);
      changed();
      notify({
        message: 'Kept apart: not duplicates',
        color: 'green',
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await execCommand<DuplicateSeparateResult>(`${command} --off`);
              changed();
            } catch (err) {
              notify({ message: `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`, color: 'red' });
            }
          },
        },
      });
    } catch (err) {
      notify({ message: `Couldn't keep them apart: ${err instanceof Error ? err.message : String(err)}`, color: 'red' });
    }
  }, [changed]);

  return { resolve, keepApart };
}
