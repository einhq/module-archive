import { SelectionBarContext, type SelectionBarContextValue } from '@ein/ui/components';
import { notify } from '@ein/ui/signals';
import { AddToAlbumAction } from './AddToAlbumAction.tsx';

/** The selection bar's actions as menu rows, an error as a toast: what a one-picture menu needs. */
const MENU_CONTEXT: SelectionBarContextValue = {
  layout: 'menu',
  reportError: (message) => {
    if (message) notify({ message, color: 'red' });
  },
};

/**
 * What the selection bar does to many pictures that the lightbox's sidebar does to the one it
 * shows: add it to an album. Its description, labels and location are the sidebar's edit dialog's.
 * Rows of the menu they are put in, which must stay
 * mounted (`keepMounted`) so their dialogs outlive the menu closing on the click that opened them,
 * and hidden by `display: none` (`keepMountedMode`): Mantine's default `<Activity>` would hold back
 * every update to a dialog while the menu is shut, so it could be neither typed in nor closed.
 */
export function LightboxActionItems({ path, iconSize }: { path: string; iconSize?: number }) {
  return (
    <SelectionBarContext.Provider value={MENU_CONTEXT}>
      <AddToAlbumAction paths={[path]} iconSize={iconSize} />
    </SelectionBarContext.Provider>
  );
}
