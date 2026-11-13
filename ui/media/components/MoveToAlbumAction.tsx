import { useMemo, useState } from 'react';
import type { AlbumMoveResult } from '@archive/media/api';
import { SelectionActionButton, TablerIcon } from '@ein/ui/components';
import { type MediaSelection, usePersistedState } from '@ein/ui/hooks';
import { baseName, countOf, parentPath, shq } from '@ein/ui/lib';
import { closeLightboxWithoutReturn, currentMediaItem, execCommand, type MediaItem, mediaRestored, notify } from '@ein/ui/signals';
import { mediaMoved } from '../signals/album.ts';
import { parseRecent, withRecent } from '../../staging/lib/destinations.ts';
import { type AlbumChoice, AlbumPickerDialog } from './AlbumPickerDialog.tsx';

/**
 * Move the selected pictures out of `album` into another album (`AlbumPickerDialog`): one that is
 * there, one of the albums filed into lately, or a new one made with the name typed
 * (`album move --create`). A picture that lives here moves; one only added here takes its link
 * along. Every link to a moved picture keeps working. A toast says where they went and offers
 * Undo, which moves them back and puts back the links the move removed.
 */
export function MoveToAlbumAction({ selection, items, album }: { selection: MediaSelection; items: MediaItem[]; album: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shared with the Sort stream's picker: the albums this viewer filed into lately.
  const [recentStored, setRecentStored] = usePersistedState<string>('staging.recent', '[]');
  const recent = useMemo(() => parseRecent(recentStored).filter((each) => each.path !== album), [recentStored, album]);

  const selected = items.filter((item) => selection.selected.has(item.path));

  const moveTo = async ({ path, title, create }: AlbumChoice) => {
    setBusy(true);
    setError(null);
    try {
      // A picture only added here is moved as the link that files it here.
      const sources = new Map(selected.map((item) => [item.memberPath ?? item.path, item.path]));
      const result = await execCommand<AlbumMoveResult>(
        `album move ${shq(path)} ${[...sources.keys()].map(shq).join(' ')}${create ? ` --create --name ${shq(title)}` : ''}`,
      );
      setOpen(false);
      selection.clear();
      setRecentStored(JSON.stringify(withRecent(parseRecent(recentStored), { path, title })));

      const left = [...result.moved.map((entry) => entry.path), ...result.unlinked.map((entry) => entry.link)];
      const gone = left.flatMap((source) => sources.get(source) ?? []);
      if (gone.length > 0) {
        if (currentMediaItem.value && gone.includes(currentMediaItem.value.path)) closeLightboxWithoutReturn();
        mediaMoved.value = { paths: gone, at: Date.now() };
      }
      const undo = async () => {
        // Back where each came from: in one `mv` per folder, unless the move renamed it.
        const byDir = new Map<string, string[]>();
        for (const { path: from, to } of result.moved) {
          const dir = parentPath(from);
          if (baseName(from) !== baseName(to)) await execCommand(`mv -n ${shq(to)} ${shq(from)}`);
          else byDir.set(dir, [...byDir.get(dir) ?? [], to]);
        }
        for (const [dir, paths] of byDir) await execCommand(`mv -n ${paths.map(shq).join(' ')} ${shq(`${dir}/`)}`);
        for (const { link, target } of result.unlinked) await execCommand(`ln -s ${shq(target)} ${shq(link)}`);
        mediaRestored.value = { paths: gone, at: Date.now() };
      };
      // A link dropped because its picture was there already left this album like a moved one.
      const already = result.already.filter((source) => !result.unlinked.some((entry) => entry.link === source)).length;
      const notes = [
        already ? `${already} already there` : '',
        result.failed.length ? `${result.failed.length} could not be moved: ${result.failed[0].error}` : '',
      ].filter(Boolean);
      notify({
        message: `${gone.length} moved to ${title}${notes.length ? `, ${notes.join(', ')}` : ''}`,
        color: result.failed.length ? 'red' : 'green',
        action: gone.length > 0
          ? { label: 'Undo', onClick: () => void undo().catch((err) => notify({ message: err instanceof Error ? err.message : String(err), color: 'red' })) }
          : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SelectionActionButton icon={<TablerIcon name='folder-share' size={14} />} onClick={() => setOpen(true)} disabled={selected.length === 0}>
        Move to album
      </SelectionActionButton>
      <AlbumPickerDialog
        opened={open}
        title='Move to an album'
        subtitle={countOf(selected.length, 'file', 'files')}
        icon='folder-share'
        suggested={recent}
        busy={busy}
        error={error}
        onClose={() => setOpen(false)}
        onPick={(choice) => void moveTo(choice)}
      />
    </>
  );
}
