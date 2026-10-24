/**
 * A video's storyboard sheet as `generate-derivatives --only storyboard` makes it through EMS:
 * from the 1080p rendition once there is one, staged and swapped in like a transcode, with how
 * to cut it into tiles on its node, and kept by `--prune`. The tiling itself is EMS's.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { STORYBOARD_ATTR } from '@archive/media/storyboard';
import { startStubEms, type StubAnswer } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-storyboard-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

type Report = { created: string[]; pruned: string[]; failed: number };

const SHEET = { interval: 1, count: 182, columns: 12, rows: 16, tile: { width: 160, height: 120 }, duration: 181.2 };

Deno.test({
  name: 'generate-derivatives makes a video storyboard from its rendition',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  let answer: (body: Record<string, unknown>) => Promise<StubAnswer>;
  const asked: Record<string, unknown>[] = [];
  const stub = startStubEms({
    ops: {
      'video.storyboard': (body) => {
        asked.push(body);
        return answer(body);
      },
    },
  });
  const env = `CFG_EMS_URL=${stub.url}`;
  const sheetMade = async (body: Record<string, unknown>): Promise<StubAnswer> => {
    await Deno.writeTextFile((body.output as { path: string }).path, 'avif-bytes');
    return { result: { path: '', width: 1920, height: 1920, bytes: 10, ...SHEET }, producer: 'ffmpeg/9.0.1/cuda+magick/7.1' };
  };

  const film = `${ALBUMS_ROOT}/t/film.avi`;
  const thumbnails = `${film}/thumbnails`;
  const names = async () => (await vfs.children(ADMIN_ACCESS, thumbnails)).map((c) => c.name).sort();

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/t && mkfile ${film}`);
    await vfs.update(ADMIN_ACCESS, film, { attrs: { mimetype: 'video/x-msvideo', width: 720, height: 576, sar: 16 / 15, duration: 181.2 } });

    await t.step('before the rendition exists there is nothing to make it from, and nothing has failed', async () => {
      answer = sheetMade;
      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard`);
      assertEquals(report, { created: [], pruned: [], failed: 0 });
      assertEquals(asked.length, 0);
    });

    await t.step('the sheet is made from the 1080p rendition and says how to read it', async () => {
      await client.exec(`printf mp4-bytes > ${thumbnails}/1920x1080.mp4`);
      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard`);
      assertEquals(report.failed, 0);
      assertEquals(report.created, [`${thumbnails}/storyboard-160.avif`]);

      // EMS is handed the rendition's physical file, upright, and the sheet as sizes.yaml has it.
      const body = asked[0];
      assertEquals(String((body.file as { path: string }).path).startsWith(fileRoot), true);
      assertEquals((body.file as Record<string, unknown>).angle, undefined);
      assertEquals([body.tile, body.columns, body.max_tiles, body.min_interval], [160, 12, 240, 1]);
      assertEquals(body.output, { path: (body.output as { path: string }).path, format: 'avif', quality: 55 });

      const sheet = await vfs.get(ADMIN_ACCESS, `${thumbnails}/storyboard-160.avif`);
      assertEquals(Number(sheet.attrs.size), 10);
      assertEquals(sheet.attrs.sourceId, (await vfs.get(ADMIN_ACCESS, film)).id);
      assertEquals(sheet.attrs[STORYBOARD_ATTR], { interval: 1, count: 182, columns: 12, rows: 16, tileWidth: 160, tileHeight: 120 });
      assertEquals(await names(), ['1920x1080.mp4', 'storyboard-160.avif']);
    });

    await t.step('a sheet that exists is kept unless forced, and the transcode class never makes one', async () => {
      answer = () => Promise.reject(new Error('not to be asked'));
      const before = asked.length;
      assertEquals((await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard`)).created, []);
      await client.exec(`printf mp4-bytes > ${thumbnails}/480x480.mp4`);
      assertEquals((await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only transcode`)).created, []);
      assertEquals(asked.length, before);
    });

    await t.step('a new sheet replaces any other, and --prune keeps the sheet while it drops a stale one', async () => {
      await client.exec(`printf old > ${thumbnails}/storyboard-120.avif`);
      answer = sheetMade;
      const forced = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard -f`);
      assertEquals(forced.created, [`${thumbnails}/storyboard-160.avif`]);
      assertEquals(await names(), ['1920x1080.mp4', '480x480.mp4', 'storyboard-160.avif']);

      await client.exec(`printf old > ${thumbnails}/storyboard-120.avif`);
      const pruned = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard --prune`);
      assertEquals(pruned.pruned, [`${thumbnails}/storyboard-120.avif`]);
      assertEquals(await names(), ['1920x1080.mp4', '480x480.mp4', 'storyboard-160.avif']);
    });

    await t.step('a failure EMS may get past fails the step; one in the rendition itself does not', async () => {
      answer = () => Promise.resolve({ error: { code: 'tool_failed', message: 'ffmpeg storyboard failed: exit 1', permanent: false }, status: 500 });
      const failed = await client.exec(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard -f`);
      assertEquals(failed.success, false);
      assertEquals(Number((await vfs.get(ADMIN_ACCESS, `${thumbnails}/storyboard-160.avif`)).attrs.size), 10, 'the old sheet survives');

      answer = () => Promise.resolve({ error: { code: 'undecodable', message: 'no video picture with a length', permanent: true }, status: 422 });
      const unreadable = await client.exec(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard -f`);
      assertEquals(unreadable.success, true, `an unreadable rendition must not fail the step: ${unreadable.error}`);
    });

    await t.step('an EMS without the op leaves the sheet for one that has it', async () => {
      answer = () => Promise.resolve({ error: { code: 'http_404', message: 'Not Found' }, status: 404 });
      const result = await client.exec(`${env} JSON_OUTPUT=1 generate-derivatives ${film} --only storyboard -f`);
      assertEquals(result.success, true, `${result.error}`);
    });

    await t.step('a clip of a few seconds gets no storyboard', async () => {
      const clip = `${ALBUMS_ROOT}/t/clip.mp4`;
      await client.exec(`mkfile ${clip}`);
      await vfs.update(ADMIN_ACCESS, clip, { attrs: { mimetype: 'video/mp4', width: 1920, height: 1080, duration: 3 } });
      await client.exec(`mkdir -p ${clip}/thumbnails && printf mp4-bytes > ${clip}/thumbnails/1920x1080.mp4`);
      const before = asked.length;
      assertEquals((await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${clip} --only storyboard`)).created, []);
      assertEquals(asked.length, before);
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
