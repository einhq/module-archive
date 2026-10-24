import { type RefObject, useCallback, useEffect, useState } from 'react';

/** Where a picture is drawn, in its element's offset parent. */
type ContentRect = { left: number; top: number; width: number; height: number };

/** Intrinsic size of whichever element is showing, or null before it has loaded. */
const intrinsicSize = (el: HTMLImageElement | HTMLVideoElement): { width: number; height: number } | null => {
  const width = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const height = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  return width > 0 && height > 0 ? { width, height } : null;
};

/** Where `object-fit: contain` actually puts the picture inside its element. */
const containedRect = (el: HTMLImageElement | HTMLVideoElement): ContentRect | null => {
  const intrinsic = intrinsicSize(el);
  if (!intrinsic) return null;

  const boxWidth = el.clientWidth;
  const boxHeight = el.clientHeight;
  if (boxWidth === 0 || boxHeight === 0) return null;

  const scale = Math.min(boxWidth / intrinsic.width, boxHeight / intrinsic.height);
  const width = intrinsic.width * scale;
  const height = intrinsic.height * scale;

  return { left: el.offsetLeft + (boxWidth - width) / 2, top: el.offsetTop + (boxHeight - height) / 2, width, height };
};

/**
 * Tracks the rendered content rect of a contained image or video.
 *
 * Three things move it: the media finishing loading (intrinsic size arrives late), the element
 * resizing, and the window resizing. A ResizeObserver covers the first two — it fires on the
 * initial observe too — and the load listeners cover a source swap that keeps the same box.
 */
export function useContentRect(mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>): ContentRect | null {
  const [rect, setRect] = useState<ContentRect | null>(null);

  const measure = useCallback(() => {
    const el = mediaRef.current;
    setRect(el ? containedRect(el) : null);
  }, [mediaRef]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('load', measure);
    el.addEventListener('loadedmetadata', measure);
    globalThis.addEventListener('resize', measure);

    return () => {
      observer.disconnect();
      el.removeEventListener('load', measure);
      el.removeEventListener('loadedmetadata', measure);
      globalThis.removeEventListener('resize', measure);
    };
  }, [mediaRef, measure]);

  return rect;
}
