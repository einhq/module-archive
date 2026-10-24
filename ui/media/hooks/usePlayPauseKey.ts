import { useEffect, useRef } from 'react';

/** Where a key is somebody's text, or a menu's own selection key. */
const leftAlone = (target: Element): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable) ||
  target.closest('[role="menu"], [role="menuitem"]') !== null;

/**
 * Whether a keydown at `target` is the lightbox's: on the page itself, on the frame around the
 * lightbox, or anywhere in the lightbox but its details, whose own buttons and transcript cues keep
 * their Space.
 *
 * The frame counts because a click on the picture, which nothing in the lightbox takes the focus
 * for, puts the focus on the nearest focusable ancestor: the full-screen surface's dialog.
 */
const inLightbox = (target: EventTarget | null): boolean => {
  if (target === document.body || target === document.documentElement) return true;
  if (!(target instanceof Element) || leftAlone(target)) return false;
  if (target.querySelector('[data-lightbox-media-path]') !== null) return true;
  return target.closest('[data-lightbox-media-path]') !== null && target.closest('[data-media-sidebar]') === null;
};

/**
 * Space and `k` play and pause the lightbox's recording, wherever the focus is in the lightbox.
 *
 * Taken from the lightbox's buttons too: the fullscreen surface's focus trap puts the focus on its
 * first button as it opens, which on a desktop is Close, and a Space left to that button would
 * close the lightbox instead of starting the video. The keyup is cancelled with the keydown, because
 * a button fires its click on Space's keyup.
 *
 * Off (`enabled` false) while a dialog of the lightbox's has the keys.
 */
export function usePlayPauseKey(toggle: () => void, enabled = true): void {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    if (!enabled) return;
    let held: string | null = null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.code !== 'Space' && event.key !== 'k') return;
      if (!inLightbox(event.target)) return;
      event.preventDefault();
      held = event.code;
      // Held down, the key repeats; one press is one toggle.
      if (!event.repeat) toggleRef.current();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (held === null || event.code !== held) return;
      held = null;
      event.preventDefault();
    };

    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
    };
  }, [enabled]);
}
