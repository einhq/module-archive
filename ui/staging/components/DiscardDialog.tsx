import type { StagingDiscardResult, StagingUndoResult } from '@archive/staging/api';
import { Dialog, DialogActions } from '@ein/ui/components';
import { execCommand, notify } from '@ein/ui/signals';
import { Alert, Button, Text } from '@mantine/core';
import { useState } from 'react';
import { discardFiles, undoEntries } from '../lib/decision-commands.ts';

type Props = {
  /** What goes: folders and files of a category. */
  paths: string[];
  /** What the dialog calls them: a folder's name, or "3 items". */
  what: string;
  onClose: () => void;
  /** Called once they are in the trash, and again once Undo brought them back. */
  onChanged: () => void;
};

/**
 * Discard folders and files of a category (`staging discard`): they leave every suggested group
 * first, then go to the reader's trash as one batch per 2,000, one row each on the Trash page. The
 * decision is journaled, so the toast's Undo — or the Done tab's, after a reload — brings them back
 * into their groups too.
 */
export function DiscardDialog({ paths, what, onClose, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await execCommand<StagingDiscardResult>(discardFiles(paths));
      onClose();
      onChanged();
      const journal = result.journal;
      notify({
        message: `${what} moved to the trash`,
        action: journal
          ? {
            label: 'Undo',
            onClick: () =>
              void execCommand<StagingUndoResult>(undoEntries([journal])).then(
                onChanged,
                (err) => notify({ message: err instanceof Error ? err.message : String(err), color: 'red' }),
              ),
          }
          : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened onClose={() => !busy && onClose()} title='Discard' subtitle={what} icon='trash' pattern='staging' size='sm'>
      {error && <Alert color='red' variant='light' mb='sm'>{error}</Alert>}
      <Text size='sm'>
        {paths.length === 1 ? 'It goes' : 'They go'} to your trash, kept together as one entry on the Trash page. Undo, here or on the Done tab, puts{' '}
        {paths.length === 1 ? 'it' : 'them'} back where {paths.length === 1 ? 'it was' : 'they were'}.
      </Text>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button color='red' onClick={() => void discard()} loading={busy}>Discard</Button>
      </DialogActions>
    </Dialog>
  );
}
