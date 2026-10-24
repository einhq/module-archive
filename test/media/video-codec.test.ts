/**
 * Naming a video's codec from the exiftool dump `exif-extract` already has.
 *
 * The consumer is the transcoder in EMS: a source NVDEC has no decoder for cannot succeed on
 * the GPU path, and the codec is what lets it start on the CPU instead. So the two failure
 * directions are not symmetric — `undefined` costs a doomed GPU attempt, while a *wrong* name
 * could push a decodable source onto the CPU for good.
 *
 * Every raw dump below has the shape of a real one.
 */

import { assertEquals } from '@std/assert';
import { videoCodecFromExifRaw } from '../../lib/media/video-codec.ts';

Deno.test('an AVI names its codec in VideoCodec', () => {
  // ein/core#64
  assertEquals(
    videoCodecFromExifRaw({ MIMEType: 'video/x-msvideo', VideoCodec: 'mjpg', Compression: 'MJPG' }),
    'mjpeg',
  );
});

Deno.test('an AVI with an empty VideoCodec falls through to Compression', () => {
  // DV files carry exactly this shape.
  assertEquals(
    videoCodecFromExifRaw({ MIMEType: 'video/x-msvideo', VideoCodec: '', Compression: 'dvsd' }),
    'dvvideo',
  );
});

Deno.test('dsvd is DV as well — the fourcc is transposed in the wild', () => {
  assertEquals(
    videoCodecFromExifRaw({ MIMEType: 'video/x-msvideo', VideoCodec: 'dsvd', Compression: 'dvsd' }),
    'dvvideo',
  );
});

Deno.test('MOV and MP4 name it in CompressorID', () => {
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/mp4', CompressorID: 'avc1' }), 'h264');
  assertEquals(
    videoCodecFromExifRaw({ MIMEType: 'video/quicktime', CompressorID: 'apch', CompressorName: 'Apple ProRes 422 (HQ)' }),
    'prores',
  );
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/3gpp', CompressorID: 's263' }), 'h263');
});

Deno.test('MPEG-4 part 2 and its Microsoft variant are different codecs', () => {
  // NVDEC decodes mpeg4 and fails on msmpeg4v3, so these must not collapse
  // into one family.
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/x-msvideo', VideoCodec: 'XVID', Compression: 'XVID' }), 'mpeg4');
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/x-msvideo', VideoCodec: 'div4', Compression: 'DIV3' }), 'msmpeg4v3');
});

Deno.test('a container that names no codec stays unknown', () => {
  // MPEG program streams and AVCHD. `exif-extract` gets these from the
  // ffprobe it already runs for their duration; anything left over falls back to trying.
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/mpeg', Duration: 3.48 }), undefined);
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/m2ts' }), undefined);
  // An unmapped fourcc is unknown too, rather than guessed at.
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'video/x-msvideo', VideoCodec: 'iv50' }), undefined);
});

Deno.test('a still is never read for a codec, whatever keys it carries', () => {
  // `raw` is an ungrouped dump: on a JPEG, `Compression` is the image compression scheme, not
  // a fourcc. The same gate `raw.Rotation` needs, for the same reason.
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'image/jpeg', Compression: 'JPEG (old-style)' }), undefined);
  assertEquals(videoCodecFromExifRaw({ MIMEType: 'image/tiff', Compression: 'JPEG' }), undefined);
  assertEquals(videoCodecFromExifRaw({ Compression: 'MJPG' }), undefined);
});
