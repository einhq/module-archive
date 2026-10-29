import { type RefObject, useCallback, useEffect, useState } from 'react';

/**
 * The player alone in fullscreen: the element in `ref`, with its own controls and subtitles, and
 * none of the lightbox around it — the lightbox's menu has the fullscreen of the whole page.
 *
 * `fullscreen` is whether this element is the one in fullscreen. A player that goes while it is,
 * the lightbox stepping on, takes the fullscreen with it, as the browser ends one whose element
 * leaves the document.
 */
export function usePlayerFullscreen(ref: RefObject<HTMLElement | null>): { fullscreen: boolean; toggle: () => void } {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => setFullscreen(ref.current !== null && document.fullscreenElement === ref.current);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [ref]);

  const toggle = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // Refused without a gesture or by policy: nothing to undo.
    if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
    else void element.requestFullscreen?.().catch(() => undefined);
  }, [ref]);

  return { fullscreen, toggle };
}
