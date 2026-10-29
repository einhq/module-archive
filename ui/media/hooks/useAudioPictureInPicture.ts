import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Chromium's Document Picture-in-Picture: a small window of the page's own, over other tabs and apps. */
type DocumentPictureInPicture = { requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>; window: Window | null };

const documentPip = (): DocumentPictureInPicture | undefined => (globalThis as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;

/** The window's size: room for the waveform, the name and the browser's audio controls. */
const WINDOW = { width: 400, height: 170 };

/** The window's page: the recording's waveform and name over the element, with the browser's controls. */
function furnish(pip: Window, name: string, waveform: string): void {
  const doc = pip.document;
  doc.title = name;
  const style = doc.createElement('style');
  style.textContent = `
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; justify-content: flex-end; gap: 8px;
      padding: 12px; box-sizing: border-box; background: #101113 center 30% / 100% 55% no-repeat; color: #c9c9c9;
      font: 13px system-ui, sans-serif; }
    p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    audio { width: 100%; color-scheme: dark; }
  `;
  doc.head.append(style);
  doc.body.style.backgroundImage = `linear-gradient(rgba(16, 17, 19, 0.5), rgba(16, 17, 19, 0.5)), url("${new URL(waveform, location.href)}")`;
  const label = doc.createElement('p');
  label.textContent = name;
  doc.body.append(label);
}

/**
 * The recording in a floating window, over other tabs and apps: `usePictureInPicture`'s answer for
 * audio, whose element the system's picture-in-picture does not take.
 *
 * The window is a page of the document's own (Document Picture-in-Picture, Chromium only, so
 * `supported` is false elsewhere), and the `<audio>` element itself moves into it, with the
 * browser's controls on: it keeps playing there, and the player, still holding the element, follows
 * it. The element moves out of `homeRef`, a box of its own that React puts nothing else in. Closing
 * the window brings it back, or, once the player is gone — the lightbox stepping on, or closing —
 * stops it: the recording plays on in the window while the album is browsed, as a floating video does.
 */
export function useAudioPictureInPicture(
  audioRef: RefObject<HTMLAudioElement | null>,
  homeRef: RefObject<HTMLElement | null>,
  { name, waveform }: { name: string; waveform: string },
): { supported: boolean; active: boolean; toggle: () => void } {
  const supported = documentPip() !== undefined;
  const [active, setActive] = useState(false);
  const windowRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggle = useCallback(() => {
    if (windowRef.current) {
      windowRef.current.close();
      return;
    }
    const api = documentPip();
    const audio = audioRef.current;
    if (!api || !audio) return;
    // Refused without a gesture, or while another window is open: nothing to undo.
    api.requestWindow(WINDOW).then((pip) => {
      windowRef.current = pip;
      furnish(pip, name, waveform);
      const playing = !audio.paused;
      audio.controls = true;
      pip.document.body.append(audio);
      // A move removes the element first, which may pause it.
      if (playing && audio.paused) void audio.play().catch(() => undefined);
      setActive(true);
      pip.addEventListener('pagehide', () => {
        windowRef.current = null;
        audio.controls = false;
        const home = homeRef.current;
        if (mountedRef.current && home) {
          const resume = !audio.paused;
          home.append(audio);
          if (resume && audio.paused) void audio.play().catch(() => undefined);
          setActive(false);
        } else {
          audio.pause();
          audio.remove();
        }
      }, { once: true });
    }, () => undefined);
  }, [audioRef, homeRef, name, waveform]);

  return { supported, active, toggle };
}
