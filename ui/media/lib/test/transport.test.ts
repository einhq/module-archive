import { assertEquals } from '@std/assert';
import { clampTime, progressOf, type ScrubKey, scrubKeyTarget, timeAtClientX } from '../transport.ts';

const key = (name: string, modifiers: Partial<ScrubKey> = {}): ScrubKey => ({ key: name, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers });

Deno.test('a time is held inside the recording, and an unmeasured length bounds nothing above', () => {
  assertEquals(clampTime(-3, 60), 0);
  assertEquals(clampTime(75, 60), 60);
  assertEquals(clampTime(75, Number.NaN), 75);
  assertEquals(clampTime(75, Infinity), 75);
});

Deno.test('the pointer maps onto the timeline across its width, clamped at both ends', () => {
  const rect = { left: 100, width: 200 };
  assertEquals(timeAtClientX(150, rect, 80), 20);
  assertEquals(timeAtClientX(50, rect, 80), 0);
  assertEquals(timeAtClientX(400, rect, 80), 80);
  assertEquals(timeAtClientX(150, { left: 0, width: 0 }, 80), null);
  assertEquals(timeAtClientX(150, rect, Number.NaN), null);
});

Deno.test('the slider keys step, page and jump to the ends', () => {
  assertEquals(scrubKeyTarget(key('ArrowRight'), 10, 100), 15);
  assertEquals(scrubKeyTarget(key('ArrowUp'), 10, 100), 15);
  assertEquals(scrubKeyTarget(key('ArrowLeft'), 3, 100), 0);
  assertEquals(scrubKeyTarget(key('ArrowDown'), 10, 100), 5);
  assertEquals(scrubKeyTarget(key('PageUp'), 10, 100), 20);
  assertEquals(scrubKeyTarget(key('PageDown'), 10, 100), 0);
  assertEquals(scrubKeyTarget(key('Home'), 40, 100), 0);
  assertEquals(scrubKeyTarget(key('End'), 40, 100), 100);
});

Deno.test('a key with a modifier, or one the slider does not use, is left to the lightbox', () => {
  assertEquals(scrubKeyTarget(key('ArrowRight', { shiftKey: true }), 10, 100), null);
  assertEquals(scrubKeyTarget(key('ArrowLeft', { metaKey: true }), 10, 100), null);
  assertEquals(scrubKeyTarget(key('Escape'), 10, 100), null);
  assertEquals(scrubKeyTarget(key(' '), 10, 100), null);
});

Deno.test('with chapters the page keys go chapter by chapter', () => {
  const chapters = [0, 20, 50];
  assertEquals(scrubKeyTarget(key('PageUp'), 10, 100, chapters), 20.02);
  assertEquals(scrubKeyTarget(key('PageDown'), 30, 100, chapters), 20.02);
  assertEquals(scrubKeyTarget(key('PageDown'), 21, 100, chapters), 0.02);
  // In the last chapter there is no next one to go to.
  assertEquals(scrubKeyTarget(key('PageUp'), 60, 100, chapters), null);
});

Deno.test('the end and the page keys need a measured length', () => {
  assertEquals(scrubKeyTarget(key('End'), 10, Number.NaN), null);
  assertEquals(scrubKeyTarget(key('PageUp'), 10, 0), null);
  assertEquals(scrubKeyTarget(key('ArrowRight'), 10, Number.NaN), 15);
});

Deno.test('progress is a share of the length, zero before it is known', () => {
  assertEquals(progressOf(30, 120), 0.25);
  assertEquals(progressOf(130, 120), 1);
  assertEquals(progressOf(30, Number.NaN), 0);
});
