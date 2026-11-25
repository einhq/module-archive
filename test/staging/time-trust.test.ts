/**
 * A staged file is dated by its own clocks as its metadata is read and interpreted
 * (`exif-interpret`), whatever category it is in: a scan, a file whose camera the registry marks a
 * digitizer, takes no date from the `DateTimeOriginal` its scanner wrote on the scan day and is
 * marked `digitized`; a file's name never dates it, in staging or in the library.
 *
 * EMS is a stub answering `media.probe` with an invented exiftool record; the parsing and dating
 * are the command's own.
 */
import { CAMERAS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-time-trust-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

const FILES = '/home/admin/staging/files';

/** What a flatbed writes into a scan: its own make, and the scan day as `DateTimeOriginal`. */
const SCAN_DUMP = { MIMEType: 'image/jpeg', ImageWidth: 2400, ImageHeight: 1600, Make: 'Exempel', Model: 'Flatbed 1', DateTimeOriginal: '2026:10:01 09:30:00' };
/** A phone picture whose tags an editor emptied. */
const BARE_DUMP = { MIMEType: 'image/jpeg', ImageWidth: 4000, ImageHeight: 3000 };

type Attrs = { takenAt?: string; takenAtSource?: string; digitized?: boolean; whenName?: string; indexedAt?: string };

Deno.test({ name: 'staged files are dated by their own clocks as they are indexed', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  let dump: Record<string, unknown> = SCAN_DUMP;
  const stub = startStubEms({
    ops: {
      'media.probe': () => ({
        result: { mimetype: 'image/jpeg', kind: 'image', size: 1, captured_at: [], decodable: true, raw: { exiftool: dump } },
        producer: 'exiftool/13',
      }),
    },
  });
  const env = `CFG_EMS_URL=${stub.url}`;
  const attrsOf = (path: string) => client.execJson<Attrs>(`attrs ${path}`);
  /** A file with invented bytes at `path`, indexed with the exiftool record `record`. */
  const index = async (path: string, record: Record<string, unknown>) => {
    dump = record;
    await cmd.shouldSucceed(`mkdir -p ${path.slice(0, path.lastIndexOf('/'))} && echo 'an invented picture of ${path}' > ${path}`);
    await cmd.shouldSucceed(`attrs -s mimetype=image/jpeg ${path} && ${env} exif-extract ${path} && exif-interpret ${path}`);
    return await attrsOf(path);
  };

  try {
    await cmd.shouldSucceed('mkdir -p /dev && ([ -e /dev/events ] || mknode -t router --as routingKey=system.events /dev/events)');
    await cmd.shouldSucceed('staging init');
    await cmd.shouldSucceed('staging category scans --create && staging category phone --create');
    await cmd.shouldSucceed(`mkdir -p ${CAMERAS_ROOT} && camera-create --name "Flatbed 1" --make Exempel --model "Flatbed 1" --digitizer`);

    await t.step('a scan gets no capture time from its scan-day tag, and is marked digitized', async () => {
      const path = `${FILES}/scans/box-3/scan0001.jpg`;
      await index(path, SCAN_DUMP);
      await cmd.shouldSucceed(`camera-link ${path} && exif-interpret ${path}`);
      const scan = await attrsOf(path);
      assertEquals([scan.takenAt, scan.takenAtSource, scan.digitized], [undefined, undefined, true]);
      assertEquals(typeof scan.indexedAt, 'string');
      // The scan day was read off the tags, and not believed.
      const exif = await client.execJson<{ when: { device?: { day?: string } } }>(`attrs ${path}/metadata/exif`);
      assertEquals(exif.when.device?.day, '01');
    });

    await t.step('a file named like a phone picture, with no date in its tags, is not dated by its name', async () => {
      const phone = await index(`${FILES}/phone/upload/IMG_20190601_123456.jpg`, BARE_DUMP);
      assertEquals([phone.takenAt, phone.takenAtSource, phone.whenName, phone.digitized], [undefined, undefined, undefined, undefined]);
    });

    await t.step('nor once it is filed into the library', async () => {
      await cmd.shouldSucceed(`mkdir -p /archive/albums/prints/files && mv ${FILES}/phone/upload/IMG_20190601_123456.jpg /archive/albums/prints/files/`);
      await cmd.shouldSucceed(
        `${env} exif-extract -f /archive/albums/prints/files/IMG_20190601_123456.jpg && exif-interpret /archive/albums/prints/files/IMG_20190601_123456.jpg`,
      );
      const filed = await attrsOf('/archive/albums/prints/files/IMG_20190601_123456.jpg');
      assertEquals([filed.takenAt, filed.takenAtSource], [undefined, undefined]);
    });
  } finally {
    client.close();
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
