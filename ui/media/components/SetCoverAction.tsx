import { useState } from 'react';
import { execCommand, MediaItem } from '@ein/ui/signals';
import { forgetAlbumCover, forgetCover, MediaSelection } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { SelectionActionButton, TablerIcon, useSelectionBar } from '@ein/ui/components';

type Props = {
  selection: MediaSelection;
  /** Everything loaded, in list order. The selection is read out of this. */
  items: MediaItem[];
  /** Node that owns the `coverPhoto` softlink — the page being viewed. */
  owner: string;
};

/**
 * Make the one selected picture an entity's cover.
 *
 * Self-contained like `StackAction`: an entity page adds it to `MediaSelectionBar`'s `actions`
 * slot. A cover is one picture, so the button is enabled for exactly one selected item. Covers
 * are the same `coverPhoto` softlink for albums, people and locations; link the media file itself,
 * never a softlink filing it in a grid.
 */
export function SetCoverAction({ selection, items, owner }: Props) {
  const { reportError } = useSelectionBar();
  const [busy, setBusy] = useState(false);

  const handleSetCover = async () => {
    const selected = items.find((item) => selection.selected.has(item.path));
    if (!selected) return;
    reportError(null);
    setBusy(true);
    try {
      await execCommand(`ln -s -f ${shq(selected.path)} ${shq(`${owner}/coverPhoto`)}`);
      // The header avatar on this page and a cached album card must refetch in place.
      forgetCover(owner);
      forgetAlbumCover(owner);
      selection.clear();
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SelectionActionButton icon={<TablerIcon name='photo-star' size={14} />} onClick={handleSetCover} disabled={selection.count !== 1} loading={busy}>
      Set as cover
    </SelectionActionButton>
  );
}
