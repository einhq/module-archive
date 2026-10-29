import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersistedState } from '@ein/ui/hooks';
import { parseVolume } from '../lib/player-settings.ts';

/**
 * Whether a page can set the volume: an iPhone's or iPad's Safari leaves it to the device's own
 * buttons, ignores the assignment and always reads 1.
 */
const volumeSettable = (): boolean => {
  const probe = document.createElement('audio');
  probe.volume = 0.5;
  return probe.volume === 0.5;
};

/**
 * The lightbox players' sound: the volume and mute of the element in `ref`, as the element reports
 * them, and the two ways to change them. The volume is remembered across files and visits, shared
 * by the video and audio players; `canSetVolume` is false where only the device's buttons can.
 */
export function useVolume(ref: RefObject<HTMLMediaElement | null>) {
  const [storedVolume, setStoredVolume] = usePersistedState<string>('lightbox.volume', '1');
  const initialVolumeRef = useRef(parseVolume(storedVolume));
  const [volume, setVolume] = useState(initialVolumeRef.current);
  const [muted, setMuted] = useState(false);
  const canSetVolume = useMemo(volumeSettable, []);

  const toggleMute = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    // Dragged down to nothing, unmuting would still be silent.
    if (element.muted && element.volume === 0) element.volume = 1;
    element.muted = !element.muted;
  }, [ref]);

  const changeVolume = useCallback((value: number) => {
    const element = ref.current;
    if (!element) return;
    element.volume = value;
    element.muted = value === 0;
    // Silence is a mute, not a volume for the next file to open with.
    if (value > 0) setStoredVolume(String(value));
  }, [ref, setStoredVolume]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (canSetVolume) element.volume = initialVolumeRef.current;
    const onVolume = () => {
      setMuted(element.muted);
      setVolume(element.volume);
    };
    element.addEventListener('volumechange', onVolume);
    return () => element.removeEventListener('volumechange', onVolume);
  }, [ref, canSetVolume]);

  return { volume, muted, canSetVolume, toggleMute, changeVolume };
}
