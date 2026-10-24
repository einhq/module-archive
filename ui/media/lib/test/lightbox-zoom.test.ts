import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import {
  clampZoom,
  DOUBLE_TAP_ZOOM,
  isDoubleTap,
  isTap,
  isZoomed,
  MAX_ZOOM,
  panZoom,
  pinchGeometry,
  pinchZoom,
  stepZoom,
  toggleZoom,
  wheelZoomScale,
  ZOOM_IDENTITY,
  zoomAt,
  zoomedSizes,
  type ZoomFrame,
} from '../lightbox-zoom.ts';

// A landscape picture letterboxed inside a 1000x800 box.
const frame: ZoomFrame = { viewport: { width: 1000, height: 800 }, content: { width: 1000, height: 600 } };

Deno.test('clampZoom centres an axis the picture does not overflow and bounds one it does', () => {
  // At 2x the picture is 2000x1200: it may move 500 sideways and 200 vertically.
  assertEquals(clampZoom({ scale: 2, x: 900, y: -900 }, frame), { scale: 2, x: 500, y: -200 });
  // At 1.2x it is 1200x720: narrower than the box vertically, so any y is pulled to 0.
  assertEquals(clampZoom({ scale: 1.2, x: 50, y: 30 }, frame), { scale: 1.2, x: 50, y: 0 });
});

Deno.test('clampZoom collapses to the identity at or below 1x and caps at the maximum', () => {
  assertEquals(clampZoom({ scale: 0.6, x: 40, y: 40 }, frame), ZOOM_IDENTITY);
  assertEquals(clampZoom({ scale: 1, x: 40, y: 40 }, frame), ZOOM_IDENTITY);
  assertEquals(clampZoom({ scale: 50, x: 0, y: 0 }, frame).scale, MAX_ZOOM);
});

Deno.test('zoomAt keeps the picture point under the focal point where it was', () => {
  const focal = { x: 200, y: 100 };
  const zoomed = zoomAt(ZOOM_IDENTITY, focal, 2, frame);
  // Content point under focal before: (200, 100); after: (200, 100) * 2 + t must equal focal.
  assertAlmostEquals(200 * 2 + zoomed.x, focal.x);
  assertAlmostEquals(100 * 2 + zoomed.y, focal.y);

  // Zooming out from there about the same point returns to fit.
  assertEquals(zoomAt(zoomed, focal, 1, frame), ZOOM_IDENTITY);
});

Deno.test('zoomAt near an edge is pulled back so no gap opens', () => {
  const zoomed = zoomAt(ZOOM_IDENTITY, { x: 500, y: 0 }, 2, frame);
  assertEquals(zoomed.x, -500);
});

Deno.test('panZoom moves within the edges and is inert at fit', () => {
  const zoomed = zoomAt(ZOOM_IDENTITY, { x: 0, y: 0 }, 2, frame);
  assertEquals(panZoom(zoomed, 100, 50, frame), { scale: 2, x: 100, y: 50 });
  assertEquals(panZoom(zoomed, 5000, 5000, frame), { scale: 2, x: 500, y: 200 });
  assertEquals(panZoom(ZOOM_IDENTITY, 100, 50, frame), ZOOM_IDENTITY);
});

Deno.test('toggleZoom alternates between the double-tap scale and fit', () => {
  const zoomed = toggleZoom(ZOOM_IDENTITY, { x: 0, y: 0 }, frame);
  assertEquals(zoomed.scale, DOUBLE_TAP_ZOOM);
  assertEquals(toggleZoom(zoomed, { x: 30, y: 30 }, frame), ZOOM_IDENTITY);
});

Deno.test('stepZoom steps about the centre and never below fit', () => {
  const stepped = stepZoom(ZOOM_IDENTITY, 1, frame);
  assert(isZoomed(stepped));
  assertEquals(stepped.x, 0);
  assertEquals(stepZoom(stepped, -1, frame), ZOOM_IDENTITY);
  assertEquals(stepZoom(ZOOM_IDENTITY, -1, frame), ZOOM_IDENTITY);
});

Deno.test('wheelZoomScale zooms in on scroll up, out on scroll down, and stays in range', () => {
  assert(wheelZoomScale(1, -100) > 1);
  assert(wheelZoomScale(2, 100) < 2);
  assertEquals(wheelZoomScale(1, 100), 1);
  assertEquals(wheelZoomScale(MAX_ZOOM, -100), MAX_ZOOM);
});

Deno.test('pinchZoom scales by the spread of the fingers and follows their midpoint', () => {
  const start = { state: ZOOM_IDENTITY, ...pinchGeometry({ x: -50, y: 0 }, { x: 50, y: 0 }) };
  assertEquals(start.distance, 100);
  const spread = pinchZoom(start, pinchGeometry({ x: -100, y: 0 }, { x: 100, y: 0 }), frame);
  assertAlmostEquals(spread.scale, 2);
  // The midpoint did not move, and it was the centre, so nothing translated.
  assertEquals(spread.x, 0);

  const dragged = pinchZoom(start, pinchGeometry({ x: 0, y: 20 }, { x: 200, y: 20 }), frame);
  assertAlmostEquals(dragged.scale, 2);
  assertAlmostEquals(dragged.x, 100);
  assertAlmostEquals(dragged.y, 20);
});

Deno.test('pinchZoom closing the fingers past fit lands on the identity', () => {
  const start = { state: { scale: 2, x: 100, y: 0 }, centre: { x: 0, y: 0 }, distance: 100 };
  assertEquals(pinchZoom(start, { centre: { x: 0, y: 0 }, distance: 30 }, frame), ZOOM_IDENTITY);
});

Deno.test('tap detection separates a tap from a drag and pairs two quick taps', () => {
  const down = { x: 100, y: 100, time: 1000 };
  assert(isTap(down, { x: 104, y: 98, time: 1120 }));
  assert(!isTap(down, { x: 140, y: 100, time: 1120 }));
  assert(!isTap(down, { x: 100, y: 100, time: 1500 }));

  const first = { x: 100, y: 100, time: 1000 };
  assert(isDoubleTap(first, { x: 110, y: 90, time: 1250 }));
  assert(!isDoubleTap(first, { x: 110, y: 90, time: 1400 }));
  assert(!isDoubleTap(first, { x: 200, y: 90, time: 1100 }));
  assert(!isDoubleTap(null, first));
});

Deno.test('zoomedSizes asks for a whole multiple of the viewport width', () => {
  assertEquals(zoomedSizes(1), '100vw');
  assertEquals(zoomedSizes(1.3), '200vw');
  assertEquals(zoomedSizes(2.5), '300vw');
});
