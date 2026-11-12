import { bumpDerivativeVersion, shq } from '@ein/ui/lib';
import { execCommand, type MediaItem } from '@ein/ui/signals';

/** `url` asking for the file's own rendition, not the copy it may be shown as. */
const own = (url: string): string => url && `${url}${url.includes('?') ? '&' : '?'}original`;

/**
 * `item` as the picture's own renditions show it. A file can be shown as a restored copy among its
 * versions (its `shown` attr), and its rendition URLs then answer with the copy's; what is
 * compared with the copy, or painted over to be filled from the file, is the file itself.
 */
export const originalOf = (item: MediaItem): MediaItem => ({
  ...item,
  thumbnailUrl: own(item.thumbnailUrl),
  fullUrl: own(item.fullUrl),
  srcSet: item.srcSet && item.srcSet.split(', ').map((entry) => {
    const [url, descriptor] = entry.split(' ');
    return `${own(url)} ${descriptor}`;
  }).join(', '),
});

/**
 * Show the picture at `path` as its version `name` wherever the archive shows it, or as itself
 * again with null; the file and everything read from it stay its own. Its renditions' URLs are
 * busted, since they now answer with other bytes.
 */
export const setShownCopy = async (path: string, name: string | null): Promise<void> => {
  await execCommand(name === null ? `attrs ${shq(path)} -d shown` : `attrs ${shq(path)} -s ${shq(`shown=versions/${name}`)}`);
  bumpDerivativeVersion(path);
};
