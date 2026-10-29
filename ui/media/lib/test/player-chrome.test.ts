import { assertEquals } from '@std/assert';
import { barPlacement, chromeVisible, fittedPicture, subtitleBottom, subtitleClearOfCentre, subtitleFontPx, visiblePicture } from '../player-chrome.ts';

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

Deno.test('unzoomed, the visible picture is the picture', () => {
  const picture = { left: 0, top: 300, width: 390, height: 220 };
  assertEquals(visiblePicture(picture, { width: 390, height: 820 }, { scale: 1, x: 0, y: 0 }), picture);
});

Deno.test("a zoomed picture is seen as far as the box, and the bar goes to the view's bottom", () => {
  // A landscape picture on an upright phone, zoomed 5x: it overflows the box on every side.
  const box = { width: 390, height: 820 };
  const shown = visiblePicture({ left: 0, top: 300, width: 390, height: 220 }, box, { scale: 5, x: 0, y: 0 });
  assertEquals(shown, { left: 0, top: 0, width: 390, height: 820 });
  assertEquals(barPlacement(shown, box.height, 60), 'overlay');
});

Deno.test('a little zoom keeps the picture inside the box, its bottom edge lower', () => {
  const shown = visiblePicture({ left: 0, top: 300, width: 390, height: 220 }, { width: 390, height: 820 }, { scale: 2, x: 0, y: 0 });
  assertEquals(shown, { left: 0, top: 190, width: 390, height: 440 });
});

Deno.test('a panned picture is cut where it leaves the box', () => {
  const shown = visiblePicture({ left: 0, top: 300, width: 390, height: 220 }, { width: 390, height: 820 }, { scale: 2, x: 0, y: 300 });
  assertEquals(shown, { left: 0, top: 490, width: 390, height: 330 });
});

Deno.test('before the box is measured the picture is taken as it is', () => {
  const picture = { left: 0, top: 0, width: 100, height: 50 };
  assertEquals(visiblePicture(picture, { width: 0, height: 0 }, { scale: 3, x: 10, y: 0 }), picture);
});
