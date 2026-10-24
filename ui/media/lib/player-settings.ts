/**
 * The video player's speed and volume: the steps they move in and what they read as.
 *
 * Pure, so it is tested without a browser.
 */

/** The speeds the menu offers and `<`/`>` step through. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** A speed as the controls write it: `1×`, `0.75×`. */
export const rateLabel = (rate: number): string => `${rate}×`;

/** The speed one step slower (`-1`) or faster (`1`) than `rate`, held at the ends of the list. */
export const stepRate = (rate: number, direction: -1 | 1): number => {
  if (direction > 0) return PLAYBACK_RATES.find((step) => step > rate + 1e-9) ?? PLAYBACK_RATES[PLAYBACK_RATES.length - 1];
  return [...PLAYBACK_RATES].reverse().find((step) => step < rate - 1e-9) ?? PLAYBACK_RATES[0];
};

/** What an arrow key moves the volume by while its slider has focus. */
const VOLUME_STEP = 0.05;

/** The parts of a keydown the volume slider reads. */
type VolumeKey = { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

/**
 * Where a key pressed on the focused volume slider puts the volume (0–1), or null for a key it
 * leaves alone: the ARIA slider keys, without modifiers, as the timeline reads them.
 */
export const volumeKeyTarget = (event: VolumeKey, volume: number): number | null => {
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, 0), 1) * 100) / 100;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(volume - VOLUME_STEP);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(volume + VOLUME_STEP);
    case 'PageDown':
      return clamp(volume - 0.2);
    case 'PageUp':
      return clamp(volume + 0.2);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return null;
  }
};

/** A remembered volume read back from storage: a share from 0 to 1, or the whole when it is not one. */
export const parseVolume = (stored: string): number => {
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
};

/** The volume icon for what is heard: none, a little, or more. */
export const volumeIcon = (volume: number, muted: boolean): string => muted || volume === 0 ? 'volume-3' : volume < 0.5 ? 'volume-2' : 'volume';
