import { type RefObject, useCallback, useEffect, useState } from 'react';

/**
 * The video on another screen, through the browser's Remote Playback API: Cast in Chrome, AirPlay
 * in Safari, the same as the browser's own controls offer.
 *
 * `available` is true only while the browser reports a screen it can send this video to, so the
 * button is never there with nothing behind it; a browser that cannot watch for screens, or has no
 * such API (Firefox), offers none. `connected` holds while the other screen plays it; the
 * element's own events go on reporting its state, so the controls drive it as before.
 */
export function useCast(videoRef: RefObject<HTMLVideoElement | null>): { available: boolean; connected: boolean; prompt: () => void } {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<RemotePlaybackState>('disconnected');

  useEffect(() => {
    const remote = videoRef.current?.remote;
    if (!remote) return;
    let id: number | null = null;
    let live = true;
    remote.watchAvailability(setAvailable).then((watch) => {
      if (live) id = watch;
      else void remote.cancelWatchAvailability(watch).catch(() => undefined);
    }, () => setAvailable(false));
    const sync = () => setState(remote.state);
    sync();
    remote.addEventListener('connecting', sync);
    remote.addEventListener('connect', sync);
    remote.addEventListener('disconnect', sync);
    return () => {
      live = false;
      if (id !== null) void remote.cancelWatchAvailability(id).catch(() => undefined);
      remote.removeEventListener('connecting', sync);
      remote.removeEventListener('connect', sync);
      remote.removeEventListener('disconnect', sync);
    };
  }, [videoRef]);

  // The browser's own picker; once connected it offers to stop. Dismissing it rejects.
  const prompt = useCallback(() => {
    void videoRef.current?.remote.prompt().catch(() => undefined);
  }, [videoRef]);

  return { available: available || state !== 'disconnected', connected: state === 'connected', prompt };
}
