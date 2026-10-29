/**
 * The lightbox players' volume: the steps it moves in and what it reads as.
 *
 * Pure, so it is tested without a browser.
 */

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
