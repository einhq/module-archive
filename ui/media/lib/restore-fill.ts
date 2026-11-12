import { fileUrl, shq, uuidv4 } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { FileRestoreAnswer } from '@media/api';
import { type MaskStroke, renderMask } from './restore-mask.ts';

/**
 * A restored copy of the picture at `path` with what `strokes` mark filled: the mask is drawn at
 * the picture's stored size — over `base`, a mask of that size, when given — written to `/tmp`
 * for `file-restore --mask`, with `flags` for its other steps, and removed again.
 */
export const fillPainted = async (opts: {
  path: string;
  /** The picture's stored size; a `base` gives its own. */
  width?: number;
  height?: number;
  angle: number;
  mirror: boolean;
  base?: string;
  strokes: MaskStroke[];
  flags: string[];
}): Promise<FileRestoreAnswer> => {
  let { width, height } = opts;
  let base: HTMLImageElement | undefined;
  if (opts.base) {
    base = new Image();
    base.src = opts.base;
    await base.decode().catch(() => {
      throw new Error('the marks could not be read');
    });
    width = base.naturalWidth;
    height = base.naturalHeight;
  }
  if (!width || !height) throw new Error('the size of the picture is not known');
  const mask = await renderMask({ width, height, angle: opts.angle, mirror: opts.mirror, base, strokes: opts.strokes });
  const temp = `/tmp/restore-mask-${uuidv4()}.png`;
  const res = await fetch(fileUrl(temp), { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: mask });
  if (!res.ok) throw new Error(`could not write the mask (${res.status})`);
  try {
    return await execCommand<FileRestoreAnswer>(`file-restore ${shq(opts.path)} ${opts.flags.map(shq).join(' ')} --mask ${shq(temp)}`);
  } finally {
    await execCommand(`rm -f ${shq(temp)}`).catch(() => {});
  }
};
