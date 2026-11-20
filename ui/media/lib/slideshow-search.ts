/**
 * The page's query parameter that starts the lightbox's slideshow. On a list of media — an album,
 * a search, a person — `?slideshow` opens the first file and runs the slideshow over the list; on
 * a page with a file already open (`?fullscreen=/media/…`, or `/media/<path>` itself) it runs from
 * that file. `?slideshow=screen` runs it for a screen nobody touches (ein/core#1321): the counter,
 * date and place, without the stop button, the pointer or a request for fullscreen. A screen is
 * given the slideshow page (`screenSlideshow`), which is the slideshow alone, with no list page
 * under it. Pure, so it round-trips in a test.
 */
import type { ScreenKey } from '@ein/api';

const SLIDESHOW_PARAM = 'slideshow';

/** The slideshow page's parameter for the order of a list that is not ranked: `oldest` first, else newest. */
export const SLIDESHOW_ORDER_PARAM = 'order';

/** The keys a slideshow on a screen takes from its controls: back a slide, pause or go on, on a slide. */
export const SLIDESHOW_KEYS: ScreenKey[] = [
  { key: 'ArrowLeft', label: 'Previous', icon: 'player-skip-back' },
  { key: 'Space', label: 'Pause or play', icon: 'player-pause' },
  { key: 'ArrowRight', label: 'Next', icon: 'player-skip-forward' },
];

/** The slideshow's keys as they are now, which the screen's controls show: Space pauses it while it plays, and plays it while it is `held`. */
export const slideshowKeys = (held: boolean): ScreenKey[] =>
  SLIDESHOW_KEYS.map((each) => each.key === 'Space' ? { ...each, ...(held ? { label: 'Play', icon: 'player-play' } : { label: 'Pause' }) } : each);

/** How the slideshow is shown: to someone at the browser, or on a screen. */
export type SlideshowMode = 'show' | 'screen';

/** The slideshow the page's query string asks for, or undefined when it asks for none. */
export function slideshowFromSearch(search: string): SlideshowMode | undefined {
  const params = new URLSearchParams(search);
  if (!params.has(SLIDESHOW_PARAM)) return undefined;
  return params.get(SLIDESHOW_PARAM) === 'screen' ? 'screen' : 'show';
}

/** Remove only the slideshow, keeping the page's other parameters. */
export function withoutSlideshowSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SLIDESHOW_PARAM);
  const next = params.toString();
  return next ? `?${next}` : '';
}

/**
 * A page as a screen is given it (a file's own, `/media/<path>?slideshow=screen`): its route and
 * its parameters, with the slideshow for a screen.
 */
export function screenSlideshowRoute(pathname: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.set(SLIDESHOW_PARAM, 'screen');
  return `${pathname}?${next}`;
}

/**
 * The slideshow of a list for a screen: the slideshow page (`/slideshow`) over the media the
 * filters' parameters find (`under` an album, a search's words and pills, its kinds), oldest first
 * when `oldest`, with the slideshow for a screen.
 */
export function screenSlideshow(params: URLSearchParams, { oldest = false }: { oldest?: boolean } = {}): string {
  const next = new URLSearchParams(params);
  if (oldest) next.set(SLIDESHOW_ORDER_PARAM, 'oldest');
  next.set(SLIDESHOW_PARAM, 'screen');
  return `/slideshow?${next}`;
}
