/**
 * A file's metadata, from EMS.
 *
 * `media.probe` runs exiftool (a stay-open pool there) and ffprobe for every video and audio
 * file, and hands back a normalized core with the tools' own dumps attached. What this module
 * keeps is the shape the rest of the media area reads: the exiftool dump as the one-element
 * array `exiftool -n -j` writes — every tag name in `types/exif.ts`, `exif-date.ts` and
 * `video-codec.ts` is exiftool's — and the stream probe `resolveMediaFacts` consumes.
 */

import type { Command } from '@ein/client';
import { probe, type ProbeResult } from '@ems/client';
import type { StreamProbe } from '@archive/media/media-probe';

/** One `media.probe`, with both tools' dumps. */
export async function probeFile(cmd: Command, vfsPath: string, mimetype?: string): Promise<ProbeResult> {
  return await probe(cmd, vfsPath, { mimetype, raw: ['exiftool', 'ffprobe'] });
}

/** The ungrouped numeric JSON array `exiftool -n -j` prints. */
export async function extractExif(cmd: Command, vfsPath: string): Promise<Record<string, unknown>[]> {
  const result = await probe(cmd, vfsPath, { raw: ['exiftool'] });
  return [result.raw.exiftool ?? {}];
}

/** The stream half of a probe, in the shape `resolveMediaFacts` reads. */
export const streamProbeOf = (result: ProbeResult): StreamProbe | undefined => {
  if (result.raw.ffprobe) return { ffprobe: result.raw.ffprobe };
  if (!result.decodable) return { refusal: result.reason };
  return undefined;
};
