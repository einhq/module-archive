import { assertEquals } from '@std/assert';
import { previewLeft, previewSize, storyboardTile, tileBackground } from '../storyboard.ts';

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
