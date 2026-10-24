import { useState } from 'react';
import type { AlbumAddResult } from '@archive/media/api';
import type { StagingUndoResult } from '@archive/staging/api';
import { SelectionActionButton, TablerIcon, useSelectionBar } from '@ein/ui/components';
import { useAccessIds } from '@ein/ui/hooks';
import { countOf, isGuest, shq } from '@ein/ui/lib';
import { closeLightboxWithoutReturn, currentMediaItem, execCommand, mediaRestored, notify } from '@ein/ui/signals';
import { mediaMoved } from '../signals/album.ts';
import { type AlbumChoice, AlbumPickerDialog } from './AlbumPickerDialog.tsx';

/**
 * Put the selected files in an album (`AlbumPickerDialog`): one that is there, or a new one made
 * with the name typed (`album add --create`). The files are linked, not moved, so they stay where
 * they are and may be in other albums too — except staged files, which move into the album out of
 * their private inbox, so the lists showing them drop them. A toast says where they went and
 * offers Undo, which unlinks the links and undoes the staged files' move through the staging
 * journal (`staging undo`), which also deletes a new album left empty.
 *
 * The guest, who may change no album and make none, is not offered the action.
 */
export function AddToAlbumAction({ paths, onDone }: { paths: string[]; onDone?: () => void }) {
  const access = useAccessIds();
  const { reportError } = useSelectionBar();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTo = async ({ path, title, create }: AlbumChoice) => {
    setBusy(true);
    setError(null);
    try {
      const result = await execCommand<AlbumAddResult>(`album add ${shq(path)} ${paths.map(shq).join(' ')}${create ? ` --create --name ${shq(title)}` : ''}`);
      setOpen(false);
      onDone?.();
      const links = result.added.map((entry) => entry.link);
      const moved = result.moved;
      if (moved.length > 0) {
        const gone = moved.map((entry) => entry.path);
        if (currentMediaItem.value && gone.includes(currentMediaItem.value.path)) closeLightboxWithoutReturn();
        mediaMoved.value = { paths: gone, at: Date.now() };
      }
      const undo = async () => {
        if (links.length > 0) await execCommand(`rm ${links.map(shq).join(' ')}`);
        if (result.journal && result.journal.length > 0) {
          await execCommand<StagingUndoResult>(`staging undo ${result.journal.map(shq).join(' ')}`);
          mediaRestored.value = { paths: moved.map((entry) => entry.path), at: Date.now() };
        }
      };
      const notes = [
        moved.length ? `${moved.length} moved out of staging` : '',
        result.already.length ? `${result.already.length} already there` : '',
      ].filter(Boolean);
      notify({
        message: `${links.length + moved.length} added to ${title}${notes.length ? `, ${notes.join(', ')}` : ''}`,
        color: 'green',
        action: links.length + moved.length > 0 ? { label: 'Undo', onClick: () => void undo().catch((err) => reportError(String(err))) } : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (isGuest(access)) return null;
  return (
    <>
      <SelectionActionButton icon={<TablerIcon name='library-plus' size={14} />} onClick={() => setOpen(true)} disabled={paths.length === 0}>
        Add to album
      </SelectionActionButton>
      <AlbumPickerDialog
        opened={open}
        title='Add to an album'
        subtitle={countOf(paths.length, 'file', 'files')}
        busy={busy}
        error={error}
        onClose={() => setOpen(false)}
        onPick={(choice) => void addTo(choice)}
      />
    </>
  );
}
