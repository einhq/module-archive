import { Center, Image } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { type MouseEvent, useEffect, useState } from 'react';
import { bust, fileUrl, versionOf } from '@ein/ui/lib';
import { FACE_CROP_NAME } from '../lib/face-crop.ts';

type Props = {
  /** The face region; its crop is the child `image.avif`. Empty shows the fallback. */
  facePath: string;
  size: number;
  alt: string;
  /**
   * Makes the crop clickable — opening the photo it was cut from, or, where the
   * caller can pick faces, toggling this one. The event comes with it so a
   * caller can read `shiftKey` for a range.
   */
  onClick?: (event: MouseEvent) => void;
  /** Ringed as picked. The caller owns the selection; this only shows it. */
  selected?: boolean;
  title?: string;
  /**
   * Defer the fetch until the crop is scrolled into view.
   *
   * For a caller that renders many groups at once — the split dialog puts up to
   * thirty on screen — eager loading is hundreds of requests for crops nobody
   * has scrolled to yet, and the ones that matter arrive last.
   */
  lazy?: boolean;
};

/**
 * One face crop, falling back to an icon when the crop was never made or was evicted.
 *
 * The fallback is not defensive padding: `detect-faces` only crops when the image has known
 * dimensions, crops live in the volatile storage tier and can be evicted, and some faces'
 * crops are stored under a name other than this one. A missing crop is normal.
 */
export function FaceCrop({ facePath, size, alt, onClick, title, lazy, selected }: Props) {
  const [failed, setFailed] = useState(false);
  const versionedSrc = facePath ? bust(`${fileUrl(facePath)}/${FACE_CROP_NAME}`, versionOf(facePath)) : '';

  useEffect(() => setFailed(false), [versionedSrc]);

  const shared = {
    className: 'mrx-face-crop',
    'data-selected': selected || undefined,
    title,
    onClick,
    w: size,
    h: size,
    style: onClick ? { cursor: 'pointer' } : undefined,
  };

  if (failed || !versionedSrc) {
    return (
      <Center
        {...shared}
        style={{ ...shared.style, borderRadius: size / 2, background: 'var(--mrx-surface-overlay)' }}
      >
        <TablerIcon name='user-question' size={size / 2} />
      </Center>
    );
  }

  return (
    <Image
      {...shared}
      src={versionedSrc}
      radius={size / 2}
      fit='cover'
      alt={alt}
      loading={lazy ? 'lazy' : undefined}
      onError={() => setFailed(true)}
    />
  );
}
