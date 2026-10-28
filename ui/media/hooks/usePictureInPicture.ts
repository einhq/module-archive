import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react';

/** Safari's presentation modes, its older way to the same window, which an iPhone may have alone. */
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

const standard = (video: HTMLVideoElement): boolean => document.pictureInPictureEnabled && !video.disablePictureInPicture;
const webkit = (video: WebkitVideo): boolean => typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture');
const floating = (video: WebkitVideo): boolean => document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';

/** `moveBefore`, which moves an element without removing it on the way; not in every browser yet. */
type MovingParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

let host: MovingParent | null = null;

/**
 * Keep a floating video in the document after its player is gone: moved into a host of its own on
 * `document.body`, out of sight and outside the lightbox, and let go when its window closes.
 * Removed with the player, it is out of the page's reach: a browser may close the window with it,
 * and Chromium, which keeps the window, leaves the video playing unseen once the window is closed.
 */
function keepFloating(video: WebkitVideo): void {
  if (!host) {
    host = document.createElement('div');
    host.dataset.pictureInPictureHost = '';
    host.setAttribute('aria-hidden', 'true');
    // Not `display: none`: a video that is not rendered may be paused as a background one.
    host.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    document.body.append(host);
  }
  const playing = !video.paused;
  if (host.moveBefore) host.moveBefore(video, null);
  else host.append(video);
  // A plain move removes the element first, which may pause it.
  if (playing && video.paused) void video.play().catch(() => undefined);
  const release = () => {
    if (floating(video)) return;
    video.removeEventListener('leavepictureinpicture', release);
    video.removeEventListener('webkitpresentationmodechanged', release);
    video.pause();
    video.remove();
  };
  video.addEventListener('leavepictureinpicture', release);
  video.addEventListener('webkitpresentationmodechanged', release);
}

/**
 * The video in a floating window of the system's, over other tabs and apps.
 *
 * `supported` is false where the browser has no such window (Firefox keeps its own toggle on the
 * picture). The window belongs to the element, so a player that unmounts while its video floats —
 * the lightbox stepping to other media, or closing — hands the element to `keepFloating` and the
 * video plays on in the window while the album is browsed.
 */
export function usePictureInPicture(videoRef: RefObject<HTMLVideoElement | null>): { supported: boolean; active: boolean; toggle: () => void } {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current as WebkitVideo | null;
    if (!video) return;
    setSupported(standard(video) || webkit(video));
    const sync = () => setActive(floating(video));
    video.addEventListener('enterpictureinpicture', sync);
    video.addEventListener('leavepictureinpicture', sync);
    video.addEventListener('webkitpresentationmodechanged', sync);
    return () => {
      video.removeEventListener('enterpictureinpicture', sync);
      video.removeEventListener('leavepictureinpicture', sync);
      video.removeEventListener('webkitpresentationmodechanged', sync);
    };
  }, [videoRef]);

  // A layout effect's cleanup runs before React removes the player's elements, while the video is
  // still in the document.
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return () => {
      if (floating(video)) keepFloating(video);
    };
  }, [videoRef]);

  const toggle = useCallback(() => {
    const video = videoRef.current as WebkitVideo | null;
    if (!video) return;
    if (standard(video)) {
      // Refused before the video has its metadata, or without a gesture: nothing to undo.
      const request = document.pictureInPictureElement === video ? document.exitPictureInPicture() : video.requestPictureInPicture();
      void request.catch(() => undefined);
      return;
    }
    if (webkit(video)) video.webkitSetPresentationMode?.(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
  }, [videoRef]);

  return { supported, active, toggle };
}
