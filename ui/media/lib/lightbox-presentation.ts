import { shq } from '@ein/ui/lib';

/** Open the terminal on the media node itself; every VFS node is cd-addressable. */
export const mediaTerminalCommand = (path: string): string => `cd ${shq(path)}`;

/** A menu's rows sized for a thumb, like the phone's lightbox bar: its icons are `THUMB_MENU_ICON_PX`. */
export const THUMB_MENU_STYLES = { item: { fontSize: 'var(--mantine-font-size-lg)', padding: '14px 18px' }, itemSection: { marginRight: 14 } };
export const THUMB_MENU_ICON_PX = 24;
