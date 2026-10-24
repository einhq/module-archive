/**
 * A Google Photos Takeout part, end to end on a booted instance: uploaded as a zip into a
 * google-photos category, expanded by `staging-unzip`, its JSON sidecars announced by the bridge
 * and paired by `staging-sidecars`, and each photo, its tags holding no date, dated by
 * `exif-extract` from its sidecar; its favourites starred for the inbox's owner and its album
 * folder titled.
 *
 * The part is `fixtures/takeout.ts`'s, with 20 tiny invented JPEGs. The media pool's worker here
 * takes only the unzip and sidecar work, and `exif-extract` is run by hand against a stub EMS that
 * finds no date in the bytes; the sidecar pipeline waits half a second rather than thirty.
 */
import { POOLS_PATH } from '@ein/paths';
import type { ExifExtractAnswer, MediaSidecarsAnswer } from '@archive/media/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';
import { TAKEOUT_ALBUM, TAKEOUT_ALBUM_TITLE, takeoutZip } from './fixtures/takeout.ts';

const testCtx = createTestContext({ modules: ['archive'], boot: true });

const CATEGORY = '/home/admin/staging/files/google-photos';
const BATCH = `${CATEGORY}/upload-2026-10-18`;

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

Deno.test({ name: 'a Takeout zip is expanded, paired and dated by its sidecars', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs, baseUrl } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const stub = startStubEms({
    ops: {
      'media.probe': () => ({
        result: {
          mimetype: 'image/jpeg',
          kind: 'image',
          size: 1,
          captured_at: [],
          decodable: true,
          raw: { exiftool: { MIMEType: 'image/jpeg', ImageWidth: 4, ImageHeight: 3 } },
        },
        producer: 'exiftool/13',
      }),
    },
  });
  const writeFile = async (path: string, body: Uint8Array) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(body);
    } finally {
      await handle.close();
    }
  };
  const { zip, photos } = takeoutZip();

  try {
    // Only the work this test is about is claimed: the boot's own media worker would index too.
    await cmd.shouldSucceed('service stop cpu && service stop staging-organizer');
    await cmd.shouldSucceed('mkdir -p /opt/takeout-worker && mkfile /opt/takeout-worker/start.sh && chmod 755 /opt/takeout-worker/start.sh');
    await writeFile(
      '/opt/takeout-worker/start.sh',
      new TextEncoder().encode(`pipeline-worker --pool ${POOLS_PATH}/media --capacity cpu=2 --kind unzip --kind sidecars --concurrency 2\n`),
    );
    await cmd.shouldSucceed('service add takeout-worker /opt/takeout-worker && service enable takeout-worker && service start takeout-worker');
    const definition = (await Deno.readTextFile(new URL('../../pipelines/staging-sidecars.yaml', import.meta.url))).replace('debounceMs: 30000', 'debounceMs: 500');
    await cmd.shouldSucceed('mkdir -p /tmp/defs && mkfile /tmp/defs/staging-sidecars.yaml');
    await writeFile('/tmp/defs/staging-sidecars.yaml', new TextEncoder().encode(definition));
    await cmd.shouldSucceed('pipeline define /tmp/defs/staging-sidecars.yaml');
    // The engine reloads a definition a moment after it changes.
    await new Promise((r) => setTimeout(r, 1000));
    await cmd.shouldSucceed('staging init && staging category google-photos --create --kind google-photos');
    await cmd.shouldSucceed(`mkdir -p ${BATCH}`);

    await t.step('the uploaded zip is expanded beside it and removed', async () => {
      const { cookie } = await testCtx.harness.createHttpSession();
      const res = await fetch(`${baseUrl}/file${BATCH}/?name=takeout-001.zip`, { method: 'POST', headers: { cookie }, body: zip });
      assertEquals(res.status, 201);
      await waitFor(async () => !(await vfs.exists(ADMIN_ACCESS, `${BATCH}/takeout-001.zip`)), 'the zip to be expanded and removed');
      for (const photo of photos) assertEquals(await vfs.exists(ADMIN_ACCESS, `${BATCH}/${photo.path}`), true, photo.path);
    });

    await t.step('every sidecar is paired with its photo, and the album folder titled', async () => {
      await waitFor(
        async () => {
          for (const photo of photos) if (!(await vfs.exists(ADMIN_ACCESS, `${BATCH}/${photo.path}/sidecar`))) return false;
          return (await vfs.get(ADMIN_ACCESS, `${BATCH}/${TAKEOUT_ALBUM}`)).attrs.title === TAKEOUT_ALBUM_TITLE;
        },
        'every photo to have its sidecar',
        // Long enough for the module's own thirty seconds, should the engine not have reloaded yet.
        45000,
      );
      const again = await client.execJson<MediaSidecarsAnswer>(`media-sidecars ${BATCH} --dry-run`);
      assertEquals([again.found, again.unmatched, again.paired], [0, 0, 0]);
    });

    await t.step('each photo is dated by its sidecar when its metadata is read', async () => {
      for (const photo of photos) {
        const path = `${BATCH}/${photo.path}`;
        const answer = await client.execJson<ExifExtractAnswer>(`CFG_EMS_URL=${stub.url} exif-extract '${path}'`);
        assertEquals('indexedAt' in answer, true, path);
        const attrs = (await vfs.get(ADMIN_ACCESS, path)).attrs;
        assertEquals([attrs.takenAt, attrs.takenAtUtc, attrs.takenAtSource], [photo.takenAt, photo.takenAt, 'sidecar'], path);
        assertEquals(await vfs.exists(ADMIN_ACCESS, `${path}/position`), true, path);
      }
    });

    await t.step("the favourites are starred for the inbox's owner", async () => {
      const stars = await vfs.children(ADMIN_ACCESS, '/home/admin/stars', { follow: false });
      assertEquals(
        stars.map((entry) => entry.node.props.softlink).sort(),
        photos.filter((photo) => photo.favorited).map((photo) => `${BATCH}/${photo.path}`).sort(),
      );
    });
  } finally {
    await stub.close();
    client.close();
    await testCtx.teardown();
  }
});
