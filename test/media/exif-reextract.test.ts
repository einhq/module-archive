/**
 * `exif-extract -f` against an existing index — media-reindex after the bytes changed, or a
 * repair pass — must describe the *new* bytes and nothing else. `vfs.update` merges, so every
 * attr the command derives has to be written as null when the new dump lacks it, or the previous
 * bytes' answer survives (ein/core#75). The manual
 * overrides (`angleManual`, `positionManual`) are the one thing a re-extract must *not* touch.
 *
 * EMS is a stub answering `media.probe` from a table; the parsing is the command's own.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-exif-reextract-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

/** A still with everything: a camera, a GPS fix, a turned Orientation tag on a landscape raster. */
const FULL_DUMP = {
  MIMEType: 'image/jpeg',
  ImageWidth: 400,
  ImageHeight: 200,
  Make: 'Canon',
  Model: 'EOS 5D',
  SerialNumber: 'ABC123',
  ISO: 100,
  ExposureTime: 0.01,
  Orientation: 6,
  GPSLatitude: 57.7,
  GPSLongitude: 11.97,
  GPSAltitude: 12,
  DateTimeOriginal: '2020:05:01 12:00:00',
};

/** The same file replaced by a scan: no camera, no fix, no tag, and a different raster. */
const BARE_DUMP = {
  MIMEType: 'image/jpeg',
  ImageWidth: 300,
  ImageHeight: 300,
};

type FileAttrs = {
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
  angle?: number;
  angleManual?: number;
  positionManual?: { lat: number; lng: number };
  takenAt?: string;
  indexedAt?: string;
};

type ExifAttrs = {
  indexedAt: string;
  deviceinfo?: Record<string, string>;
  deviceSerialNumber?: string;
  fileinfo?: Record<string, unknown>;
  where?: Record<string, unknown>;
  when: Record<string, unknown>;
  angle?: number;
};

Deno.test({
  name: 'a re-extract clears what the new bytes no longer carry',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  let dump: Record<string, unknown> = FULL_DUMP;
  const stub = startStubEms({
    ops: {
      'media.probe': () => ({
        result: {
          mimetype: dump.MIMEType,
          kind: String(dump.MIMEType).startsWith('video/') ? 'video' : 'image',
          size: 1,
          captured_at: [],
          decodable: true,
          raw: { exiftool: dump },
        },
        producer: 'exiftool/13',
      }),
    },
  });
  const env = `CFG_EMS_URL=${stub.url}`;

  const dir = `${ALBUMS_ROOT}/a/files`;
  const attrsOf = (path: string) => client.execJson<FileAttrs>(`attrs ${path}`);
  const exifOf = (path: string) => client.execJson<ExifAttrs>(`attrs ${path}/metadata/exif`);
  const hasLocation = (path: string) => vfs.exists(ADMIN_ACCESS, `${path}/position`);

  try {
    await client.exec(`mkdir -p ${dir}`);

    await t.step('the first index writes every fact and the position child', async () => {
      const file = `${dir}/full.jpg`;
      await cmd.shouldSucceed(`mkfile ${file}`);
      await cmd.shouldSucceed(`${env} exif-extract ${file}`);

      const attrs = await attrsOf(file);
      assertEquals([attrs.width, attrs.height, attrs.angle], [400, 200, 270]);
      assertEquals(attrs.takenAt, '2020-05-01T12:00:00');
      const exif = await exifOf(file);
      assertEquals(exif.deviceinfo, { model: 'EOS 5D', make: 'Canon' });
      assertEquals(exif.deviceSerialNumber, 'ABC123');
      assertEquals(exif.fileinfo, { width: 400, height: 200, iso: 100, exposure: '0.01' });
      assertEquals(exif.where, { gps: { longitude: 11.97, latitude: 57.7, altitude: 12 } });
      assertEquals(exif.angle, 270);
      assertEquals(await hasLocation(file), true);
      // The file carries when its metadata was read, as its exif node does.
      assertEquals(attrs.indexedAt, exif.indexedAt);

      dump = BARE_DUMP;
      await cmd.shouldSucceed(`${env} exif-extract -f ${file}`);

      const after = await attrsOf(file);
      assertEquals([after.width, after.height], [300, 300]);
      assertEquals(after.angle, undefined, 'an angle the old bytes had must not survive');
      assertEquals(after.takenAt, undefined);
      const exifAfter = await exifOf(file);
      assertEquals(exifAfter.deviceinfo, undefined);
      assertEquals(exifAfter.deviceSerialNumber, undefined);
      assertEquals(exifAfter.fileinfo, { width: 300, height: 300 });
      assertEquals(exifAfter.where, undefined);
      assertEquals(exifAfter.angle, undefined);
      assertEquals(exifAfter.when, {}, 'examined and empty, not absent');
      assertEquals(await hasLocation(file), false, 'the position child follows `where`');
    });

    await t.step('a video replaced by a still loses its duration and codec', async () => {
      const file = `${dir}/clip.mov`;
      await cmd.shouldSucceed(`mkfile ${file}`);
      dump = { MIMEType: 'video/quicktime', ImageWidth: 640, ImageHeight: 480, Duration: 12.5, CompressorID: 'avc1', Rotation: 90 };
      await cmd.shouldSucceed(`${env} exif-extract ${file}`);
      const video = await attrsOf(file);
      assertEquals(video.duration, 12.5);
      assertEquals(video.codec, 'h264');
      assertEquals(video.angle, 270);

      dump = BARE_DUMP;
      await cmd.shouldSucceed(`${env} exif-extract -f ${file}`);
      const still = await attrsOf(file);
      assertEquals(still.duration, undefined);
      assertEquals(still.codec, undefined);
      assertEquals(still.angle, undefined);
    });

    await t.step('a manual orientation survives a re-extract in both directions', async () => {
      const file = `${dir}/turned.jpg`;
      await cmd.shouldSucceed(`mkfile ${file}`);
      await vfs.update(ADMIN_ACCESS, file, { attrs: { angle: 90, angleManual: 90 } });

      dump = FULL_DUMP;
      await cmd.shouldSucceed(`${env} exif-extract ${file}`);
      assertEquals((await attrsOf(file)).angle, 90, 'the tag must not override the manual angle');
      // The exif node still records what the bytes say; only the file node is the override's.
      assertEquals((await exifOf(file)).angle, 270);

      dump = BARE_DUMP;
      await cmd.shouldSucceed(`${env} exif-extract -f ${file}`);
      assertEquals((await attrsOf(file)).angle, 90, 'no tag in the new bytes must not clear the manual angle');
      assertEquals((await exifOf(file)).angle, undefined);
    });

    await t.step('a manual location is neither rewritten nor removed', async () => {
      const file = `${dir}/placed.jpg`;
      await cmd.shouldSucceed(`mkfile ${file}`);
      await cmd.shouldSucceed(`file-set-position ${file} --lat=47.6 --lng=-122.3`);
      // The node type normalizes a `radius` in; the position is what the assertion is about.
      const readPosition = async () => {
        const { lat, lng } = JSON.parse(await client.execString(`cat ${file}/position`));
        return { lat, lng };
      };

      dump = FULL_DUMP;
      await cmd.shouldSucceed(`${env} exif-extract ${file}`);
      assertEquals(await readPosition(), { lat: 47.6, lng: -122.3 }, 'a GPS fix must not overwrite the manual position');
      assertEquals((await exifOf(file)).where, { gps: { longitude: 11.97, latitude: 57.7, altitude: 12 } });

      dump = BARE_DUMP;
      await cmd.shouldSucceed(`${env} exif-extract -f ${file}`);
      assertEquals(await hasLocation(file), true, 'no fix in the new bytes must not remove the manual position');
      assertEquals(await readPosition(), { lat: 47.6, lng: -122.3 });
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
