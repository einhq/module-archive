import { useSignals } from '@preact/signals-react/runtime';
import { type RefObject, useEffect } from 'react';
import { castInstead, followNearby, type MediaItem, nearbyPlayback, nearbyScreen, pauseNearby, setNearbyCaptions } from '@ein/ui/signals';

/** A player's part in a screen near the browser. */
type NearbyPlayback = {
  /** A screen near the browser plays something: nothing starts by itself. */
  casting: boolean;
  /** The screen plays this file: the player plays in step with it, muted, and its controls are the screen's (`useNearbyCaptions` its captions too). */
  here: boolean;
  /** The screen plays this file but waits for more, as after a move: the player shows it loading, and stands meanwhile. */
  waiting: boolean;
  /** Play while the screen plays something else: the screen is given this file instead. */
  castHere: () => void;
  /** Pause the screen while it waits, when the player's own element stands already and its pause would tell the screen nothing. */
  pauseWaiting: () => void;
};

/**
 * A recording's or video's player beside a screen near the browser (core's `nearbyScreen`). While
 * the screen plays this file, the player's own element plays in step with it, muted, and its play,
 * pause and moves go to the screen (`followNearby`); while it plays anything else, play gives the
 * screen this file (`castInstead`).
 */
export function useNearbyPlayback(media: MediaItem, own: RefObject<HTMLMediaElement | null>): NearbyPlayback {
  useSignals();
  const screen = nearbyScreen.value;
  const here = screen?.target.path === media.path;
  const playback = nearbyPlayback.value;
  useEffect(() => {
    const element = own.current;
    if (!here || !element) return;
    return followNearby(element, media.path);
  }, [here, media.path, own]);
  return {
    casting: screen !== null,
    here,
    waiting: here && playback.waiting === true && !playback.paused,
    castHere: () => void castInstead({ path: media.path, title: media.name }),
    pauseWaiting: pauseNearby,
  };
}

/**
 * While the screen near the browser plays the player's file with its transcript known (`here`), it
 * shows the captions when the player does (`on`): before the transcript is known the player shows
 * none, which would turn the screen's off for a moment.
 */
export function useNearbyCaptions(here: boolean, on: boolean): void {
  useEffect(() => {
    if (here) setNearbyCaptions(on);
  }, [here, on]);
}
