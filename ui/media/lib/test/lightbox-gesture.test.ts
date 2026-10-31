import { assert, assertEquals } from '@std/assert';
import { lightboxSheetOpens, lightboxSwipeAction, lightboxSwipeFinish, type LightboxTouchPoint, releaseVelocityX, releaseVelocityY } from '../lightbox-gesture.ts';

const swipe = (dx: number, dy: number, duration = 250) => {
  const start: LightboxTouchPoint = { x: 100, y: 100, time: 1000 };
  return lightboxSwipeAction(start, { x: start.x + dx, y: start.y + dy, time: start.time + duration });
};

Deno.test('lightbox swipe uses standard horizontal navigation directions', () => {
  assertEquals(swipe(-80, 5), 'next');
  assertEquals(swipe(80, -5), 'previous');
});

Deno.test('lightbox swipe opens details upward and closes them downward', () => {
  assertEquals(swipe(4, -80), 'open-details');
  assertEquals(swipe(-4, 80), 'close-details');
});

Deno.test('lightbox swipe ignores taps, diagonals, and slow drags', () => {
  assertEquals(swipe(47, 0), null);
  assertEquals(swipe(70, 70), null);
  assertEquals(swipe(80, 0, 1001), null);
});

Deno.test('lightbox release velocity reads only the last moments of the drag', () => {
  const samples: LightboxTouchPoint[] = [
    { x: 300, y: 0, time: 0 },
    { x: 290, y: 0, time: 340 },
    { x: 250, y: 0, time: 450 },
  ];
  // The slow start is outside the window; the last 50ms moved 50px left.
  assertEquals(releaseVelocityX(samples, { x: 240, y: 0, time: 460 }), -1);
  // A finger that stopped before lifting has no speed left.
  assertEquals(releaseVelocityX(samples, { x: 250, y: 0, time: 700 }), 0);
});

/** The progress samples of a `linear()` easing, evenly spaced over the slide. */
const springPoints = (easing: string): number[] => {
  const match = /^linear\((.*)\)$/.exec(easing);
  if (!match) throw new Error(`not a linear() easing: ${easing}`);
  return match[1].split(', ').map(Number);
};

Deno.test('lightbox swipe finish is a spring that comes to rest within 350ms and never overshoots', () => {
  for (const [distance, speed] of [[400, 0], [300, 1.5], [100, 10], [1400, 0]]) {
    const { durationMs, easing } = lightboxSwipeFinish(distance, speed);
    const points = springPoints(easing);
    assert(durationMs <= 350, `${distance}px at ${speed}px/ms takes ${durationMs}ms`);
    assertEquals(points[0], 0);
    assertEquals(points.at(-1), 1);
    assert(points.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= points[i - 1])), easing);
  }
});

Deno.test('lightbox swipe finish carries most of the way at once, whatever the release speed', () => {
  // 100ms in, however the finger let go, most of the way is behind it.
  for (const speed of [0, 0.4, 1.5, 3]) {
    const { durationMs, easing } = lightboxSwipeFinish(400, speed);
    const points = springPoints(easing);
    const third = points[Math.round(((points.length - 1) * 100) / durationMs)];
    assert(third > 0.75, `at ${speed}px/ms only ${third} after 100ms`);
  }
});

Deno.test('lightbox swipe finish leaves at the finger speed', () => {
  // 2px/ms over 300px: the first sample's average speed is the finger's, plus the spring's pull
  // over those few milliseconds.
  const { durationMs, easing } = lightboxSwipeFinish(300, 2);
  const points = springPoints(easing);
  const first = (points[1] * 300) / (durationMs / (points.length - 1));
  assert(first >= 2 && first < 3, `starts at ${first}px/ms`);
  // A faster release lands sooner.
  assert(lightboxSwipeFinish(300, 3).durationMs < lightboxSwipeFinish(300, 0).durationMs);
});

const release = (dx: number, dy: number, velocityX: number, duration = 250) => {
  const start: LightboxTouchPoint = { x: 200, y: 100, time: 1000 };
  return lightboxSwipeAction(start, { x: start.x + dx, y: start.y + dy, time: start.time + duration }, { velocityX, width: 390 });
};

Deno.test('lightbox flick turns the page after a short travel', () => {
  assertEquals(release(-20, 2, -0.5), 'next');
  assertEquals(release(20, -2, 0.5), 'previous');
  // Too short to be anything but a tap, and too slow to be a flick.
  assertEquals(release(-10, 0, -0.5), null);
  assertEquals(release(-20, 0, -0.1), null);
});

Deno.test('lightbox flick back against the drag cancels it', () => {
  assertEquals(release(-100, 0, 0.5), null);
});

Deno.test('lightbox slow drag past a third of the width turns the page whatever it took', () => {
  assertEquals(release(-140, 0, 0, 3000), 'next');
  assertEquals(release(-100, 0, 0, 3000), null);
});

Deno.test('lightbox release velocity reads the vertical axis too', () => {
  const samples: LightboxTouchPoint[] = [{ x: 0, y: 500, time: 0 }, { x: 0, y: 450, time: 50 }];
  assertEquals(releaseVelocityY(samples, { x: 0, y: 400, time: 100 }), -1);
});

Deno.test('lightbox details sheet follows a flick, else stays on the side it is mostly on', () => {
  assertEquals(lightboxSheetOpens(0.1, -0.5), true);
  assertEquals(lightboxSheetOpens(0.9, 0.5), false);
  assertEquals(lightboxSheetOpens(0.6, 0.1), true);
  assertEquals(lightboxSheetOpens(0.4, -0.1), false);
});
