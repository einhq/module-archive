/**
 * Zoom and pan geometry for the lightbox picture.
 *
 * The picture sits contained inside a viewport box, and the box is transformed with
 * `translate(x, y) scale(scale)` about its own centre. Every coordinate here is therefore in
 * screen pixels relative to that centre, which is the only frame in which a wheel event, a
 * pinch and a drag all describe the same thing: a point on the screen and how far it moved.
 *
 * Pure so the clamping and focal-point arithmetic is testable without a browser.
 */

export type ZoomState = {
  scale: number;
  x: number;
  y: number;
};

export type ZoomFrame = {
  /** The box the transform is applied to, at scale 1. */
  viewport: { width: number; height: number };
  /** The rendered (object-fit: contain) picture inside it, at scale 1. */
  content: { width: number; height: number };
};

export type ZoomPoint = { x: number; y: number };

export type TapPoint = ZoomPoint & { time: number };

export const ZOOM_IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 };
const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** What one double-tap or double-click zooms to; a second one returns to fit. */
export const DOUBLE_TAP_ZOOM = 2.5;
/** How much one keyboard or button step changes the scale. */
const ZOOM_STEP = 1.5;
/** How a double-tap, a key or a button glides to its new zoom; a wheel or a pinch follows at once. */
export const ZOOM_ANIMATION = 'transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)';

const WHEEL_SENSITIVITY = 0.0025;
const ZOOMED_EPSILON = 0.001;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 40;
const TAP_MOVE_PX = 12;

export function isZoomed(state: ZoomState): boolean {
  return state.scale > MIN_ZOOM + ZOOMED_EPSILON;
}

const clampScale = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

const clampAxis = (offset: number, contentSize: number, viewportSize: number, scale: number): number => {
  const overflow = (contentSize * scale - viewportSize) / 2;
  // A picture smaller than the box on this axis stays centred; a larger one may not leave a gap.
  if (overflow <= 0) return 0;
  return Math.min(overflow, Math.max(-overflow, offset));
};

/** Keep the scale in range and the picture covering the box wherever it is larger than it. */
export function clampZoom(state: ZoomState, frame: ZoomFrame): ZoomState {
  const scale = clampScale(state.scale);
  if (scale <= MIN_ZOOM + ZOOMED_EPSILON) return ZOOM_IDENTITY;
  return {
    scale,
    x: clampAxis(state.x, frame.content.width, frame.viewport.width, scale),
    y: clampAxis(state.y, frame.content.height, frame.viewport.height, scale),
  };
}

/**
 * Set the scale so that the picture point under `focal` stays under it.
 *
 * A screen point p shows content point c = (p - t) / s. Keeping c fixed under a new scale s'
 * means t' = p - c * s', which is the translation below before clamping pulls it back in.
 */
export function zoomAt(state: ZoomState, focal: ZoomPoint, scale: number, frame: ZoomFrame): ZoomState {
  const next = clampScale(scale);
  const ratio = next / state.scale;
  return clampZoom({
    scale: next,
    x: focal.x - (focal.x - state.x) * ratio,
    y: focal.y - (focal.y - state.y) * ratio,
  }, frame);
}

/** Move the picture by a screen-pixel delta, stopping at its edges. */
export function panZoom(state: ZoomState, dx: number, dy: number, frame: ZoomFrame): ZoomState {
  if (!isZoomed(state)) return ZOOM_IDENTITY;
  return clampZoom({ scale: state.scale, x: state.x + dx, y: state.y + dy }, frame);
}

/** A double-tap or double-click: zoom in on the point, or back out to fit if already in. */
export function toggleZoom(state: ZoomState, focal: ZoomPoint, frame: ZoomFrame): ZoomState {
  if (isZoomed(state)) return ZOOM_IDENTITY;
  return zoomAt(state, focal, DOUBLE_TAP_ZOOM, frame);
}

/** Step the scale in or out about the centre, for the keyboard. */
export function stepZoom(state: ZoomState, direction: 1 | -1, frame: ZoomFrame): ZoomState {
  const scale = direction > 0 ? state.scale * ZOOM_STEP : state.scale / ZOOM_STEP;
  return zoomAt(state, { x: 0, y: 0 }, scale, frame);
}

/**
 * The scale a wheel notch asks for.
 *
 * Exponential in the delta so a notch feels the same at 1x and 4x, and so a trackpad pinch,
 * which arrives as many small ctrl+wheel deltas, integrates smoothly.
 */
export function wheelZoomScale(scale: number, deltaY: number): number {
  return clampScale(scale * Math.exp(-deltaY * WHEEL_SENSITIVITY));
}

/** The midpoint and spread of two fingers. */
export function pinchGeometry(a: ZoomPoint, b: ZoomPoint): { centre: ZoomPoint; distance: number } {
  return {
    centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(b.x - a.x, b.y - a.y),
  };
}

/**
 * Continue a pinch from where it started.
 *
 * The content under the fingers' first midpoint stays under their current midpoint, so
 * spreading and dragging in one motion both zooms and pans, the way a map does.
 */
export function pinchZoom(
  start: { state: ZoomState; centre: ZoomPoint; distance: number },
  current: { centre: ZoomPoint; distance: number },
  frame: ZoomFrame,
): ZoomState {
  if (start.distance <= 0) return start.state;
  const scale = start.state.scale * (current.distance / start.distance);
  const zoomed = zoomAt(start.state, start.centre, scale, frame);
  return panZoom(zoomed, current.centre.x - start.centre.x, current.centre.y - start.centre.y, frame);
}

/** Whether a touch that started at `start` and ended at `end` is a tap rather than a drag. */
export function isTap(start: TapPoint, end: TapPoint): boolean {
  return end.time - start.time < DOUBLE_TAP_MS && Math.hypot(end.x - start.x, end.y - start.y) < TAP_MOVE_PX;
}

/** Whether a tap at `current` follows `previous` closely enough to be the second of a pair. */
export function isDoubleTap(previous: TapPoint | null, current: TapPoint): boolean {
  if (!previous) return false;
  return current.time - previous.time < DOUBLE_TAP_MS && Math.hypot(current.x - previous.x, current.y - previous.y) < DOUBLE_TAP_DISTANCE_PX;
}

/** The `sizes` hint for the picture's srcset: a zoomed picture wants a larger rendition. */
export function zoomedSizes(scale: number): string {
  return `${Math.ceil(scale) * 100}vw`;
}
