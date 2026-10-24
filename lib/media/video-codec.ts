/**
 * The codec of a video's picture stream, as ffmpeg names it, read off an exiftool dump.
 *
 * The point is to answer "can NVDEC decode this?" without a probe: the transcoder is handed it
 * as `sourceCodec`, and a source NVDEC has no decoder for cannot succeed on the GPU path, so
 * without the hint that attempt is spent before the fallback starts, once per rendition.
 *
 * An `ffprobe` per video would cost a spawn on every file to save a doomed attempt on a few, so
 * the codec comes out of the exiftool run `exif-extract` already does. (A probe does run for the
 * containers whose dump names no pixel aspect ratio — see `sarFromExifRaw` — and where one runs,
 * its decoder name is preferred to this map.) Three keys carry it, none of them everywhere:
 *
 *   AVI       VideoCodec / Compression   the stream header's fourcc: mjpg, dvsd, XVID
 *   MOV/MP4   CompressorID               the sample description: avc1, apch, s263
 *   MPEG-PS   nothing                    exiftool reports no codec at all
 *
 * so this returns `undefined` for anything it cannot name, and every caller must treat that as
 * "unknown", never as "fine": the transcoder keeps its try-and-fall-back behaviour there, which
 * is exactly what an MPEG program stream (mpeg2video, NVDEC decodes it) needs.
 *
 * The mimetype gate is load-bearing, the same way it is for `raw.Rotation`: `raw` is an
 * *ungrouped* dump, and on a still `Compression` is the JPEG/TIFF compression scheme
 * ("JPEG (old-style)", or the number 6) rather than a fourcc. Reading it there would write a
 * nonsense codec onto every scanned image in the library.
 */

/**
 * fourcc (lowercased) -> ffmpeg codec name.
 *
 * Only names that appear in the corpus, plus the ProRes siblings of the one that does — an
 * unmapped fourcc costs a doomed GPU attempt, while a *wrongly* mapped one could push a
 * decodable source onto the CPU for good.
 *
 * `dsvd` is not a typo here: cameras write DV's `dvsd` transposed and exiftool reports what it
 * finds.
 */
const FOURCC_TO_CODEC: Record<string, string> = {
  avc1: 'h264',
  h264: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  av01: 'av1',
  mp4v: 'mpeg4',
  xvid: 'mpeg4',
  divx: 'mpeg4',
  dx50: 'mpeg4',
  fmp4: 'mpeg4',
  div3: 'msmpeg4v3',
  div4: 'msmpeg4v3',
  mp43: 'msmpeg4v3',
  dvsd: 'dvvideo',
  dsvd: 'dvvideo',
  dvc: 'dvvideo',
  dv: 'dvvideo',
  mjpg: 'mjpeg',
  jpeg: 'mjpeg',
  apch: 'prores',
  apcn: 'prores',
  apcs: 'prores',
  apco: 'prores',
  ap4h: 'prores',
  ap4x: 'prores',
  s263: 'h263',
  h263: 'h263',
};

/**
 * Name a video's picture codec from an ungrouped exiftool dump, or `undefined` when the dump
 * carries no fourcc this knows — including for every non-video file, whatever it says.
 */
export function videoCodecFromExifRaw(raw: Record<string, unknown>): string | undefined {
  const mimetype = raw.MIMEType;
  if (typeof mimetype !== 'string' || !mimetype.startsWith('video/')) return undefined;

  // VideoCodec first: an AVI carries both it and `Compression`, and `Compression` is the one
  // that is sometimes a description rather than a fourcc. CompressorID is the MOV/MP4 spelling
  // and never collides with either.
  for (const key of ['VideoCodec', 'CompressorID', 'Compression']) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const codec = FOURCC_TO_CODEC[value.trim().toLowerCase()];
    if (codec) return codec;
  }

  return undefined;
}
