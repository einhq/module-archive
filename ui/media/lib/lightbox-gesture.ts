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
 * A release is finished by two critically damped springs pulling the picture together: a stiff one
 * over most of the way, which has it nearly there at once, and a soft one over the last
 * `SOFT_SHARE` of it, which slows it into place. Natural frequencies in radians per millisecond: a
 * typical flick is nearly 90% of the way in after 120ms, eases over the rest, and is at rest after
 * about 430ms.
 */
const STIFF_SPRING = 0.0375;
const SOFT_SPRING = 0.015;
const SOFT_SHARE = 0.15;
/** The slide ends this close to rest, in px; its last sample covers what is left, too little to see. */
const REST_PX = 0.5;
/**
 * How close to its end a slide hands over to the picture it brings in. The picture is then moving
 * so slowly that the switch, should it land a frame late, cannot be seen.
 */
const HANDOVER_PX = 8;
/** Time between the samples of a slide's easing, which `linear()` joins with straight lines. */
const SAMPLE_MS = 8;

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

type LightboxEase = { durationMs: number; easing: string };

export type LightboxSwipeFinish = LightboxEase & {
  /** When `HANDOVER_PX` are left: the time to switch to the picture coming in. */
  handoverMs: number;
  /** How far the slide has still to go `elapsedMs` in, in px. */
  leftAt: (elapsedMs: number) => number;
  /** The slide from `elapsedMs` on: what is left of the way, eased as the rest of the curve. */
  restFrom: (elapsedMs: number) => LightboxEase & { leftPx: number };
};

/** `left`'s curve from `from` to `to` ms as a `linear()` easing of evenly spaced samples. */
const easingOf = (left: (t: number) => number, from: number, to: number): string => {
  const total = left(from);
  const steps = Math.max(1, Math.round((to - from) / SAMPLE_MS));
  const points: number[] = [];
  for (let i = 0; i < steps; i++) points.push(Number((1 - left(from + ((to - from) * i) / steps) / total).toFixed(3)));
  return `linear(${[...points, 1].join(', ')})`;
};

/**
 * The slide that carries a released swipe the rest of the way: it leaves at the finger's speed,
 * like a flung photo rather than a fresh animation, has the picture nearly there in about 120ms
 * however slow the release, and slows it into place over the last few pixels. Nothing overshoots:
 * a release faster than the stiff spring's pull starts at the pull.
 *
 * The curve is written out as CSS `linear()` easings of evenly spaced samples, so the slide is
 * still a transition, which the compositor runs whatever the page's script is doing; `restFrom`
 * gives the same for what is left of it, to carry on from a moment of the slide.
 */
export function lightboxSwipeFinish(distancePx: number, speedPxPerMs: number): LightboxSwipeFinish {
  const distance = Math.max(distancePx, 1);
  const stiff = (1 - SOFT_SHARE) * distance;
  const soft = SOFT_SHARE * distance;
  // The finger's speed is the stiff spring's to carry on.
  const speed = Math.min(Math.max(speedPxPerMs, 0), STIFF_SPRING * stiff);
  const left = (t: number) => stiff * (1 + (STIFF_SPRING - speed / stiff) * t) * Math.exp(-STIFF_SPRING * t) + soft * (1 + SOFT_SPRING * t) * Math.exp(-SOFT_SPRING * t);
  let durationMs = 1;
  while (left(durationMs) > REST_PX) durationMs++;
  let handoverMs = 0;
  while (handoverMs < durationMs && left(handoverMs) > HANDOVER_PX) handoverMs++;
  const leftAt = (t: number) => t >= durationMs ? 0 : left(Math.max(t, 0));
  return {
    durationMs,
    easing: easingOf(left, 0, durationMs),
    handoverMs,
    leftAt,
    restFrom: (t) => {
      const from = Math.min(Math.max(t, 0), durationMs);
      return { leftPx: leftAt(from), durationMs: Math.max(1, durationMs - from), easing: easingOf(left, from, durationMs) };
    },
  };
}
