import { assertEquals } from '@std/assert';
import { barPlacement, chromeVisible, fittedPicture, subtitleBottom, subtitleClearOfCentre, subtitleFontPx } from '../player-chrome.ts';

const idle = { paused: false, scrubbing: false, hovered: false, focused: false, menuOpen: false };

Deno.test('the controls show while touched, and stay while paused, scrubbed, pointed at, tabbed to or in a menu', () => {
  assertEquals(chromeVisible(idle, true, false), true);
  assertEquals(chromeVisible(idle, false, false), false);
  assertEquals(chromeVisible({ ...idle, paused: true }, false, false), true);
  assertEquals(chromeVisible({ ...idle, scrubbing: true }, false, false), true);
  assertEquals(chromeVisible({ ...idle, hovered: true }, false, false), true);
  assertEquals(chromeVisible({ ...idle, focused: true }, false, false), true);
  assertEquals(chromeVisible({ ...idle, menuOpen: true }, false, false), true);
});

Deno.test('a slideshow shows no controls at all', () => {
  assertEquals(chromeVisible({ ...idle, paused: true }, true, true), false);
});

Deno.test('the bar goes under the picture only when the letterbox below has the room', () => {
  // A landscape film on an upright phone: 390 wide, 219 tall, centred in a 700 tall box.
  const film = { left: 0, top: 240.5, width: 390, height: 219 };
  assertEquals(barPlacement(film, 700, 80), 'below');
  // The same film filling a box of its own shape leaves nothing below.
  assertEquals(barPlacement({ left: 0, top: 0, width: 390, height: 219 }, 219, 80), 'overlay');
  // Before the bar is measured it is not placed below anything.
  assertEquals(barPlacement(film, 700, 0), 'overlay');
});

Deno.test('before the video has its size, the metadata aspect is fitted into the box', () => {
  assertEquals(fittedPicture({ width: 400, height: 400 }, 2), { left: 0, top: 100, width: 400, height: 200 });
  assertEquals(fittedPicture({ width: 400, height: 400 }, 0.5), { left: 100, top: 0, width: 200, height: 400 });
  assertEquals(fittedPicture({ width: 400, height: 300 }, undefined), { left: 0, top: 0, width: 400, height: 300 });
});

Deno.test('subtitles sit above the picture edge, above a bar over it, and clear a slideshow bar', () => {
  const picture = { left: 0, top: 100, width: 800, height: 400 };
  // 100 px of letterbox under the picture, then 6% of its height.
  assertEquals(subtitleBottom(picture, 600, 0, 0), 124);
  // A 70 px bar over the picture's bottom edge: just above it.
  assertEquals(subtitleBottom(picture, 600, 70, 0), 178);
  // A slideshow bar 60 px tall lies only in the letterbox: nothing to clear.
  assertEquals(subtitleBottom(picture, 600, 0, 60), 124);
  // One 150 px tall reaches 50 px into the picture.
  assertEquals(subtitleBottom(picture, 600, 0, 150), 174);
});

Deno.test("subtitles stay under a phone's centre buttons while two lines fit there, and go above them otherwise", () => {
  // An upright phone's landscape film: a 219 px picture in a 700 px box, buttons 64 px tall.
  const film = { left: 0, top: 240.5, width: 390, height: 219 };
  assertEquals(subtitleClearOfCentre(250, film, 700, 14, 32), 250);
  // A phone held sideways: the picture fills a 296 px box, and only 32 px are left under the buttons.
  const filled = { left: 0, top: 0, width: 526, height: 296 };
  assertEquals(subtitleClearOfCentre(84, filled, 296, 14, 32), 188);
});

Deno.test('the subtitle size follows the picture, within readable bounds', () => {
  assertEquals(subtitleFontPx({ left: 0, top: 0, width: 390, height: 219 }), 14);
  assertEquals(subtitleFontPx({ left: 0, top: 0, width: 800, height: 400 }), 18);
  assertEquals(subtitleFontPx({ left: 0, top: 0, width: 2400, height: 1350 }), 30);
});
