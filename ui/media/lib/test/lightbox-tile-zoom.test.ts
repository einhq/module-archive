import { assertEquals } from '@std/assert';
import { containRect } from '../lightbox-tile-zoom.ts';

Deno.test('containRect: a wide picture fills the width and centres vertically', () => {
  assertEquals(containRect({ left: 0, top: 50, width: 400, height: 800 }, 2), { left: 0, top: 350, width: 400, height: 200 });
});

Deno.test('containRect: a tall picture fills the height and centres horizontally', () => {
  assertEquals(containRect({ left: 60, top: 0, width: 1000, height: 500 }, 0.5), { left: 435, top: 0, width: 250, height: 500 });
});

Deno.test("containRect: the box's own shape fills it exactly", () => {
  assertEquals(containRect({ left: 10, top: 20, width: 300, height: 200 }, 1.5), { left: 10, top: 20, width: 300, height: 200 });
});
