import { useState } from 'react';
import { execCommand, MediaItem } from '@ein/ui/signals';
import type { MediaSelection } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { SelectionActionButton, TablerIcon, useSelectionBar } from '@ein/ui/components';
import { requestAlbumMediaRefresh } from '../signals/album.ts';

type Props = {
  selection: MediaSelection;
  /** Everything loaded, in list order. The selection is read out of this. */
  items: MediaItem[];
  /** The album whose manifest the stack lives in — the page being viewed. */
  album: string;
};

/**
 * Stack the current selection into one album-local group.
 *
 * Self-contained like `SetTimeAction`: the album page adds it to `MediaSelectionBar`'s
 * `actions` slot and the bar never learns what it does. There is no dialog: the server does
 * the one interesting thing — if a picked photo is already in a stack, the rest join that
 * stack and its front stays — and the grid reloads onto the resulting front.
 */
export function StackAction({ selection, items, album }: Props) {
  const { reportError } = useSelectionBar();
  const [busy, setBusy] = useState(false);

  const handleStack = async () => {
    // One photo alone is not a stack; the button is disabled below two.
    const selected = items.filter((item) => selection.selected.has(item.path));
    reportError(null);
    setBusy(true);
    try {
      const result = await execCommand<{ focusPath: string }>(`album-stack stack ${shq(album)} ${selected.map((item) => shq(item.path)).join(' ')}`);
      selection.clear();
      // The members fold under the front, so the list this selection indexes is about to
      // change shape; the timeline that owns it reloads and keeps the front in view.
      requestAlbumMediaRefresh(album, result.focusPath);
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SelectionActionButton icon={<TablerIcon name='stack-2' size={14} />} onClick={handleStack} disabled={selection.count < 2} loading={busy}>
      Stack
    </SelectionActionButton>
  );
}
