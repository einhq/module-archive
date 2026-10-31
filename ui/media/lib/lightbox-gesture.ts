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
/**
 * The stiffness of the slide that finishes a release: a critically damped spring's natural
 * frequency in radians per millisecond. At 0.03 a picture is most of the way in after 100ms and
 * at rest after about 250ms, whatever the distance.
 */
const SPRING_FREQUENCY = 0.03;
/** The slide ends this close to rest, in px; what is left is too little to see. */
const SPRING_REST_PX = 0.5;
/** Time between the samples of the slide's easing, which `linear()` joins with straight lines. */
const SPRING_STEP_MS = 8;

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
 * The slide that carries a released swipe the rest of the way: a critically damped spring, which
 * leaves at the finger's speed and pulls the picture into place, like a flung photo rather than a
 * fresh animation. However slow the release, the pull lands it in about the same short time, and
 * nothing overshoots: a release faster than the pull over that distance starts at the pull.
 *
 * The spring is written out as a CSS `linear()` easing of evenly spaced samples, so the slide is
 * still a transition, which the compositor runs whatever the page's script is doing.
 */
export function lightboxSwipeFinish(distancePx: number, speedPxPerMs: number): LightboxSwipeFinish {
  const distance = Math.max(distancePx, 1);
  const pull = SPRING_FREQUENCY * distance;
  const speed = Math.min(Math.max(speedPxPerMs, 0), pull);
  // The way still to go after `t` ms: `distance` at the start, closing at `speed`.
  const left = (t: number) => (distance + (pull - speed) * t) * Math.exp(-SPRING_FREQUENCY * t);
  let durationMs = 1;
  while (left(durationMs) > SPRING_REST_PX) durationMs++;
  const steps = Math.max(1, Math.round(durationMs / SPRING_STEP_MS));
  const points: number[] = [];
  for (let i = 0; i < steps; i++) points.push(Number((1 - left((i * durationMs) / steps) / distance).toFixed(3)));
  return { durationMs, easing: `linear(${[...points, 1].join(', ')})` };
}
