/**
 * `resolveMediaFacts` over the stream probe EMS's `media.probe` hands back. Pure: no ffprobe,
 * no EMS — the dumps are written out as ffprobe writes them.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { resolveMediaFacts, type StreamProbe } from '../../lib/media/media-probe.ts';

const video = (stream: Record<string, unknown>, format: Record<string, unknown> = {}): StreamProbe => ({
  ffprobe: { format, streams: [{ codec_type: 'video', ...stream }, { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }] },
});

Deno.test('video keeps a valid exiftool duration without consulting the probe', () => {
  assertEquals(resolveMediaFacts(undefined, 'video/mp4', 12.5), { duration: 12.5 });
  assertEquals(resolveMediaFacts({ refusal: 'moov atom not found' }, 'video/mp4', 12.5), { duration: 12.5 });
});

Deno.test('video falls back to a validated ffprobe format duration, and takes the codec with it', () => {
  // An MPEG program stream is the container exiftool names no codec for, so the probe — which is
  // consulted only because exiftool had no duration either — is where its codec comes from.
  assertEquals(resolveMediaFacts(video({ codec_name: 'mpeg2video' }, { duration: '3.480000' }), 'video/mpeg', undefined), {
    codec: 'mpeg2video',
    duration: 3.48,
  });
  // Video facts never carry sound-stream numbers; those are the audio branch's.
  assertEquals('channels' in resolveMediaFacts(video({ codec_name: 'h264' }, { duration: '1' }), 'video/mp4', undefined), false);
});

Deno.test('a video whose dump could not name the pixel shape is measured for it', () => {
  // The `.MTS` case: exiftool reports the coded 1440x1080 and no ratio at all, so the picture's
  // shape exists nowhere but in the stream. `sar` comes back reduced against the raster the node
  // stores — 4:3 here, because those are the same raster.
  const probe = video({ codec_name: 'h264', width: 1440, height: 1080, sample_aspect_ratio: '4:3' }, { duration: '9.5' });
  const facts = resolveMediaFacts(probe, 'video/m2ts', 9.5, { width: 1440, height: 1080 });
  assertAlmostEquals(facts.sar!, 4 / 3, 1e-6);
  // exiftool had a duration, so it stays the one that counts even though the probe was read.
  assertEquals(facts.duration, 9.5);
});

Deno.test('a probe against the display frame stores no ratio, because it is already applied', () => {
  // The stream is 480x360 at SAR 4:3, but exiftool read the track header and stored 640x360,
  // which *is* the picture. Storing 4:3 on top of that would paint a 16:9 clip at 2.37:1.
  const probe = video({ codec_name: 'h264', width: 480, height: 360, sample_aspect_ratio: '4:3' }, { duration: '1' });
  assertEquals(resolveMediaFacts(probe, 'video/mp4', undefined, { width: 640, height: 360 }).sar, undefined);
});

Deno.test('a square-pixel stream comes back with no ratio at all', () => {
  const square = video({ codec_name: 'h264', width: 320, height: 240, sample_aspect_ratio: '1:1' }, { duration: '1' });
  assertEquals(resolveMediaFacts(square, 'video/x-msvideo', 1, { width: 320, height: 240 }).sar, undefined);
  // `N/A` is what ffprobe answers for a stream that declares nothing, and means the same thing.
  const na = video({ codec_name: 'mjpeg', width: 320, height: 240, sample_aspect_ratio: 'N/A' }, { duration: '1' });
  assertEquals(resolveMediaFacts(na, 'video/x-msvideo', 1, { width: 320, height: 240 }).sar, undefined);
});

Deno.test('a refused shape-only consultation answers with no ratio, not with an undecodable mark', () => {
  // The mark stops media-stills, media-transcode, media-fingerprint and media-transcribe from ever
  // touching the file again. A probe read only to learn a pixel shape has no business making that
  // call: exiftool read a duration out of the same bytes, and the layout hint is optional.
  assertEquals(resolveMediaFacts({ refusal: 'Invalid data found when processing input' }, 'video/m2ts', 9.5, { width: 1440, height: 1080 }), { duration: 9.5 });
});

Deno.test('audio gets stream facts and fallback duration from the same probe', () => {
  const probe: StreamProbe = {
    ffprobe: { format: { duration: '4.023220' }, streams: [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 1, bit_rate: 'N/A' }] },
  };
  assertEquals(resolveMediaFacts(probe, 'audio/mp4', undefined), { codec: 'aac', sampleRate: 44100, channels: 1, duration: 4.02322 });
});

Deno.test('a refused probe answers with the reason the container is unreadable, not an error', () => {
  // ffprobe parses the container before it looks at a stream, so a refusal means it never found
  // the track table — the truncated-MOV case. That is a permanent property of the bytes, and
  // `exif-extract` promotes it so the media pipelines skip rather than retry three times. EMS has
  // already reduced the refusal to its diagnostic, path and component prefix taken off.
  assertEquals(resolveMediaFacts({ refusal: 'moov atom not found' }, 'video/quicktime', 0), { undecodable: 'moov atom not found' });
  assertEquals(resolveMediaFacts({ refusal: '' }, 'video/quicktime', undefined), { undecodable: 'ffprobe refused the file' });
});

Deno.test('an unreadable audio container keeps the duration exiftool did measure', () => {
  assertEquals(resolveMediaFacts({ refusal: 'Invalid data found when processing input' }, 'audio/x-wav', 3.2), {
    undecodable: 'Invalid data found when processing input',
    duration: 3.2,
  });
});
