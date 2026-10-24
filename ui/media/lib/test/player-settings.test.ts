import { assertEquals } from '@std/assert';
import { parseVolume, rateLabel, stepRate, volumeIcon, volumeKeyTarget } from '../player-settings.ts';

const key = (name: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key: name,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

Deno.test('the speed steps through the menu, held at its ends', () => {
  assertEquals(stepRate(1, 1), 1.25);
  assertEquals(stepRate(1, -1), 0.75);
  assertEquals(stepRate(2, 1), 2);
  assertEquals(stepRate(0.5, -1), 0.5);
  // A speed between the menu's steps goes to the nearest one in that direction.
  assertEquals(stepRate(1.1, 1), 1.25);
  assertEquals(stepRate(1.1, -1), 1);
  assertEquals(rateLabel(0.75), '0.75×');
});

Deno.test('the volume slider takes the slider keys and leaves modified ones alone', () => {
  assertEquals(volumeKeyTarget(key('ArrowUp'), 0.5), 0.55);
  assertEquals(volumeKeyTarget(key('ArrowLeft'), 0.5), 0.45);
  assertEquals(volumeKeyTarget(key('ArrowRight'), 0.98), 1);
  assertEquals(volumeKeyTarget(key('ArrowDown'), 0.02), 0);
  assertEquals(volumeKeyTarget(key('Home'), 0.5), 0);
  assertEquals(volumeKeyTarget(key('End'), 0.5), 1);
  assertEquals(volumeKeyTarget(key('ArrowLeft', { shiftKey: true }), 0.5), null);
  assertEquals(volumeKeyTarget(key('m'), 0.5), null);
});

Deno.test('a remembered volume outside 0–1 reads as the whole', () => {
  assertEquals(parseVolume('0.3'), 0.3);
  assertEquals(parseVolume('loud'), 1);
  assertEquals(parseVolume('2'), 1);
});

Deno.test('the volume icon follows what is heard', () => {
  assertEquals(volumeIcon(1, true), 'volume-3');
  assertEquals(volumeIcon(0, false), 'volume-3');
  assertEquals(volumeIcon(0.3, false), 'volume-2');
  assertEquals(volumeIcon(0.8, false), 'volume');
});
