import { type RefObject, useCallback, useEffect, useState } from 'react';

/** Safari's presentation modes, its older way to the same window, which an iPhone may have alone. */
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

const standard = (video: HTMLVideoElement): boolean => document.pictureInPictureEnabled && !video.disablePictureInPicture;
const webkit = (video: WebkitVideo): boolean => typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture');

/**
 * The video in a floating window of the system's, over other tabs and apps.
 *
 * `supported` is false where the browser has no such window (Firefox keeps its own toggle on the
 * picture). The window belongs to the element: it closes when the lightbox steps to other media or
 * closes, which removes it.
 */
export function usePictureInPicture(videoRef: RefObject<HTMLVideoElement | null>): { supported: boolean; active: boolean; toggle: () => void } {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current as WebkitVideo | null;
    if (!video) return;
    setSupported(standard(video) || webkit(video));
    const sync = () => setActive(document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture');
    video.addEventListener('enterpictureinpicture', sync);
    video.addEventListener('leavepictureinpicture', sync);
    video.addEventListener('webkitpresentationmodechanged', sync);
    return () => {
      video.removeEventListener('enterpictureinpicture', sync);
      video.removeEventListener('leavepictureinpicture', sync);
      video.removeEventListener('webkitpresentationmodechanged', sync);
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
