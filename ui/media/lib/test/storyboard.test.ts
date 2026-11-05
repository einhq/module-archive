import { assertEquals } from '@std/assert';
import { coverTile, previewLeft, previewSize, storyboardTile, tileBackground, tileTimes } from '../storyboard.ts';

// A three-minute 4:3 film: a tile a second, 182 of them in rows of 12.
const film = { name: 'storyboard-160.avif', sha256: 'ab', interval: 1, count: 182, columns: 12, tileWidth: 160, tileHeight: 120 };

Deno.test('the tile for a time is the nearest tick, laid out row by row', () => {
  assertEquals(storyboardTile(film, 0), { index: 0, x: 0, y: 0 });
  assertEquals(storyboardTile(film, 0.4), { index: 0, x: 0, y: 0 });
  assertEquals(storyboardTile(film, 0.6), { index: 1, x: 160, y: 0 });
  assertEquals(storyboardTile(film, 13), { index: 13, x: 160, y: 120 });
});

Deno.test('a time past the last tile, or before the first, shows the end tiles', () => {
  assertEquals(storyboardTile(film, 500).index, 181);
  assertEquals(storyboardTile(film, -3).index, 0);
  // A two-hour tape's tiles are half a minute apart.
  assertEquals(storyboardTile({ ...film, interval: 30, count: 240 }, 3600).index, 120);
});

Deno.test('a preview fits the tile into its box by the longer side', () => {
  assertEquals(previewSize(film, 160), { width: 160, height: 120, scale: 1 });
  // A portrait clip's tile is fitted by its height.
  assertEquals(previewSize({ ...film, tileWidth: 90, tileHeight: 160 }, 128), { width: 72, height: 128, scale: 0.8 });
});

Deno.test('the background shows only the one tile, scaled with the preview', () => {
  assertEquals(tileBackground('/s.avif', film, 13, 0.5), {
    backgroundImage: 'url("/s.avif")',
    backgroundSize: '960px auto',
    backgroundPosition: '-80px -60px',
    backgroundRepeat: 'no-repeat',
  });
});

Deno.test('a preview stays inside the bar at both ends', () => {
  assertEquals(previewLeft(500, 160, 1000), 420);
  assertEquals(previewLeft(20, 160, 1000), 0);
  assertEquals(previewLeft(990, 160, 1000), 840);
  assertEquals(previewLeft(50, 160, 100), 0);
});

Deno.test('a tile fills a square window by its shorter side, centred', () => {
  // Scaled by a pixel over the window's 120: tile 13 is the second column of the second row.
  const scale = 121 / 120;
  assertEquals(coverTile(film, 13, 120), { width: 12 * 160 * scale, left: (120 - 160 * scale) / 2 - 160 * scale, top: (120 - 120 * scale) / 2 - 120 * scale });
  // A portrait tile is scaled by its width and centred upright.
  const portrait = coverTile({ ...film, tileWidth: 90, tileHeight: 160 }, 0, 89);
  assertEquals(portrait.width, 12 * 90);
  assertEquals(portrait.left, -0.5);
  assertEquals(portrait.top, (89 - 160) / 2);
});

Deno.test('a stretch of the video is the tiles from its start to its end', () => {
  assertEquals(tileTimes(film, 3.2, 6.6), [3, 4, 5, 6, 7]);
  assertEquals(tileTimes(film, 4.1, 4.3), [4]);
  // A turn ending past the sheet stops at its last tile.
  assertEquals(tileTimes(film, 180, 400), [180, 181]);
  assertEquals(tileTimes({ ...film, interval: 30, count: 240 }, 100, 170), [90, 120, 150, 180]);
});
