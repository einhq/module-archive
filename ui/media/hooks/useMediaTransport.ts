import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { attachPlayback, publishPosition } from '../signals/playback.ts';
import { clampTime, progressOf } from '../lib/transport.ts';

type TransportOptions = {
  /** The length from the file's metadata, until the element has measured its own. */
  fallbackDuration?: number;
  /** A second to start at once the length is known: a search hit partway into the recording. */
  startAt?: number;
  /** Start playing on mount, as the lightbox does when a recording opens. */
  autoPlay?: boolean;
  /**
   * A drag on the timeline moves only the playhead and seeks once, where it is let go: for a
   * player that shows the frame under the finger from elsewhere (a storyboard), so a seek per move
   * would decode frames nobody sees.
   */
  seekOnRelease?: boolean;
  onEnded?: () => void;
  /** It started, or started again: a `play()` the browser accepted. */
  onPlay?: () => void;
  /** The browser would not start playing without a gesture (an autoplay policy). */
  onRefused?: () => void;
};

/** What a player's controls drive, from one `<audio>` or `<video>`. */
export type MediaTransport = {
  playing: boolean;
  /** The playhead in seconds, at `timeupdate`'s rate; the timeline itself moves every frame (`progressRef`). */
  position: number;
  duration: number;
  /** Waiting for data: a stall while playing, or a seek that has not landed. */
  buffering: boolean;
  scrubbing: boolean;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (delta: number) => void;
  startScrub: (seconds: number) => void;
  moveScrub: (seconds: number) => void;
  endScrub: () => void;
  /** A callback ref for the timeline, whose `--progress` (0–1) this keeps on the playhead. */
  progressRef: (el: HTMLElement | null) => void;
};

/**
 * The lightbox's media transport: play, seek and scrub one media element, and keep the timeline,
 * the clock and the transcript panel on its playhead.
 *
 * The timeline is moved through a CSS variable on every animation frame while playing, never
 * through React state: `timeupdate` fires about four times a second, which reads as a stuttering
 * playhead, and a render per frame would redraw the whole player. The position in state is for the
 * clock and the slider's ARIA value, which need no better.
 *
 * A drag on the timeline pauses, seeks as fast as the element can follow — or only once, at the
 * end, with `seekOnRelease` — and plays on from where it is let go. Seeks are coalesced: the next
 * is issued only once the last has landed, because each one decodes from the keyframe before it
 * and a seek per pointer move only queues work.
 *
 * It publishes the playhead and a seek for the transcript panel (`signals/playback.ts`) for as long
 * as it is mounted.
 */
export function useMediaTransport(elRef: RefObject<HTMLMediaElement | null>, options: TransportOptions): MediaTransport {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  // The element's own length once it has one: a rendition can differ from the source's
  // metadata by a frame or two.
  const [loadedDuration, setLoadedDuration] = useState<number | undefined>(undefined);
  const [buffering, setBuffering] = useState(false);
  // While a drag holds the timeline: whether to play on when it ends. Kept in a ref as well, for
  // the element's event handlers.
  const [scrubbing, setScrubbing] = useState<{ resume: boolean } | null>(null);
  const duration = loadedDuration ?? options.fallbackDuration ?? 0;

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const progressElRef = useRef<HTMLElement | null>(null);
  const scrubRef = useRef<{ resume: boolean } | null>(null);
  // The latest drag position not yet asked of the element, because a seek is still running or
  // because the drag seeks only where it ends.
  const pendingSeekRef = useRef<number | null>(null);

  const lengthOf = useCallback((el: HTMLMediaElement | null): number => {
    if (el && Number.isFinite(el.duration) && el.duration > 0) return el.duration;
    return optionsRef.current.fallbackDuration ?? 0;
  }, []);

  const paint = useCallback((seconds: number) => {
    progressElRef.current?.style.setProperty('--progress', String(progressOf(seconds, lengthOf(elRef.current))));
  }, [elRef, lengthOf]);

  const progressRef = useCallback((el: HTMLElement | null) => {
    progressElRef.current = el;
    if (el) paint(elRef.current?.currentTime ?? 0);
  }, [elRef, paint]);

  const play = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    el.play().catch((error: unknown) => {
      // An AbortError is a play() overtaken by a pause or a new source, which is no refusal.
      if (error instanceof DOMException && error.name === 'NotAllowedError') optionsRef.current.onRefused?.();
    });
    // `paused` turns false at once; the `play` event that says so comes a task later, and a frame
    // drawn in between would show the play button over a video that has started.
    if (!el.paused) setPlaying(true);
  }, [elRef]);

  const toggle = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (el.paused) play();
    else el.pause();
  }, [elRef, play]);

  const seek = useCallback((seconds: number) => {
    const el = elRef.current;
    if (!el) return;
    // Clamped against the element's length only once it has one: before metadata, assigning
    // past the end of a stream that has not been measured leaves it stuck rather than seeking.
    const bounded = clampTime(seconds, el.duration);
    el.currentTime = bounded;
    setPosition(bounded);
    paint(bounded);
  }, [elRef, paint]);

  const skip = useCallback((delta: number) => {
    const el = elRef.current;
    if (el) seek(el.currentTime + delta);
  }, [elRef, seek]);

  const requestSeek = useCallback((seconds: number) => {
    const el = elRef.current;
    if (!el) return;
    if (el.seeking) {
      pendingSeekRef.current = seconds;
      return;
    }
    pendingSeekRef.current = null;
    el.currentTime = seconds;
  }, [elRef]);

  const moveScrub = useCallback((seconds: number) => {
    const bounded = clampTime(seconds, lengthOf(elRef.current));
    setPosition(bounded);
    paint(bounded);
    if (optionsRef.current.seekOnRelease) pendingSeekRef.current = bounded;
    else requestSeek(bounded);
  }, [elRef, lengthOf, paint, requestSeek]);

  const startScrub = useCallback((seconds: number) => {
    const el = elRef.current;
    if (!el) return;
    const scrub = { resume: !el.paused };
    scrubRef.current = scrub;
    if (!el.paused) el.pause();
    setScrubbing(scrub);
    moveScrub(seconds);
  }, [elRef, moveScrub]);

  const endScrub = useCallback(() => {
    const scrub = scrubRef.current;
    if (!scrub) return;
    scrubRef.current = null;
    setScrubbing(null);
    const el = elRef.current;
    if (!el) return;
    const pending = pendingSeekRef.current;
    pendingSeekRef.current = null;
    if (pending !== null) el.currentTime = pending;
    // Let go at the very end, it stays there: play() on an ended element starts it over from 0:00.
    const target = pending ?? el.currentTime;
    if (scrub.resume && target < lengthOf(el) - 0.05) play();
  }, [elRef, lengthOf, play]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const onPlay = () => {
      setPlaying(true);
      optionsRef.current.onPlay?.();
    };
    const onPause = () => setPlaying(false);
    const onTime = () => {
      publishPosition(el.currentTime);
      if (scrubRef.current) return;
      setPosition(el.currentTime);
      paint(el.currentTime);
    };
    const onSeeked = () => {
      const pending = pendingSeekRef.current;
      if (pending !== null) {
        pendingSeekRef.current = null;
        el.currentTime = pending;
        return;
      }
      setBuffering(false);
      onTime();
    };
    const onWaiting = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onLength = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setLoadedDuration(el.duration);
      paint(el.currentTime);
    };
    const onMetadata = () => {
      onLength();
      // Only on metadata, because a seek before the length is known does not take.
      const start = optionsRef.current.startAt;
      if (start !== undefined && start > 0) seek(start);
    };
    const onEnded = () => {
      setPlaying(false);
      optionsRef.current.onEnded?.();
    };

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('seeking', onWaiting);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('playing', onReady);
    el.addEventListener('canplay', onReady);
    el.addEventListener('durationchange', onLength);
    el.addEventListener('loadedmetadata', onMetadata);
    el.addEventListener('ended', onEnded);
    // A cached file can have its metadata before this effect runs.
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) onMetadata();
    if (!el.paused) setPlaying(true);

    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('seeking', onWaiting);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('playing', onReady);
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('durationchange', onLength);
      el.removeEventListener('loadedmetadata', onMetadata);
      el.removeEventListener('ended', onEnded);
    };
  }, [elRef, paint, seek]);

  // Before the first paint, so a recording that starts at once is never drawn paused.
  useLayoutEffect(() => {
    if (optionsRef.current.autoPlay) play();
  }, [play]);

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      const el = elRef.current;
      if (el && !scrubRef.current) paint(el.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [elRef, paint, playing]);

  // Cleared on unmount, so a transcript panel outliving the player cannot seek an element
  // that is gone.
  useEffect(() =>
    attachPlayback((seconds) => {
      seek(seconds);
      play();
    }), [play, seek]);

  return {
    // A drag pauses underneath; the controls keep showing what it will go back to.
    playing: playing || scrubbing?.resume === true,
    position,
    duration,
    buffering,
    scrubbing: scrubbing !== null,
    toggle,
    seek,
    skip,
    startScrub,
    moveScrub,
    endScrub,
    progressRef,
  };
}
