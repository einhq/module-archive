import { signal } from '@preact/signals-react';

/**
 * Where the lightbox's current audio or video is, and how to move it.
 *
 * Module-level signals rather than props: the transcript panel
 * lives in `MediaSidebar`, which `MediaLightbox` mounts twice — once as the mobile bottom
 * sheet and once as the desktop rail. Threading a playhead and a seek callback through both
 * is how the two copies drift apart, and only one of them is ever on screen.
 *
 * Whichever player is mounted owns these and clears them on unmount, so a panel left behind
 * by a closed lightbox cannot seek an element that is gone.
 */

/** Playhead of the media currently playing, in seconds, quantised — see `publishPosition`. */
export const playbackPosition = signal(0);

/**
 * Resolution the playhead is published at, in seconds.
 *
 * Every subscriber re-renders on each write, and the transcript panel is a list that can run to
 * hundreds of cues. Nothing subscribed here needs better than cue-level resolution, so a write
 * lands only when the playhead enters a new slot, whatever rate the player publishes at.
 */
const POSITION_RESOLUTION = 0.25;

/** Publish a playhead, skipping the write when it lands in the same slot as the last one. */
export const publishPosition = (seconds: number): void => {
  const quantised = Math.floor(seconds / POSITION_RESOLUTION) * POSITION_RESOLUTION;
  if (playbackPosition.peek() !== quantised) playbackPosition.value = quantised;
};

/**
 * Seek the current media. Null when nothing is playing, which is also what makes the
 * transcript read-only for a photo or a file whose player failed to load.
 */
export const playbackSeek = signal<((seconds: number) => void) | null>(null);

/** Called by a player as it mounts. Returns the teardown, so an effect can just return it. */
export const attachPlayback = (seek: (seconds: number) => void): () => void => {
  playbackSeek.value = seek;
  playbackPosition.value = 0;
  return () => {
    playbackSeek.value = null;
    playbackPosition.value = 0;
  };
};
