/**
 * The transcoded renditions — a video's playable mp4s and a recording's m4a — as nodes.
 *
 * EMS does the encoding (`video.transcode`, `audio.transcode`: the GPU/CPU ladder, the
 * projected CPU-decode budget, the windowed encode, the audio ceilings); this side owns the
 * node. The output is created as a hidden temp sibling of its final path, EMS writes its bytes
 * there, the size is checked, and only then is the temp renamed over the final — so an
 * interrupted encode (container restart, OOM kill, a stopped worker) never leaves the final path
 * holding a partial file, and a failed re-encode leaves the old rendition playable; the temps
 * such an encode leaves behind are swept by the next one into the same directory.
 *
 * A **refusal** is not a failure: EMS answers `refused` (permanent) when a source cannot be
 * encoded on the CPU within its budget and cannot be split into windows. The temp is dropped
 * and the reason handed back, for `generate-derivatives` to record on the file node so
 * `media-scan` stops announcing a gap nothing on this EMS is going to close.
 */
import type { Command } from '@ein/client';
import { dirname } from '@std/path';
import { EmsError, transcodeAudio, transcodeVideo } from '@ems/client';
import { normalizeAngle, normalizeMirror } from '@archive/media/orientation';
import { removeNode, sweepStaleTemps, syncNonEmpty } from '@archive/media/staging';

type TranscodeSource = {
  path: string;
  id: string;
  mimetype: string;
  angle?: unknown;
  mirror?: unknown;
  /** ffmpeg's name for the picture codec, off the node (`codec`), when known. */
  codec?: string;
};

export type VideoRendition = {
  kind: 'video';
  outputPath: string;
  width: number;
  height: number;
  crf?: number;
  preset?: number | string;
  audioBitrate?: string;
  mute?: boolean;
  start?: number;
  seconds?: number;
};

export type AudioRendition = {
  kind: 'audio';
  outputPath: string;
  bitrate?: string;
  sampleRate?: number;
};

type TranscodeOutcome =
  | { made: string; producer: string }
  | { refused: string };

const positive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Make one transcoded rendition: stage it, have EMS write it, validate it, publish it.
 *
 * Returns what was made, or the reason EMS refused. Anything else — EMS unreachable, an encode
 * that failed — throws, which is the retryable outcome and the caller's pipeline handles it.
 */
export const writeTranscode = async (cmd: Command, source: TranscodeSource, target: VideoRendition | AudioRendition): Promise<TranscodeOutcome> => {
  const destDir = dirname(target.outputPath);
  const finalName = target.outputPath.slice(destDir.length + 1);
  const prefix = target.kind === 'video' ? '.tmpvideo-' : '.tmpaudio-';
  const tempName = `${prefix}${crypto.randomUUID()}.${target.kind === 'video' ? 'mp4' : 'm4a'}`;
  const tempPath = `${destDir}/${tempName}`;
  await sweepStaleTemps(cmd, destDir, prefix);
  await cmd.sys.vfs.create(cmd.access, 'file', destDir, tempName, { attrs: { sourceId: source.id } });

  try {
    let producer: string;
    try {
      if (target.kind === 'video') {
        const preset = positive(target.preset);
        const made = await transcodeVideo(cmd, source.path, {
          output: tempPath,
          angle: normalizeAngle(source.angle),
          mirror: normalizeMirror(source.mirror),
          mimetype: source.mimetype,
          box: { width: target.width, height: target.height },
          ...(target.crf !== undefined ? { quality: target.crf } : {}),
          ...(preset !== undefined ? { speed: preset } : {}),
          // A muted rendition drops the sound; otherwise the bitrate is the size's, or EMS's default.
          audioBitrate: target.mute ? null : target.audioBitrate,
          ...(target.start !== undefined || target.seconds !== undefined
            ? { clip: { ...(target.start !== undefined ? { start: target.start } : {}), ...(target.seconds !== undefined ? { duration: target.seconds } : {}) } }
            : {}),
          ...(source.codec ? { sourceCodec: source.codec } : {}),
        });
        producer = made.producer;
      } else {
        const made = await transcodeAudio(cmd, source.path, {
          output: tempPath,
          mimetype: source.mimetype,
          ...(target.bitrate ? { bitrate: target.bitrate } : {}),
          ...(target.sampleRate ? { sampleRate: target.sampleRate } : {}),
        });
        producer = made.producer;
      }
    } catch (error) {
      if (error instanceof EmsError && error.code === 'refused') return { refused: error.detail };
      throw error;
    }

    await syncNonEmpty(cmd, tempPath, 'transcode');
    if (await cmd.sys.vfs.exists(cmd.access, target.outputPath)) {
      await cmd.sys.vfs.unlink(cmd.access, target.outputPath, destDir, { recursive: true });
    }
    await cmd.sys.vfs.rename(cmd.access, destDir, tempName, destDir, finalName, { failIfExists: true });
    return { made: target.outputPath, producer };
  } finally {
    await removeNode(cmd, tempPath, destDir);
  }
};
