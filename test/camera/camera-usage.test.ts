/**
 * `camera-usage` and the rules it reads maker notes by: which tag a shutter count, a firmware and a
 * lens come from, what unprinted (`exiftool -n`) values are made readable or left out, and how a
 * camera's pictures add up to its shutter counts by day, its firmware in the order seen and its
 * lenses by use.
 */

import { CAMERAS_ROOT } from '@archive/paths';
import type { CameraUsage } from '@archive/camera/api';
import { readMakerNotes, summariseUsage } from '@archive/camera/maker-notes';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';

Deno.test('readMakerNotes: a shutter count from ShutterCount, else ImageCount, and only a positive whole number', () => {
  assertEquals(readMakerNotes({ ShutterCount: '1234', ImageCount: '99' }).shutterCount, 1234);
  assertEquals(readMakerNotes({ ImageCount: '99' }).shutterCount, 99);
  assertEquals(readMakerNotes({ ShutterCount: '0', ImageCount: '99' }).shutterCount, 99);
  assertEquals(readMakerNotes({ ShutterCount: '12.5' }).shutterCount, undefined);
});

Deno.test("readMakerNotes: firmware from the maker's tags, in the form the maker shows it", () => {
  assertEquals(readMakerNotes({ CanonFirmwareVersion: 'Firmware Version 2.1.2', Software: 'Ver.9' }).firmware, '2.1.2');
  assertEquals(readMakerNotes({ FirmwareVersion: '0 1 1 3' }).firmware, '0.1.1.3');
  assertEquals(readMakerNotes({ FirmwareVersion: '1.02 ' }).firmware, '1.02');
  assertEquals(readMakerNotes({ FirmwareVersion: '', Firmware: '1.0.6' }).firmware, '1.0.6');
});

Deno.test('readMakerNotes: Software is firmware only when a camera wrote it', () => {
  assertEquals(readMakerNotes({ Software: 'K-9 Ver 1.12' }).firmware, '1.12');
  assertEquals(readMakerNotes({ Software: 'Wrenfield Z3 v1.02' }).firmware, '1.02');
  assertEquals(readMakerNotes({ Software: 'A1.00 B1.00' }).firmware, 'A1.00 B1.00');
  assertEquals(readMakerNotes({ Software: '10.0.2' }).firmware, '10.0.2');
  assertEquals(readMakerNotes({ Software: 'Photo Editor 10.0.10011.16384' }).firmware, undefined);
  assertEquals(readMakerNotes({ Software: 'picture-tool 0.10.0 ( libpng version 1.2.31 - August 21, 2008 )' }).firmware, undefined);
});

Deno.test('readMakerNotes: a lens by name wherever one is written, else from its focal lengths', () => {
  assertEquals(readMakerNotes({ LensModel: 'XF16-55mmF2.8 R LM WR', LensInfo: '16 55 2.8 2.8' }).lens, 'XF16-55mmF2.8 R LM WR');
  // A Canon type number, an empty model and a Nikon id are no names; the name in `LensID` is.
  assertEquals(readMakerNotes({ LensModel: '', Lens: '24 105', LensID: 'EF24-105mm f/4L IS USM' }).lens, 'EF24-105mm f/4L IS USM');
  assertEquals(readMakerNotes({ Lens: '10 30 3.5 5.6', LensID: 'FC 40 2D 80 2C 40 DF 06' }).lens, '10–30mm f/3.5–5.6');
  assertEquals(readMakerNotes({ LensID: '137', LensInfo: '70 200 undef undef' }).lens, '70–200mm');
  assertEquals(readMakerNotes({ LensInfo: '85 85 1.8 1.8' }).lens, '85mm f/1.8');
  assertEquals(readMakerNotes({ Lens: '18 55' }).lens, '18–55mm');
  // A name of nothing but focal lengths reads as the same lens from numbers does.
  assertEquals(readMakerNotes({ Lens: '17.0-70.0 mm f/2.8-4.0' }).lens, '17–70mm f/2.8–4');
  assertEquals(readMakerNotes({ LensModel: '50mm' }).lens, '50mm');
  // A Pentax lens type is named by exiftool's table, and not without it; a Nikon id too, before its focal lengths.
  assertEquals(readMakerNotes({ LensID: '8 215', LensName: 'smc PENTAX-DA 18-135mm F3.5-5.6 ED AL [IF] DC WR' }).lens, 'smc PENTAX-DA 18-135mm F3.5-5.6 ED AL [IF] DC WR');
  assertEquals(readMakerNotes({ LensID: '4 36' }).lens, undefined);
  assertEquals(
    readMakerNotes({ Lens: '28 300 3.5 6.3', LensID: '26 40 3C 8E 2C 40 1C 02', LensName: 'Sigma 28-300mm F3.5-6.3 Macro' }).lens,
    'Sigma 28-300mm F3.5-6.3 Macro',
  );
  // The camera's own name before the table's.
  assertEquals(readMakerNotes({ LensModel: 'EF50mm f/1.8 II', LensID: '29', LensName: 'Canon EF 50mm f/1.8 II' }).lens, 'EF50mm f/1.8 II');
  // A lens nothing is known of.
  assertEquals(readMakerNotes({ LensInfo: '0 0 0 0' }).lens, undefined);
});

Deno.test('summariseUsage: the highest count of a day, firmware by first seen, lenses by use', () => {
  const usage = summariseUsage('/cameras/C', 6, [
    { date: '2020-05-02T09:00:00', shutterCount: 120, firmware: '1.1', lens: 'Wide' },
    { date: '2020-05-01T10:00:00', shutterCount: 100, firmware: '1.0', lens: 'Wide' },
    { date: '2020-05-01T18:00:00', shutterCount: 110, firmware: '1.0', lens: 'Tele' },
    { date: '2020-06-01T10:00:00', firmware: '1.1', lens: 'Wide' },
    { firmware: '0.9', lens: 'Tele', shutterCount: 5 },
  ]);
  assertEquals(usage, {
    camera: '/cameras/C',
    files: 6,
    shutter: [{ date: '2020-05-01', count: 110 }, { date: '2020-05-02', count: 120 }],
    firmware: [
      { version: '1.0', files: 2, first: '2020-05-01', last: '2020-05-01' },
      { version: '1.1', files: 2, first: '2020-05-02', last: '2020-06-01' },
      { version: '0.9', files: 1 },
    ],
    lenses: [
      { lens: 'Wide', files: 3, first: '2020-05-01', last: '2020-06-01' },
      { lens: 'Tele', files: 2, first: '2020-05-01', last: '2020-05-01' },
    ],
  });
});

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'camera-usage',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A picture linked to `camera`, with the exiftool dump the pipeline would have stored. */
  const shot = async (path: string, camera: string, raw: Record<string, unknown>, when?: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', cameraPath: camera, ...(when ? captureTime(when) : {}) } });
    await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.ensure(ADMIN_ACCESS, 'exif', `${path}/metadata`, 'exif');
    await vfs.update(ADMIN_ACCESS, `${path}/metadata/exif`, { attrs: { indexedAt: '2020-01-01T00:00:00Z', raw } });
  };

  const camera = `${CAMERAS_ROOT}/Body`;
  const other = `${CAMERAS_ROOT}/Other`;

  try {
    await client.exec(`mkdir -p ${CAMERAS_ROOT} && mkdir -p /shots`);
    await cmd.shouldSucceed('camera-create --name Body');
    await cmd.shouldSucceed('camera-create --name Other');

    await shot('/shots/a.jpg', camera, { Make: 'Wrenfield', ShutterCount: 1500, FirmwareVersion: '1.00', LensModel: 'Wren 35mm F2' }, '2018-03-01T10:00:00');
    await shot('/shots/b.jpg', camera, { Make: 'Wrenfield', ShutterCount: 2400, FirmwareVersion: '1.10', Lens: '18 55 3.5 5.6' }, '2019-07-01T10:00:00');
    await shot('/shots/c.jpg', camera, { Make: 'Wrenfield', FirmwareVersion: '1.10', LensModel: 'Wren 35mm F2' });
    await cmd.shouldSucceed('echo x > /shots/bare.jpg');
    await vfs.update(ADMIN_ACCESS, '/shots/bare.jpg', { attrs: { mimetype: 'image/jpeg', cameraPath: camera } });
    await shot('/shots/elsewhere.jpg', other, { ShutterCount: 99, LensModel: 'Other lens' }, '2018-03-01T10:00:00');

    await t.step('it reads the maker notes of the files linked to the camera, and only those', async () => {
      const usage = await client.execJson<CameraUsage>(`camera-usage ${camera}`);
      assertEquals(usage, {
        camera,
        files: 4,
        shutter: [{ date: '2018-03-01', count: 1500 }, { date: '2019-07-01', count: 2400 }],
        firmware: [
          { version: '1.00', files: 1, first: '2018-03-01', last: '2018-03-01' },
          { version: '1.10', files: 2, first: '2019-07-01', last: '2019-07-01' },
        ],
        lenses: [
          { lens: 'Wren 35mm F2', files: 2, first: '2018-03-01', last: '2018-03-01' },
          { lens: '18–55mm f/3.5–5.6', files: 1, first: '2019-07-01', last: '2019-07-01' },
        ],
      });
    });

    await t.step('a camera with no pictures has nothing to say', async () => {
      await cmd.shouldSucceed('camera-create --name Empty');
      const usage = await client.execJson<CameraUsage>(`camera-usage ${CAMERAS_ROOT}/Empty`);
      assertEquals(usage, { camera: `${CAMERAS_ROOT}/Empty`, files: 0, shutter: [], firmware: [], lenses: [] });
    });

    await t.step('what is not a camera is refused', async () => {
      await cmd.shouldFail('camera-usage /shots');
    });
  } finally {
    await testCtx.teardown();
  }
});
