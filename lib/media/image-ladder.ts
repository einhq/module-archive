/**
 * The still-image ladder: every AVIF size a photo, a video's poster frame or a recording's
 * waveform gets, staged, validated and published as one unit.
 *
 * EMS does the decoding and the encoding (`image.renditions`, `video.poster`,
 * `audio.waveform`); this side owns the nodes. Each output is created as a hidden temp
 * sibling of its final path, EMS writes its bytes there, `file-sync`'s job is done through
 * `statX`, and only once every output has bytes are the temps renamed over the finals. An
 * interrupted run — container restart, OOM kill, a stopped worker — therefore never leaves a
 * final path holding a partial file, and a failed re-run leaves the old rendition servable; the
 * temps such a run leaves behind are swept by the next run into the same directory.
 */
import type { Command } from '@ein/client';
import { dirname } from '@std/path';
import { poster, type RenditionFit, renditions, type RenditionTarget, waveform } from '@ems/client';
import { normalizeAngle, normalizeMirror } from '@archive/media/orientation';
import { removeNode, sweepStaleTemps, syncNonEmpty } from '@archive/media/staging';

export type ImageLadderTarget = {
  outputPath: string;
  width: number;
  height: number;
  mode?: string;
  quality?: number;
};

type ImageLadderSource = {
  path: string;
  id: string;
  mimetype: string;
  angle: unknown;
  mirror: unknown;
};

/**
 * How a waveform is drawn: the UI's own theme tokens, so a waveform tile sits on the same
 * ground as every photo tile beside it —
 *
 *   #4a90f0 marine[4]  the envelope, the app's accent
 *   #0a0b0e dark[9]    --mrx-media-bg, the deepest surface in the app
 *   #2b70d6 marine[5]  the baseline, a step darker so it reads under the wave
 *
 * — and the banner shape a `contain` waveform is drawn at, which the UI's grid also knows as
 * `WAVEFORM_ASPECT` so an audio tile lays out at its final shape before the picture decodes.
 * The two must change together.
 */
export const WAVEFORM_STYLE = { foreground: '#4a90f0', background: '#0a0b0e', baseline: '#2b70d6', aspect: 3 };

type StagedTarget = ImageLadderTarget & { tempName: string; tempPath: string };

const TEMP_PREFIX = '.tmpimage-';

const FITS: ReadonlySet<string> = new Set(['contain', 'cover', 'fill']);

const positive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * What EMS is asked for, per target. `cover` is the default fit for a target that names
 * none; AVIF throughout, at the ladder's quality unless the size says.
 */
export const renditionTarget = (target: ImageLadderTarget, output: string): RenditionTarget => {
  const box = { width: positive(target.width), height: positive(target.height) };
  return {
    output,
    format: 'avif',
    ...(target.quality !== undefined ? { quality: target.quality } : {}),
    ...(box.width || box.height ? { box } : {}),
    fit: (FITS.has(target.mode ?? '') ? target.mode : 'cover') as RenditionFit,
  };
};

/**
 * Build a still-image ladder from one decode, stage all files, validate them, then publish.
 * Existing final renditions remain untouched if conversion or validation fails.
 */
export const generateImageLadder = async (
  cmd: Command,
  source: ImageLadderSource,
  targets: ReadonlyArray<ImageLadderTarget>,
): Promise<string[]> => {
  if (targets.length === 0) return [];
  const destDir = dirname(targets[0].outputPath);
  const staged: StagedTarget[] = [];
  await sweepStaleTemps(cmd, destDir, TEMP_PREFIX);

  try {
    for (const target of targets) {
      if (dirname(target.outputPath) !== destDir) throw new Error('all image ladder outputs must share a directory');
      const tempName = `${TEMP_PREFIX}${crypto.randomUUID()}.avif`;
      const tempPath = `${destDir}/${tempName}`;
      await cmd.sys.vfs.create(cmd.access, 'file', destDir, tempName, { attrs: { sourceId: source.id } });
      staged.push({ ...target, tempName, tempPath });
    }

    const wanted = staged.map((target) => renditionTarget(target, target.tempPath));
    const angle = normalizeAngle(source.angle);
    const mirror = normalizeMirror(source.mirror);
    const common = { mimetype: source.mimetype, targets: wanted };

    if (source.mimetype.startsWith('video/')) {
      // EMS takes it a second in, past the black leader most cameras record, or the first frame
      // when the picture is shorter than that.
      await poster(cmd, source.path, { ...common, angle, mirror });
    } else if (source.mimetype.startsWith('audio/')) {
      await waveform(cmd, source.path, { ...common, style: WAVEFORM_STYLE });
    } else {
      await renditions(cmd, source.path, { ...common, angle, mirror });
    }

    // Validate every staged output before replacing any currently servable rendition.
    for (const target of staged) await syncNonEmpty(cmd, target.tempPath, 'image conversion');

    for (const target of staged) {
      if (await cmd.sys.vfs.exists(cmd.access, target.outputPath)) {
        await cmd.sys.vfs.unlink(cmd.access, target.outputPath, destDir, { recursive: true });
      }
      const finalName = target.outputPath.slice(destDir.length + 1);
      await cmd.sys.vfs.rename(cmd.access, destDir, target.tempName, destDir, finalName, { failIfExists: true });
    }
    return targets.map((target) => target.outputPath);
  } finally {
    for (const target of staged) await removeNode(cmd, target.tempPath, destDir);
  }
};
