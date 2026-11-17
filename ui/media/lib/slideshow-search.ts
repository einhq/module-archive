/**
 * The page's query parameter that starts the lightbox's slideshow. On a list of media — an album,
 * a search, a person — `?slideshow` opens the first file and runs the slideshow over the list; on
 * a page with a file already open (`?fullscreen=/media/…`, or `/media/<path>` itself) it runs from
 * that file. `?slideshow=screen` runs it for a screen nobody touches (ein/core#1321): the counter,
 * date and place, without the stop button, the pointer or a request for fullscreen. Pure, so it
 * round-trips in a test.
 */
const SLIDESHOW_PARAM = 'slideshow';

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
 * A list page as a screen is given it (`/media?q=boat&slideshow=screen`): its route and the
 * parameters that say what it lists, with the slideshow for a screen.
 */
export function screenSlideshowRoute(pathname: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.set(SLIDESHOW_PARAM, 'screen');
  return `${pathname}?${next}`;
}
