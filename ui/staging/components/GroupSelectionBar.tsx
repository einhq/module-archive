import { SelectionActionButton, TablerIcon } from '@ein/ui/components';
import { ActionBar, Text } from '@mantine/core';

/** An action of the bar, as its button says it. */
type BarAction = { label: string; run: () => void };

type Props = {
  /** What is selected, in words: "3 groups · 412 photos". */
  words: string;
  /** How many groups are selected whole: the bar is for two or more, one has its own card's buttons. */
  groups: number;
  /** Each selected group a new album of its own, under its suggested name. */
  onCreateSuggested: () => void;
  /** With two or more selected whole: merge them into the first, as its label says. */
  merge?: BarAction;
  /**
   * Pictures selected in the open group alone: how many, and where they can go — split off (in a
   * lane, a new group), into the group above or below, or into any group.
   */
  pictures?: { count: number; split?: BarAction; moveUp?: BarAction; moveDown?: BarAction; moveTo: () => void };
  onClear: () => void;
};

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;

/**
 * Actions for what is selected on the Sort tab, floating over the stream as the album page's
 * selection bar does over its grid. With two or more groups selected: Merge and Create suggested
 * albums; one group selected has no bar, as its card has Create and the rest. With pictures of the
 * open group selected: Split the group here (New group in a lane), Move to the group above or
 * below, and Move to a group. The open group's card has the rest: its Create, Add to existing and
 * menu act on its selected pictures too.
 */
export function GroupSelectionBar({ words, groups, onCreateSuggested, merge, pictures, onClear }: Props) {
  return (
    <ActionBar opened={groups > 1 || pictures !== undefined} onClose={onClear} aria-label='Selection actions' shadow='xl' radius='md' bg='var(--mrx-surface-overlay)'>
      <Text size='sm' fw={500} style={{ whiteSpace: 'nowrap' }}>{groups > 0 ? words : photos(pictures?.count ?? 0)} selected</Text>
      <ActionBar.Divider />
      {merge && (
        <SelectionActionButton icon={<TablerIcon name='arrow-merge' size={14} />} onClick={merge.run}>
          {merge.label}
        </SelectionActionButton>
      )}
      {groups > 1 && (
        <SelectionActionButton icon={<TablerIcon name='photo-plus' size={14} />} onClick={onCreateSuggested}>
          Create suggested albums
        </SelectionActionButton>
      )}
      {groups === 0 && pictures && (
        <>
          {pictures.split && (
            <SelectionActionButton icon={<TablerIcon name='scissors' size={14} />} onClick={pictures.split.run}>
              {pictures.split.label}
            </SelectionActionButton>
          )}
          {pictures.moveUp && (
            <SelectionActionButton icon={<TablerIcon name='arrow-bar-to-up' size={14} />} onClick={pictures.moveUp.run}>
              {pictures.moveUp.label}
            </SelectionActionButton>
          )}
          {pictures.moveDown && (
            <SelectionActionButton icon={<TablerIcon name='arrow-bar-to-down' size={14} />} onClick={pictures.moveDown.run}>
              {pictures.moveDown.label}
            </SelectionActionButton>
          )}
          <SelectionActionButton icon={<TablerIcon name='arrows-transfer-up' size={14} />} onClick={pictures.moveTo}>
            Move to a group…
          </SelectionActionButton>
        </>
      )}
    </ActionBar>
  );
}
