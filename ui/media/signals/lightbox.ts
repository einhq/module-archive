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

/**
 * Pins the face boxes over the lightbox image. Off by default: boxes are drawn on hover, so
 * the picture is unobstructed until someone goes looking for faces. Pinning keeps them up,
 * which is also the only way to see them on a touch screen, where there is no hover.
 */
export const facesVisible = signal<boolean>(false);

export const toggleFacesVisible = () => {
  facesVisible.value = !facesVisible.value;
};

/**
 * Hides the lightbox's "x of y". A page whose list is loaded a window at a time, like the
 * media page's whole-archive feed, knows neither where in the whole the picture sits nor how
 * many there are, so the count would only mislead. The page sets it while it is mounted.
 */
export const lightboxCountHidden = signal<boolean>(false);
