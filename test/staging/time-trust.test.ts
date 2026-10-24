/**
 * A staged file is dated by its category's time rules as it is indexed (`exif-extract`): a scan in
 * a `scans` category takes no date from the `DateTimeOriginal` its scanner wrote on the scan day,
 * nor from when its bytes were written, and is stamped `digitized`; a phone picture whose tags
 * hold no date is dated by its name; a camera category's names are not dates.
 *
 * EMS is a stub answering `media.probe` with an invented exiftool record; the parsing and dating
 * are the command's own.
 */
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

type Attrs = { takenAt?: string; takenAtUtc?: string; takenAtSource?: string; digitized?: boolean; whenName?: string; indexedAt?: string };

Deno.test({ name: 'staged files are dated by their category as they are indexed', sanitizeResources: false, sanitizeOps: false }, async (t) => {
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
    await cmd.shouldSucceed(`attrs -s mimetype=image/jpeg ${path} && ${env} exif-extract ${path}`);
    return await attrsOf(path);
  };

  try {
    await cmd.shouldSucceed('mkdir -p /dev && ([ -e /dev/events ] || mknode -t router --as routingKey=system.events /dev/events)');
    await cmd.shouldSucceed('staging init');
    await cmd.shouldSucceed('staging category scans --create --kind scans && staging category phone --create --kind phone && staging category camera --create --kind camera');

    await t.step('a scan in a scans category gets no capture time from its scan-day tag or its bytes', async () => {
      const scan = await index(`${FILES}/scans/box-3/scan0001.jpg`, SCAN_DUMP);
      assertEquals([scan.takenAt, scan.takenAtUtc, scan.takenAtSource], [undefined, undefined, undefined]);
      assertEquals(scan.digitized, true);
      assertEquals(typeof scan.indexedAt, 'string');
      // The scan day was read off the tags, and not believed.
      const exif = await client.execJson<{ when: { device?: { day?: string } } }>(`attrs ${FILES}/scans/box-3/scan0001.jpg/metadata/exif`);
      assertEquals(exif.when.device?.day, '01');
      // Named like a phone picture, a scan is still not dated by its name.
      const named = await index(`${FILES}/scans/box-3/IMG_20190601_123456.jpg`, SCAN_DUMP);
      assertEquals([named.takenAt, named.digitized, named.whenName], [undefined, true, undefined]);
    });

    await t.step('a phone picture with no date in its tags is dated by its name', async () => {
      const phone = await index(`${FILES}/phone/upload/IMG_20190601_123456.jpg`, BARE_DUMP);
      assertEquals([phone.takenAt, phone.takenAtSource, phone.whenName, phone.digitized], ['2019-06-01T12:34:56', 'name', '2019-06-01T12:34:56', undefined]);
    });

    await t.step("a camera category's names are not dates", async () => {
      const camera = await index(`${FILES}/camera/upload/IMG_20190601_123456.jpg`, BARE_DUMP);
      assertEquals([camera.takenAt, camera.whenName], [undefined, undefined]);
    });

    await t.step('outside staging the stamps a file carries still date it', async () => {
      await cmd.shouldSucceed(`mkdir -p /archive/albums/prints/files && mv ${FILES}/phone/upload/IMG_20190601_123456.jpg /archive/albums/prints/files/`);
      const filed = await attrsOf('/archive/albums/prints/files/IMG_20190601_123456.jpg');
      assertEquals([filed.takenAtSource, filed.whenName], ['name', '2019-06-01T12:34:56']);
      // Indexed again there, by bytes with no date in their tags.
      await cmd.shouldSucceed(`${env} exif-extract -f /archive/albums/prints/files/IMG_20190601_123456.jpg`);
      const again = await attrsOf('/archive/albums/prints/files/IMG_20190601_123456.jpg');
      assertEquals([again.takenAt, again.takenAtSource], ['2019-06-01T12:34:56', 'name']);
    });
  } finally {
    client.close();
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
