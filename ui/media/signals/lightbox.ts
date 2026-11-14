import { signal } from '@preact/signals-react';

/** Whether the lightbox shows its info sidebar. */
export const infoSidebarOpen = signal<boolean>(true);

export const toggleInfoSidebar = () => {
  infoSidebarOpen.value = !infoSidebarOpen.value;
};

/**
 * The path of the picture the lightbox's viewer has stopped on: shown for a moment
 * (`LIGHTBOX_REST_MS`) with no step and no finger on it. Null while a run of swipes goes on. The
 * route waits for it before it moves to the picture.
 */
export const lightboxRestedPath = signal<string | null>(null);

/** A remembered on/off, or off where storage is empty or unavailable. */
const readFlag = (key: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(key) === 'true';
  } catch {
    return false;
  }
};

/** Flip a remembered on/off, kept on this device. */
const toggleFlag = (flag: { value: boolean }, key: string) => {
  flag.value = !flag.value;
  try {
    globalThis.localStorage?.setItem(key, String(flag.value));
  } catch {
    // Private mode or blocked storage: the choice lasts for this page load.
  }
};

const FACES_KEY = 'ein.lightbox.faces';
const TEXT_KEY = 'ein.lightbox.text';
const TOOLBAR_KEY = 'ein.lightbox.toolbar';

/**
 * Pins the face boxes over the lightbox image. Off until chosen: boxes are drawn on hover, so
 * the picture is unobstructed until someone goes looking for faces. Pinning keeps them up,
 * which is also the only way to see them on a touch screen, where there is no hover.
 */
export const facesVisible = signal<boolean>(readFlag(FACES_KEY));

export const toggleFacesVisible = () => toggleFlag(facesVisible, FACES_KEY);

/** Lays the text read from a photo over it. Off until chosen. */
export const textVisible = signal<boolean>(readFlag(TEXT_KEY));

export const toggleTextVisible = () => toggleFlag(textVisible, TEXT_KEY);

/** Shows the details panel's file actions as a row of icons over the top of the picture. Off until chosen. */
export const toolbarVisible = signal<boolean>(readFlag(TOOLBAR_KEY));

export const toggleToolbarVisible = () => toggleFlag(toolbarVisible, TOOLBAR_KEY);

/**
 * Hides the lightbox's "x of y". A page whose list is loaded a window at a time, like the
 * media page's whole-archive feed, knows neither where in the whole the picture sits nor how
 * many there are, so the count would only mislead. The page sets it while it is mounted.
 */
export const lightboxCountHidden = signal<boolean>(false);
