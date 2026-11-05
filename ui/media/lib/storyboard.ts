/**
 * Reading a video's storyboard sheet: which tile shows the frame at a time, and how to draw that
 * tile alone as a preview. Pure, so it is tested without a browser.
 */
import type { Storyboard } from '@archive/media/api';

/**
 * The tile nearest `seconds`, and its top-left corner on the sheet in the sheet's pixels.
 *
 * Tile `i` is the frame nearest `i × interval`, so the tile for a time is the nearest tick's,
 * held inside the tiles the sheet has.
 */
export const storyboardTile = (sheet: Storyboard, seconds: number): { index: number; x: number; y: number } => {
  const index = Math.min(Math.max(Math.round(seconds / sheet.interval), 0), sheet.count - 1);
  return { index, x: (index % sheet.columns) * sheet.tileWidth, y: Math.floor(index / sheet.columns) * sheet.tileHeight };
};

/** A tile's size fitted into a box `longest` pixels on its longer side, and the scale that takes. */
export const previewSize = (sheet: Storyboard, longest: number): { width: number; height: number; scale: number } => {
  const scale = longest / Math.max(sheet.tileWidth, sheet.tileHeight);
  return { width: Math.round(sheet.tileWidth * scale), height: Math.round(sheet.tileHeight * scale), scale };
};

/**
 * The background that shows one tile of the sheet at `url` in a box of the preview's size.
 *
 * Only the sheet's width is given; its height follows from the image's own shape, so the rows
 * need not be known.
 */
export const tileBackground = (url: string, sheet: Storyboard, seconds: number, scale: number): Record<string, string> => {
  const { x, y } = storyboardTile(sheet, seconds);
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: `${sheet.columns * sheet.tileWidth * scale}px auto`,
    backgroundPosition: `${-x * scale}px ${-y * scale}px`,
    backgroundRepeat: 'no-repeat',
  };
};

/** Where a preview `width` wide sits, centred on `x` and held inside a bar `barWidth` wide. */
export const previewLeft = (x: number, width: number, barWidth: number): number => Math.min(Math.max(x - width / 2, 0), Math.max(barWidth - width, 0));

/**
 * Where the whole sheet goes, as an image under a square window `size` pixels wide, for the tile
 * at `seconds` to fill the window: scaled by its shorter side, centred, its neighbours outside.
 * A pixel over the window's size keeps a neighbour's edge from showing through the rounding.
 */
export const coverTile = (sheet: Storyboard, seconds: number, size: number): { width: number; left: number; top: number } => {
  const scale = (size + 1) / Math.min(sheet.tileWidth, sheet.tileHeight);
  const { x, y } = storyboardTile(sheet, seconds);
  return {
    width: sheet.columns * sheet.tileWidth * scale,
    left: (size - sheet.tileWidth * scale) / 2 - x * scale,
    top: (size - sheet.tileHeight * scale) / 2 - y * scale,
  };
};

/** One time for each tile from `start` to `end`, in order: the frames a stretch of the video shows. */
export const tileTimes = (sheet: Storyboard, start: number, end: number): number[] => {
  const first = storyboardTile(sheet, start).index;
  const last = storyboardTile(sheet, Math.max(start, end)).index;
  return Array.from({ length: last - first + 1 }, (_, i) => (first + i) * sheet.interval);
};
