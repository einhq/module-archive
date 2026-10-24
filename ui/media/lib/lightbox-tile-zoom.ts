/**
 * The lightbox opens by growing the picture out of the tile that was pressed, and
 * closes by shrinking it back into its tile, rather than switching. A copy of the
 * picture flies between the tile and where the lightbox lays the picture out; the
 * real ones stay hidden in flight so the copy is the only one seen.
 *
 * The tile is found by `data-media-path`, which every grid tile carries, so whichever
 * page opened the lightbox needs to pass nothing. No tile on screen — a deep link, the
 * map, a chat answer — and the lightbox just fades. Closing waits for the grid to mark
 * the tile `data-lightbox-returned`, once it has scrolled it into view.
 */

type Rect = { left: number; top: number; width: number; height: number };

/** How long the picture takes between tile and lightbox; the lightbox fades over the same. */
const LIGHTBOX_ZOOM_MS = 380;
const ZOOM_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** The thumbnail's fade into the full picture once that is there. */
const HANDOFF_MS = 140;
/** How many frames a closing picture waits for its tile to be scrolled into view and hold still (~1/2 s). */
const SETTLE_FRAMES = 30;
/** How long the thumbnail waits for the full picture before giving way regardless. */
const HANDOFF_WAIT_MS = 1500;

/** Where a picture of `aspect` (width / height) lands when contain-fitted into `box`. */
export function containRect(box: Rect, aspect: number): Rect {
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

function onScreen(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.top + rect.height > 0 && rect.left + rect.width > 0 &&
    rect.top < globalThis.innerHeight && rect.left < globalThis.innerWidth;
}

function frame(rect: Rect): Keyframe {
  return { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` };
}

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** The on-screen tile for `path` and its loaded thumbnail. Iterated rather than a selector, so a path needs no escaping. */
function findTile(path: string): { tile: HTMLElement; thumb: HTMLImageElement } | undefined {
  const tile = [...document.querySelectorAll<HTMLElement>('[data-media-path]')].find((el) => el.dataset.mediaPath === path);
  const thumb = tile?.querySelector('img');
  if (!tile || !thumb || !thumb.complete || thumb.naturalWidth === 0) return undefined;
  if (!onScreen(tile.getBoundingClientRect())) return undefined;
  return { tile, thumb };
}

/**
 * The copy that flies. It crops like a tile (`cover`), so wherever its box has the
 * tile's shape it is the tile exactly, and wherever its box has the picture's own
 * shape it is the whole picture.
 */
function makeGhost(src: string, at: Rect): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.dataset.lightboxZoom = '';
  Object.assign(ghost.style, { position: 'fixed', overflow: 'hidden', zIndex: '1000', pointerEvents: 'none', ...frame(at) });
  const image = document.createElement('img');
  image.src = src;
  image.alt = '';
  Object.assign(image.style, { display: 'block', width: '100%', height: '100%', objectFit: 'cover' });
  ghost.append(image);
  document.body.append(ghost);
  return ghost;
}

/** Resolves once `media` has something to show, or after `HANDOFF_WAIT_MS`. */
function settled(media: HTMLImageElement | HTMLVideoElement | null, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!(media instanceof HTMLImageElement) || (media.complete && media.naturalWidth > 0)) return resolve();
    const done = () => resolve();
    const timer = globalThis.setTimeout(done, HANDOFF_WAIT_MS);
    media.addEventListener('load', done, { once: true, signal });
    media.addEventListener('error', done, { once: true, signal });
    signal.addEventListener('abort', () => globalThis.clearTimeout(timer), { once: true });
  });
}

/**
 * Grow `path`'s tile into `box`, the lightbox's picture area, which holds a picture of
 * `aspect`. `media` is read when the flight lands, since the lightbox's element mounts
 * after this starts. Returns a cancel, which puts everything back at once; it returns
 * undefined when there is no tile to grow from, or motion is unwanted.
 */
export function zoomFromTile(
  path: string,
  box: HTMLElement,
  aspect: number | undefined,
  media: () => HTMLImageElement | HTMLVideoElement | null,
): (() => void) | undefined {
  if (reducedMotion()) return undefined;
  const found = findTile(path);
  if (!found) return undefined;
  const { tile, thumb } = found;

  const from = tile.getBoundingClientRect();
  const to = containRect(box.getBoundingClientRect(), aspect ?? thumb.naturalWidth / thumb.naturalHeight);
  const ghost = makeGhost(thumb.currentSrc || thumb.src, to);

  box.style.visibility = 'hidden';
  const aborter = new AbortController();
  const finish = () => {
    aborter.abort();
    box.style.visibility = '';
    ghost.remove();
  };

  ghost.animate([frame(from), frame(to)], { duration: LIGHTBOX_ZOOM_MS, easing: ZOOM_EASING }).finished
    .then(() => {
      if (aborter.signal.aborted) return;
      box.style.visibility = '';
      return settled(media(), aborter.signal);
    })
    .then(() => {
      if (aborter.signal.aborted) return;
      return ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: HANDOFF_MS, fill: 'forwards' }).finished;
    })
    .catch(() => undefined)
    .finally(() => {
      if (!aborter.signal.aborted) finish();
    });

  return finish;
}

/**
 * A still copy of `lightbox` — its bar, buttons and side panel — to fade out
 * once the lightbox itself is gone, without the picture area `box`, which the flying copy
 * stands in for. Nothing in it plays, loads or moves, and nothing in it is found again as a
 * tile or as the lightbox.
 */
function snapshot(lightbox: HTMLElement, box: HTMLElement): HTMLElement {
  box.style.visibility = 'hidden';
  const copy = lightbox.cloneNode(true) as HTMLElement;
  box.style.visibility = '';
  for (const el of copy.querySelectorAll('video, audio, iframe')) el.remove();
  // Inserted anew, an element starts its CSS animations over and enters from its
  // `@starting-style`: the details panel would open from nothing as the lightbox fades.
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    el.style.transition = 'none';
    el.style.animation = 'none';
  }
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('[id], [data-media-path], [data-lightbox-media-path]')]) {
    el.removeAttribute('id');
    el.removeAttribute('data-media-path');
    el.removeAttribute('data-lightbox-media-path');
  }
  copy.inert = true;
  const at = lightbox.getBoundingClientRect();
  Object.assign(copy.style, { position: 'fixed', margin: '0', ...frame(at) });
  return copy;
}

/**
 * Shrink the closing lightbox's picture back into `path`'s tile. Called as the
 * lightbox closes, while `lightbox`, `box` and `media` are still laid out; the tile is
 * looked for a couple of frames later, once the grid has scrolled it back into view.
 * Runs to its end by itself: the lightbox it came from is gone by then, so the copy
 * brings its own backdrop in the lightbox's colour, with a still of the lightbox's bar
 * and panels on it, and fades both out over the flight.
 */
export function zoomToTile(
  path: string,
  lightbox: HTMLElement | null,
  box: HTMLElement,
  aspect: number | undefined,
  media: HTMLImageElement | HTMLVideoElement | null,
): void {
  if (reducedMotion()) return;
  const boxRect = box.getBoundingClientRect();
  if (boxRect.width === 0 || boxRect.height === 0) return;
  // The full picture when it is there, else whatever the tile shows, found below.
  const full = media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0 ? media : undefined;
  const fit = aspect ?? (full ? full.naturalWidth / full.naturalHeight : undefined);
  // The element's own rect, so a zoomed-in picture starts from where it is drawn.
  const from = fit ? containRect(media?.getBoundingClientRect() ?? boxRect, fit) : undefined;
  if (!from) return;

  const backdrop = document.createElement('div');
  backdrop.setAttribute('aria-hidden', 'true');
  Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '999', pointerEvents: 'none', background: 'var(--mrx-media-bg)' });
  if (lightbox) backdrop.append(snapshot(lightbox, box));
  document.body.append(backdrop);
  const ghost = makeGhost(full ? (full.currentSrc || full.src) : '', from);

  const release = () => {
    backdrop.remove();
    ghost.remove();
  };
  // The grid scrolls the tile back into view some frames after the close, once the
  // lightbox's route has left the URL, and a windowed grid may only render it then. A
  // tile partly on screen is already found before that, where it was. So wait, behind
  // the opaque backdrop, until the grid has marked the tile revealed and it has held
  // still for a frame — the jump is never seen, and the copy flies to where the tile
  // ends up rather than where it was. Give up after `SETTLE_FRAMES` and fade the copy
  // where it is.
  let frames = 0;
  let last: DOMRect | undefined;
  const settle = () => {
    frames++;
    const found = findTile(path);
    const rect = found?.tile.dataset.lightboxReturned !== undefined ? found.tile.getBoundingClientRect() : undefined;
    const still = rect && last && Math.abs(rect.top - last.top) < 1 && Math.abs(rect.left - last.left) < 1;
    if (found && rect && still) return fly(found.tile, found.thumb, rect);
    last = rect;
    if (frames >= SETTLE_FRAMES) return fadeAway();
    requestAnimationFrame(settle);
  };
  const fadeAway = () => {
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LIGHTBOX_ZOOM_MS, easing: ZOOM_EASING, fill: 'forwards' });
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LIGHTBOX_ZOOM_MS, easing: ZOOM_EASING, fill: 'forwards' }).finished
      .catch(() => undefined)
      .finally(release);
  };
  const fly = (tile: HTMLElement, thumb: HTMLImageElement, to: DOMRect) => {
    if (!full) ghost.querySelector('img')!.src = thumb.currentSrc || thumb.src;
    // The tile waits empty for the copy to land in it. Transparent rather than hidden: the grid
    // has focused it, and the browser blurs a focused element that turns `visibility: hidden`.
    tile.style.opacity = '0';
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LIGHTBOX_ZOOM_MS, easing: ZOOM_EASING, fill: 'forwards' });
    ghost.animate([frame(from), frame(to)], { duration: LIGHTBOX_ZOOM_MS, easing: ZOOM_EASING, fill: 'forwards' }).finished
      .catch(() => undefined)
      .finally(() => {
        tile.style.opacity = '';
        release();
      });
  };
  requestAnimationFrame(settle);
}
