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

Deno.test('lightbox swipe finish lands without overshooting', () => {
  for (const [distance, speed] of [[400, 0], [300, 1.5], [100, 10], [1400, 0]]) {
    const { durationMs, easing } = lightboxSwipeFinish(distance, speed);
    const points = springPoints(easing);
    assert(durationMs <= 600, `${distance}px at ${speed}px/ms takes ${durationMs}ms`);
    assertEquals(points[0], 0);
    assertEquals(points.at(-1), 1);
    assert(points.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= points[i - 1])), easing);
  }
});

Deno.test('lightbox swipe finish carries most of the way at once, whatever the release speed', () => {
  // 120ms in, however the finger let go, most of the way is behind it.
  for (const speed of [0, 0.4, 1.5, 3]) {
    const { leftAt } = lightboxSwipeFinish(400, speed);
    assert(leftAt(120) < 0.15 * 400, `at ${speed}px/ms ${leftAt(120)}px are left after 120ms`);
  }
});

Deno.test('lightbox swipe finish leaves at the finger speed', () => {
  const { leftAt } = lightboxSwipeFinish(300, 2);
  const start = (300 - leftAt(0.5)) / 0.5;
  assert(start > 1.9 && start < 2.2, `starts at ${start}px/ms`);
  // A faster release is further on at every moment.
  assert(lightboxSwipeFinish(300, 3).leftAt(50) < lightboxSwipeFinish(300, 0).leftAt(50));
});

Deno.test('lightbox swipe finish hands over a few pixels from the end and eases over them', () => {
  const { durationMs, handoverMs, leftAt } = lightboxSwipeFinish(290, 1);
  assert(leftAt(handoverMs) <= 8 && leftAt(handoverMs) > 7, `${leftAt(handoverMs)}px left at the handover`);
  assert(handoverMs < 250, `hands over after ${handoverMs}ms`);
  // The picture goes on easing in for a while after the handover, at no more than a crawl: under
  // 2.5px a frame.
  assert(durationMs - handoverMs >= 120, `${durationMs - handoverMs}ms after the handover`);
  for (let t = handoverMs; t < durationMs; t += 10) assert(leftAt(t) - leftAt(t + 10) < 1.5, `${leftAt(t) - leftAt(t + 10)}px in 10ms at ${t}ms`);
});

Deno.test('lightbox swipe finish carries on from any moment along the same curve', () => {
  const finish = lightboxSwipeFinish(290, 1);
  const from = finish.handoverMs;
  const rest = finish.restFrom(from);
  assertEquals(rest.leftPx, finish.leftAt(from));
  assertEquals(rest.durationMs, finish.durationMs - from);
  const points = springPoints(rest.easing);
  for (const [i, p] of points.entries()) {
    const at = from + (rest.durationMs * i) / (points.length - 1);
    const expected = i === points.length - 1 ? 1 : 1 - finish.leftAt(at) / rest.leftPx;
    assert(Math.abs(p - expected) < 0.002, `sample ${i}: ${p}, the curve ${expected}`);
  }
  assertEquals(finish.restFrom(finish.durationMs).leftPx, 0);
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
