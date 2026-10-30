import { SelectionActionButton, TablerIcon, useSelectionBar } from '@ein/ui/components';
import { useState } from 'react';
import { execCommand, MediaItem } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { MediaSelection } from '@ein/ui/hooks';
import type { FaceConfirmResult } from '@archive/media/api';

type Props = {
  selection: MediaSelection;
  /** The region crops, in grid order; each path is `<region>/image.avif`. */
  items: MediaItem[];
  person: { name: string };
  /** The regions confirmed, once they are. */
  onApplied: (facePaths: string[]) => void;
};

/**
 * Say the selected faces are this person after all (`face-confirm`): the answer to a doubt that
 * turned out wrong, whoever raised it. They stay, as a human's assignment, and no audit questions them again.
 */
export function ConfirmFacesAction({ selection, items, person, onApplied }: Props) {
  const { reportError } = useSelectionBar();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    const facePaths = items.filter((item) => selection.selected.has(item.path)).map((item) => item.path.replace(/\/[^/]+$/, ''));
    if (facePaths.length === 0) return;
    reportError(null);
    setBusy(true);
    try {
      const result = await execCommand<FaceConfirmResult>(`face-confirm ${facePaths.map(shq).join(' ')}`);
      selection.clear();
      onApplied(result.confirmed);
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SelectionActionButton icon={<TablerIcon name='user-check' size={14} />} onClick={confirm} loading={busy} color='teal'>
      Is {person.name}
    </SelectionActionButton>
  );
}
