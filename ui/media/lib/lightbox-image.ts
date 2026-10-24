import type { MediaItem } from '@ein/ui/signals';
import { bust, bustSrcSet, displayDims, displayUrl, fileUrl, imageSrcSet } from '@ein/ui/lib';

type LightboxPhoto = Pick<MediaItem, 'path' | 'fullUrl' | 'srcSet'>;

type LightboxPhotoSource = {
  src: string;
  srcSet?: string;
};

/**
 * The photo sources a lightbox should try, in order.
 *
 * A search result cannot prove which rendition files exist, so it optimistically carries
 * the display ladder. If any candidate in that ladder 404s, the browser does not retry the
 * `<img>`'s `src`; the caller must remove the whole `srcset` and explicitly load the original.
 */
export function lightboxPhotoSources(
  media: LightboxPhoto,
  version: number,
): { primary: LightboxPhotoSource; fallback?: LightboxPhotoSource } {
  const srcSet = bustSrcSet(media.srcSet, version);
  const primary: LightboxPhotoSource = {
    src: bust(media.fullUrl, version),
    ...(srcSet ? { srcSet } : {}),
  };
  const fallback = { src: bust(fileUrl(media.path), version) };

  // An item whose source already is the original has nowhere else to go. A srcset still
  // needs a fallback even in that case, because dropping it is what makes `src` effective.
  return primary.src !== fallback.src || primary.srcSet ? { primary, fallback } : { primary };
}

/**
 * `item` standing at `angle`. A quarter turn swaps the picture's axes, and the display rendition
 * and the `srcset` widths are chosen from that shape, so they are rebuilt with it.
 */
export function itemAtAngle(item: MediaItem, angle: number): MediaItem {
  const turned = { ...item, angle };
  const dims = displayDims(turned);
  return {
    ...turned,
    fullUrl: displayUrl(item.path, item.type, item.hasDerivatives, dims),
    srcSet: imageSrcSet(item.path, item.type, item.hasDerivatives, dims),
  };
}
