import { shq } from '@ein/ui/lib';

/** Open the terminal on the media node itself; every VFS node is cd-addressable. */
export const mediaTerminalCommand = (path: string): string => `cd ${shq(path)}`;
