/**
 * Media fixtures for the container E2E tier.
 *
 * Committed under `fixtures/` and staged into a temp directory per run, rather than generated
 * at test time: the EiN image has no media tools — exiftool, ImageMagick and ffmpeg
 * all live in EMS — so nothing here could make them. `fixtures/make-fixtures.sh` is the recipe
 * they were made with, run inside the EMS container; the numbers below are the ones it bakes in.
 */

import type { Command } from '@ein/client';
import { dirname, fromFileUrl, join } from '@std/path';

const FIXTURES_DIR = join(dirname(fromFileUrl(import.meta.url)), 'fixtures');

export type MediaFixtures = {
  dir: string;
  /** JPEG with EXIF DateTimeOriginal + GPS (Stockholm) — see `PHOTO` */
  jpeg: string;
  /** 1s 320x240 H.264 test pattern with sine audio */
  mp4: string;
  /** 6s 320x240 H.264 with sine audio — long enough to split into several encode windows */
  longMp4: string;
  /** 4s AAC sine tone (long enough for chromaprint) */
  m4a: string;
  /** 2s MPEG-2 program stream, whose container has no exiftool Duration */
  mpg: string;
  /** 2s 320x240 MJPEG in AVI — a codec NVDEC has no usable decoder for */
  legacyAvi: string;
  /** Landscape JPEG with EXIF Orientation=6 and a solid marker block — see `ROTATED` */
  rotated: string;
  /** 1s 320x240 clip carrying a container display matrix — see `ROTATED_VIDEO` */
  rotatedMp4: string;
  /** 1s anamorphic clip: coded 1440x1080, SAR 4:3 — see `ANAMORPHIC` */
  anamorphicMp4: string;
  /** The same clip as MPEG-TS, the container exiftool can read no ratio out of — see `ANAMORPHIC` */
  anamorphicM2ts: string;
};

/**
 * The plain photo fixture, in numbers.
 *
 * Bigger than the largest derivative size (`large`, a 2560 box) and not square, so every
 * aspect-preserving derivative is a real downscale of a known 4:3 source. That matters
 * because those resizes are shrink-only: a fixture smaller than a box is stored at its own
 * size, and an assertion on such a derivative would be measuring the fixture, not the resize.
 */
export const PHOTO = {
  width: 3200,
  height: 2400,
};

/**
 * The rotated fixture, in numbers.
 *
 * A 400x200 raster tagged Orientation=6, which `exif-extract` reads as `angle: 270`, so the
 * display frame is 200x400. The red block sits at raw (40,40)-(79,79); rotated upright that is
 * display (120,40)-(159,79), i.e. the fractional box below. Anything that mixes the two frames
 * up cuts somewhere else entirely, and the colour says so.
 */
export const ROTATED = {
  width: 400,
  height: 200,
  angle: 270,
  block: { x: 40, y: 40, size: 40 },
  /** The marker block as a stored faceBox: fractions of the 200x400 display frame. */
  box: { x: 0.6, y: 0.1, width: 0.2, height: 0.1 },
};

/**
 * The rotated video fixture, in numbers.
 *
 * A 320x240 clip whose rotation lives in the container display matrix rather than in an EXIF
 * tag, which is how every phone records a portrait video and what `Orientation` cannot express.
 * exiftool reports it as `Rotation: 90` (degrees clockwise to display), so the node's
 * counter-clockwise `angle` is its complement and the display frame is 240x320.
 */
export const ROTATED_VIDEO = {
  width: 320,
  height: 240,
  /** What exiftool writes and reads back on the container. */
  rotation: 90,
  /** What `exif-extract` must derive from it. */
  angle: 270,
};

/**
 * The anamorphic fixture, in numbers.
 *
 * AVCHD camcorders record 1080-line video in 1440 coded columns and describe the missing
 * quarter as a 4:3 sample aspect ratio, so the picture is 1920x1080 while the raster is not.
 * A video rendition keeps that ratio in the container and plays correctly; a still has nowhere
 * to put it, so the poster frame must be resampled to square pixels by `sar` or it comes out
 * squeezed.
 *
 * 480x360 at SAR 4:3, not the corpus's 1440x1080: the ratio is what is under test and it does
 * not need the pixels, while this tier encodes AV1 on the CPU and a 1080-line fixture crowds
 * the media pool for every step after it. The numbers are chosen so nothing rounds — the
 * display frame is exactly 640x360, and the 512 `contain` size is exactly 512x288 — so the
 * assertion can be an equality rather than a tolerance.
 *
 * **The same picture is written into two containers**, because what a node stores depends on
 * which one it is. exiftool reads an MP4's shape out of the track header and reports the
 * *display* frame (640x360, with the ratio beside it as `PixelAspectRatio`); it reads an
 * MPEG-TS's out of the H.264 sequence header and reports the *coded* raster (480x360) with no
 * ratio of any kind. The second is the corpus's `.MTS` album, and the only case where the
 * picture's shape has to be measured with a probe and stored as `sar`.
 */
export const ANAMORPHIC = {
  width: 480,
  height: 360,
  sar: '4/3',
  /** The picture those numbers describe, and what every rendition must have the shape of. */
  displayWidth: 640,
  displayHeight: 360,
};

const FILES: Record<Exclude<keyof MediaFixtures, 'dir'>, string> = {
  jpeg: 'photo.jpg',
  mp4: 'clip.mp4',
  longMp4: 'long.mp4',
  m4a: 'tone.m4a',
  mpg: 'program-stream.mpg',
  legacyAvi: 'legacy.avi',
  rotated: 'rotated.jpg',
  rotatedMp4: 'rotated.mp4',
  anamorphicMp4: 'anamorphic.mp4',
  anamorphicM2ts: 'anamorphic.m2ts',
};

/**
 * Copy the committed fixtures into a fresh directory.
 *
 * Under `EIN_TEST_FILE_ROOT` when set — `make container-test` points that at `/files-tmp`,
 * the scratch EMS mounts at the same path, which is what lets a test hand EMS a fixture's own
 * path as well as upload it.
 */
export async function stageMediaFixtures(): Promise<MediaFixtures> {
  const dir = await Deno.makeTempDir({ prefix: 'ein-media-fixtures-', dir: Deno.env.get('EIN_TEST_FILE_ROOT') || undefined });
  const staged = { dir } as MediaFixtures;
  for (const [key, name] of Object.entries(FILES) as [Exclude<keyof MediaFixtures, 'dir'>, string][]) {
    staged[key] = `${dir}/${name}`;
    await Deno.copyFile(join(FIXTURES_DIR, name), staged[key]);
  }
  return staged;
}

/**
 * Just enough `Command` for `@ems/client` to reach the EMS `make container-test` points at,
 * with host paths: `withHostPath` passes a path that is no node through unchanged, which is
 * what a staged fixture is. For measuring what EMS makes of a file, not for running commands.
 *
 * Its only node is `/etc/environment`, naming that EMS as the system's own, so the client sends
 * it the key the process was given, as a deployment's does.
 */
export const emsCommand = (): Command => {
  const url = Deno.env.get('CFG_EMS_URL') ?? '';
  const environment = new TextEncoder().encode(`export CFG_EMS_URL='${url}'\n`);
  const noNode = () => Promise.reject(new Error('not a node'));
  return ({
    access: {},
    env: { CFG_EMS_URL: url, CFG_EMS_CONNECT_RETRY: '0' },
    sys: {
      vfs: {
        stat: noNode,
        children: noNode,
        open: (_access: unknown, path: string) =>
          path === '/etc/environment' ? Promise.resolve({ readable: ReadableStream.from([environment]), close: () => Promise.resolve() }) : noNode(),
      },
    },
    execute: () => Promise.reject(new Error('emsCommand runs no commands')),
  }) as unknown as Command;
};
