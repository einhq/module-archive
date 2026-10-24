/**
 * exiftool tells some camera RAW formats from TIFF only by the file's extension, which a probe
 * of the bytes does not have: an uncompressed NEF reads as `image/tiff`. `exif-extract` stores the
 * RAW mimetype the name implies over a plain TIFF, and exiftool's answer otherwise.
 *
 * EMS is a stub answering `media.probe` with the mimetype each file name is given.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-exif-extract-raw-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

Deno.test({
  name: 'exif-extract keeps the RAW mimetype a name implies over a plain TIFF',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  let mimetype = 'image/tiff';
  const stub = startStubEms({
    ops: {
      'media.probe': () => ({
        result: {
          mimetype,
          kind: 'image',
          size: 1,
          captured_at: [],
          decodable: true,
          raw: { exiftool: { MIMEType: mimetype, ImageWidth: 300, ImageHeight: 200, Make: 'NIKON CORPORATION' } },
        },
        producer: 'exiftool/13',
      }),
    },
  });
  const env = `CFG_EMS_URL=${stub.url}`;

  const dir = `${ALBUMS_ROOT}/a/files`;
  const extract = async (name: string, answer: string): Promise<string | undefined> => {
    const file = `${dir}/${name}`;
    mimetype = answer;
    await cmd.shouldSucceed(`mkfile ${file}`);
    await cmd.shouldSucceed(`${env} exif-extract ${file}`);
    return (await client.execJson<{ mimetype?: string }>(`attrs ${file}`)).mimetype;
  };

  try {
    await client.exec(`mkdir -p ${dir}`);

    await t.step('a NEF that exiftool calls TIFF is stored as a NEF', async () => {
      assertEquals(await extract('DSC_0001.NEF', 'image/tiff'), 'image/x-nikon-nef');
    });

    await t.step('a TIFF by any other name stays a TIFF', async () => {
      assertEquals(await extract('scan.tif', 'image/tiff'), 'image/tiff');
    });

    await t.step('a format exiftool names is stored as named', async () => {
      assertEquals(await extract('DSC_0002.NEF', 'image/jpeg'), 'image/jpeg');
      assertEquals(await extract('IMGP0001.PEF', 'image/x-pentax-pef'), 'image/x-pentax-pef');
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
