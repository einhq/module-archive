type LightboxSwipeAction = 'next' | 'previous' | 'open-details' | 'close-details';

export type LightboxTouchPoint = {
  x: number;
  y: number;
  time: number;
};

const MIN_DISTANCE_PX = 48;
const AXIS_DOMINANCE = 1.2;
const MAX_DURATION_MS = 1000;
/** A release at this speed is a flick: it turns the page after a short travel, however brief. */
const FLICK_SPEED_PX_PER_MS = 0.3;
const FLICK_MIN_DISTANCE_PX = 16;
/** A slow drag this far across the width commits whatever it took, the way a page is set down. */
const DRAG_COMMIT_FRACTION = 1 / 3;

type LightboxSwipeRelease = {
  /** Horizontal finger speed at release, px/ms, negative to the left (see `releaseVelocityX`). */
  velocityX: number;
  /** Viewport width the photo slides across. */
  width: number;
};

/**
 * Classify a deliberate one-finger lightbox swipe without mistaking taps or diagonal drags.
 *
 * Previous/next follows the finger, so with the release known it is decided the way a photo
 * viewer does: a flick in the drag's direction turns the page after a short travel, a flick back
 * against it cancels, and a slow release turns it once dragged far enough.
 */
export function lightboxSwipeAction(
  start: LightboxTouchPoint,
  end: LightboxTouchPoint,
  release?: LightboxSwipeRelease,
): LightboxSwipeAction | null {
  const elapsed = end.time - start.time;
  if (elapsed < 0) return null;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  const horizontalAction = dx < 0 ? 'next' : 'previous';

  if (horizontal > vertical * AXIS_DOMINANCE && release) {
    const along = release.velocityX * Math.sign(dx);
    if (along <= -FLICK_SPEED_PX_PER_MS) return null;
    if (along >= FLICK_SPEED_PX_PER_MS && horizontal >= FLICK_MIN_DISTANCE_PX) return horizontalAction;
    if (horizontal >= release.width * DRAG_COMMIT_FRACTION) return horizontalAction;
  }

  if (elapsed > MAX_DURATION_MS) return null;
  if (horizontal >= MIN_DISTANCE_PX && horizontal > vertical * AXIS_DOMINANCE) return horizontalAction;
  if (vertical >= MIN_DISTANCE_PX && vertical > horizontal * AXIS_DOMINANCE) {
    return dy < 0 ? 'open-details' : 'close-details';
  }
  return null;
}

/** How far back the release velocity looks; older samples describe a finger that has since slowed. */
const VELOCITY_WINDOW_MS = 100;
const MIN_FINISH_MS = 100;
const MAX_FINISH_MS = 400;
/** The steepest start the curve below can take while staying monotonic (its first control point at y = 1). */
const MAX_START_SLOPE = 3;

const releaseVelocity = (samples: readonly LightboxTouchPoint[], end: LightboxTouchPoint, axis: 'x' | 'y'): number => {
  let first = end;
  for (let i = samples.length - 1; i >= 0 && end.time - samples[i].time <= VELOCITY_WINDOW_MS; i--) first = samples[i];
  const elapsed = end.time - first.time;
  return elapsed > 0 ? (end[axis] - first[axis]) / elapsed : 0;
};

/** Horizontal finger speed at release in px/ms, from the move samples of the last few frames. */
export const releaseVelocityX = (samples: readonly LightboxTouchPoint[], end: LightboxTouchPoint): number => releaseVelocity(samples, end, 'x');

/** Vertical finger speed at release in px/ms, negative upwards. */
export const releaseVelocityY = (samples: readonly LightboxTouchPoint[], end: LightboxTouchPoint): number => releaseVelocity(samples, end, 'y');

/**
 * Whether a released drag of the details sheet leaves it open. A flick decides by its direction,
 * whatever the distance; a slow release by whether the sheet is more than half out.
 */
export function lightboxSheetOpens(progress: number, velocityY: number): boolean {
  if (Math.abs(velocityY) >= FLICK_SPEED_PX_PER_MS) return velocityY < 0;
  return progress >= 0.5;
}

type LightboxSwipeFinish = { durationMs: number; easing: string };

/**
 * The slide that carries a released swipe the rest of the way. It leaves at the finger's speed
 * and decelerates to rest, like a flung photo rather than a fresh animation.
 *
 * `cubic-bezier(1/3, s/3, 2/3, 1)` keeps time linear in the curve parameter, so its starting
 * slope is exactly `s` and its end slope zero; `s = 2` is a constant deceleration, which is what
 * `2 * distance / speed` for the duration gives. Outside the duration bounds the slope absorbs
 * the difference: a slow release starts gently and a hard flick is capped rather than overshooting.
 */
export function lightboxSwipeFinish(distancePx: number, speedPxPerMs: number): LightboxSwipeFinish {
  const distance = Math.max(distancePx, 1);
  const speed = Math.max(speedPxPerMs, 0);
  const durationMs = Math.round(speed > 0 ? Math.min(MAX_FINISH_MS, Math.max(MIN_FINISH_MS, (2 * distance) / speed)) : MAX_FINISH_MS);
  const slope = Math.min(MAX_START_SLOPE, (speed * durationMs) / distance);
  return { durationMs, easing: `cubic-bezier(0.333, ${(slope / 3).toFixed(3)}, 0.667, 1)` };
}
