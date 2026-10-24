/**
 * A video's storyboard as a node: its frames at an even interval, tiled into one AVIF sheet under
 * `thumbnails/` beside the renditions, for the frame the player's timeline shows under the pointer.
 *
 * EMS makes the sheet (`video.storyboard`) from the playable rendition rather than the original:
 * the rendition is upright, it is the timeline the player plays, and turning a video re-makes it,
 * after which the sheet is made again. This side owns the node, staged as a transcode is: a hidden
 * temp sibling EMS writes into, checked for bytes, then renamed over the final name. How to cut
 * the sheet into tiles is kept on the node itself (`STORYBOARD_ATTR`).
 */
import type { Command } from '@ein/client';
import { dirname } from '@std/path';
import { videoStoryboard } from '@ems/client';
import { removeNode, sweepStaleTemps, syncNonEmpty } from '@archive/media/staging';

/** The attr on a sheet's node that says how to read it. */
export const STORYBOARD_ATTR = 'storyboard';

/** How to read a sheet: tile `i` is the frame at `i × interval` seconds, laid out row by row. */
export type StoryboardGeometry = {
  interval: number;
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
};

/** A sheet is named by its tile size, as a rendition is by its box. */
export const storyboardName = (tile: number): string => `storyboard-${tile}.avif`;

/** Whether a name under `thumbnails/` is a storyboard sheet. */
export const isStoryboardName = (name: string): boolean => /^storyboard-\d+\.avif$/.test(name);

/** What a sheet is made of, from sizes.yaml's `storyboard`. */
export type StoryboardSpec = { tile: number; columns?: number; maxTiles?: number; minInterval?: number; quality?: number };

const TEMP_PREFIX = '.tmpstoryboard-';

/**
 * Make the sheet of the video whose rendition is at `rendition`, as `outputPath`.
 *
 * Any other sheet in the directory goes with it, so a changed tile size leaves only the new one.
 * A failure throws, as a transcode's does, and leaves the old sheet in place.
 */
export const writeStoryboard = async (
  cmd: Command,
  source: { id: string; rendition: string },
  outputPath: string,
  spec: StoryboardSpec,
): Promise<{ made: string; producer: string }> => {
  const destDir = dirname(outputPath);
  const finalName = outputPath.slice(destDir.length + 1);
  const tempName = `${TEMP_PREFIX}${crypto.randomUUID()}.avif`;
  const tempPath = `${destDir}/${tempName}`;
  await sweepStaleTemps(cmd, destDir, TEMP_PREFIX);
  await cmd.sys.vfs.create(cmd.access, 'file', destDir, tempName, { attrs: { sourceId: source.id } });

  try {
    const sheet = await videoStoryboard(cmd, source.rendition, {
      output: tempPath,
      tile: spec.tile,
      ...(spec.columns !== undefined ? { columns: spec.columns } : {}),
      ...(spec.maxTiles !== undefined ? { maxTiles: spec.maxTiles } : {}),
      ...(spec.minInterval !== undefined ? { minInterval: spec.minInterval } : {}),
      ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
    });
    await syncNonEmpty(cmd, tempPath, 'storyboard');
    const geometry: StoryboardGeometry = {
      interval: sheet.interval,
      count: sheet.count,
      columns: sheet.columns,
      rows: sheet.rows,
      tileWidth: sheet.tileWidth,
      tileHeight: sheet.tileHeight,
    };
    await cmd.sys.vfs.update(cmd.access, tempPath, { attrs: { [STORYBOARD_ATTR]: geometry } });
    for (const child of await cmd.sys.vfs.children(cmd.access, destDir)) {
      if (isStoryboardName(child.name)) await cmd.sys.vfs.unlink(cmd.access, `${destDir}/${child.name}`, destDir, { recursive: true });
    }
    await cmd.sys.vfs.rename(cmd.access, destDir, tempName, destDir, finalName, { failIfExists: true });
    return { made: outputPath, producer: sheet.producer };
  } finally {
    await removeNode(cmd, tempPath, destDir);
  }
};
