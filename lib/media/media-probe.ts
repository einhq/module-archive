import { type Dims, isAnamorphic, normalizeSar, sarForRaster } from '@archive/media/orientation';

type MediaFacts = {
  duration?: number;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  /**
   * Pixel aspect ratio of the raster the *caller* holds, when it is not 1.
   *
   * Measured only when `resolveMediaFacts` is given a raster to measure against, which is
   * `exif-extract` saying "exiftool could not tell me this container's shape". See
   * `sarForRaster`, which defines what the number is relative to, and `pictureDims`, which is
   * every consumer's one use for it.
   */
  sar?: number;
  /**
   * Why the container could not be opened at all, when that is the answer.
   *
   * Set only when ffprobe refuses the file outright — a truncated MOV whose `moov` atom was
   * never written is the corpus case (ein/core#145).
   * ffprobe exits 0 on a container it can parse but holds a codec it cannot decode, so a
   * non-zero exit here means the index itself is unreadable and no decoder will ever get a
   * frame out of the file. That is a permanent property of the bytes, not a transient error,
   * and `exif-extract` promotes it onto the file node so the pipelines can skip rather than
   * retry. See UNDECODABLE_ATTR.
   */
  undecodable?: string;
};

/**
 * File-node attr naming a source whose container cannot be read.
 *
 * Written by `exif-extract` (and cleared by it on a re-index that succeeds), read by the
 * `skipIfAttr` on media-stills / media-transcode / media-fingerprint / media-transcribe, by
 * `generate-derivatives` and `compute-fingerprint` when invoked directly, and by the lightbox
 * so it does not offer a player for a file nothing can decode.
 */
export const UNDECODABLE_ATTR = 'undecodable';

/** ffprobe's `-show_format -show_streams` JSON, as EMS's `media.probe` hands it back under `raw.ffprobe`. */
type FfprobeJson = { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };

/**
 * What one `media.probe` said about a file's streams: the ffprobe dump when the container could
 * be opened, or the one-line refusal when it could not. EMS has already reduced the refusal to
 * the demuxer's diagnostic (`moov atom not found`) with the component prefix and the store path
 * taken off, which is what reaches the lightbox.
 */
export type StreamProbe = { ffprobe?: FfprobeJson; refusal?: string };

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

const firstStream = (probe: FfprobeJson | undefined, codecType: 'audio' | 'video'): Record<string, unknown> | undefined =>
  probe?.streams?.find((stream) => stream.codec_type === codecType);

/**
 * Facts off the probe, for the first stream of the kind asked for.
 *
 * ffprobe uses "N/A" for facts the selected stream or container cannot measure. Every numeric
 * result is validated here so an unusable sentinel never becomes a hot file attr.
 *
 * `raster` adds the pixel shape: the *coded* frame ffprobe measures and the ratio the stream
 * declares, reduced against the raster the node actually stores — the SAR alone means nothing.
 */
function factsOf(probe: StreamProbe, audioStream: boolean, raster?: Partial<Dims>): MediaFacts {
  // A refusal is not "no facts", it is "this container has no readable index". ffprobe parses
  // the container before it looks at any stream, so it still succeeds on a file whose codec it
  // cannot decode; a refusal means it could not find the track table at all.
  if (probe.ffprobe === undefined) {
    return { undecodable: probe.refusal || 'ffprobe refused the file' };
  }

  const format = probe.ffprobe.format ?? {};
  const stream = firstStream(probe.ffprobe, audioStream ? 'audio' : 'video') ?? {};

  const facts: MediaFacts = {};
  const duration = positive(format.duration);
  const bitrate = positive(stream.bit_rate);
  const sampleRate = positive(stream.sample_rate);
  const channels = positive(stream.channels);
  const codec = stream.codec_name;
  if (duration !== undefined) facts.duration = duration;
  if (audioStream) {
    if (bitrate !== undefined) facts.bitrate = bitrate;
    if (sampleRate !== undefined) facts.sampleRate = sampleRate;
    if (channels !== undefined) facts.channels = channels;
  }
  if (typeof codec === 'string' && codec && codec !== 'N/A') facts.codec = codec;

  // The pixel shape, reduced against the raster the caller holds rather than reported raw:
  // exiftool's `width`/`height` are the display frame for one container family and the coded
  // frame for another, and only the ratio *between* them can be applied blindly downstream
  // (`sarForRaster`). Written only when it says something — a stream that declares no ratio
  // reports `1:1`, and one that declares nothing usable reports `N/A`, both of which
  // `normalizeSar` reads as square.
  if (raster) {
    const codedWidth = positive(stream.width);
    const codedHeight = positive(stream.height);
    const ratio = normalizeSar(typeof stream.sample_aspect_ratio === 'string' ? stream.sample_aspect_ratio : undefined);
    if (codedWidth !== undefined && codedHeight !== undefined) {
      const picture = ratio >= 1 ? { width: codedWidth * ratio, height: codedHeight } : { width: codedWidth, height: codedHeight / ratio };
      const sar = sarForRaster(picture, raster);
      if (isAnamorphic(sar)) facts.sar = sar;
    }
  }
  return facts;
}

/**
 * Resolve normalized media facts with exiftool as the primary source.
 *
 * `probe` is what EMS's `media.probe` measured about the streams — it runs ffprobe for every
 * video and audio file, so the dump is already in hand and this costs no spawn. Audio always
 * takes its stream facts from it. Video takes from it only what the exiftool dump left open,
 * and there are two such questions:
 *
 *   - **no valid duration** — the MPEG program-stream path, and any future container with the
 *     same incomplete metadata, without a mimetype allow-list; and
 *   - **`unmeasuredRaster`** — the caller could not work out the pixel shape from the dump
 *     either, so the picture's aspect ratio exists nowhere but in the stream. Pass the raster
 *     the node stores; the answer comes back as `sar`, relative to it.
 *
 * The second is what an `.MTS` needs and what an `.MP4` does not: exiftool reads a QuickTime
 * track header, which already carries the ratio, so `sarFromExifRaw` answers for the bulk of
 * the corpus's videos and the probe is never consulted for them.
 *
 * A probe consulted *for a duration* that was refused comes back carrying `undecodable` and
 * nothing else — the one answer a caller must not treat as "no facts this time". A probe
 * consulted only for the shape never sets that mark; see the branch below for why.
 */
export function resolveMediaFacts(
  probe: StreamProbe | undefined,
  mimetype: string,
  exifDuration: number | undefined,
  unmeasuredRaster?: Partial<Dims>,
): MediaFacts {
  const duration = positive(exifDuration);
  const measured: StreamProbe = probe ?? { refusal: 'no stream probe' };

  if (mimetype.startsWith('audio/')) {
    const probed = factsOf(measured, true);
    return { ...probed, duration: duration ?? probed.duration };
  }

  if (mimetype.startsWith('video/') && (duration === undefined || unmeasuredRaster !== undefined)) {
    const probed = factsOf(measured, false, unmeasuredRaster);
    if (duration === undefined) return probed;
    // A probe consulted only for the shape must not throw away a duration exiftool did measure —
    // that one stays authoritative, exactly as it is when the probe is never consulted — and must
    // not mark the file undecodable either. The mark stops four pipelines from ever touching a
    // file again, and this consultation exists for a layout hint: if the probe refused, the
    // answer is "no ratio", not "nothing can read this". A file whose duration ffprobe *was*
    // needed for is still marked, which is where the mark came from and the only place it is a
    // measurement.
    const { undecodable: _refusal, ...facts } = probed;
    return { ...facts, duration };
  }

  return duration === undefined ? {} : { duration };
}
