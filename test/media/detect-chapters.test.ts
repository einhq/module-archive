/**
 * `detect-chapters`: a video's cuts from EMS's `video.shots` over its rendition, written as
 * `metadata/chapters` — WebVTT, and the cuts on the node — once, and not again unless forced.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import type { DetectChaptersAnswer } from '@archive/media/api';
import { startStubEms, type StubAnswer } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-chapters-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

const CUTS = [{ t: 6.2, score: 0.97, kind: 'cut' }, { t: 19.48, score: 0.99, kind: 'cut' }];

Deno.test({
  name: 'detect-chapters writes a video cuts as its chapters',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  let answer: (body: Record<string, unknown>) => Promise<StubAnswer>;
  const asked: Record<string, unknown>[] = [];
  const stub = startStubEms({
    ops: {
      'video.shots': (body) => {
        asked.push(body);
        return answer(body);
      },
    },
  });
  const env = `CFG_EMS_URL=${stub.url}`;
  const found = (): Promise<StubAnswer> =>
    Promise.resolve({ result: { duration: 30, frames: 750, cuts: CUTS, gaps: [], params: { threshold: 0.6 } }, producer: 'transnetv2+ffmpeg/9.0.1/cuda' });

  const film = `${ALBUMS_ROOT}/t/film.avi`;
  const run = (flags = '') => client.execJson<DetectChaptersAnswer>(`${env} JSON_OUTPUT=1 detect-chapters ${flags} ${film}`);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/t && mkfile ${film}`);
    await vfs.update(ADMIN_ACCESS, film, { attrs: { mimetype: 'video/x-msvideo', duration: 30 } });

    await t.step('before the rendition exists it waits, writing nothing', async () => {
      answer = found;
      assertEquals(await run(), { path: film, skipped: 'no-rendition' });
      assertEquals(asked.length, 0);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${film}/metadata/chapters`), false);
    });

    await t.step('the cuts of the rendition become the chapters node', async () => {
      await client.exec(`mkdir -p ${film}/thumbnails && printf mp4-bytes > ${film}/thumbnails/1920x1080.mp4`);
      const result = await run();
      assertEquals(result.boundaries?.map((b) => b.t), [6.2, 19.48]);
      // EMS gets the rendition's physical file, not the original.
      assertEquals(String((asked[0].file as { path: string }).path).startsWith(fileRoot), true);
      const node = await vfs.get(ADMIN_ACCESS, `${film}/metadata/chapters`);
      assertEquals(node.attrs.mimetype, 'text/vtt');
      assertEquals(node.attrs.chapterCount, 3);
      assertEquals(node.attrs.detectedBy, 'transnetv2+ffmpeg/9.0.1/cuda');
      assertEquals(node.attrs.detectedWith, { threshold: 0.6 });
      assertEquals(typeof node.attrs.detectedAt, 'string');
      const vtt = String((await client.exec(`cat ${film}/metadata/chapters`)).data);
      assertStringIncludes(vtt, '00:00:00.000 --> 00:00:06.200\nChapter 1');
      assertStringIncludes(vtt, '00:00:19.480 --> 00:00:30.000\nChapter 3');
    });

    await t.step('found once, it is not looked for again unless forced', async () => {
      answer = () => Promise.reject(new Error('not to be asked'));
      const before = asked.length;
      assertEquals((await run()).skipped, 'detected');
      assertEquals(asked.length, before);
    });

    await t.step('a video with no cut still gets its node, so it is not looked at again', async () => {
      answer = () => Promise.resolve({ result: { duration: 30, frames: 750, cuts: [], gaps: [], params: {} }, producer: 'transnetv2+ffmpeg/9.0.1/cuda' });
      assertEquals((await run('-f')).boundaries, []);
      const node = await vfs.get(ADMIN_ACCESS, `${film}/metadata/chapters`);
      assertEquals([node.attrs.chapterCount, node.attrs.boundaries], [1, []]);
    });

    await t.step('a forced run that fails leaves the chapters found before', async () => {
      answer = () => Promise.resolve({ error: { code: 'refused', message: 'over the CPU budget', permanent: true }, status: 422 });
      assertEquals((await run('-f')).skipped, 'unreadable');
      const node = await vfs.get(ADMIN_ACCESS, `${film}/metadata/chapters`);
      assertEquals([typeof node.attrs.detectedAt, node.attrs.boundaries, node.attrs.unreadable], ['string', [], undefined]);
    });

    const tape = `${ALBUMS_ROOT}/t/tape.avi`;
    await client.exec(`mkfile ${tape} && mkdir -p ${tape}/thumbnails && printf mp4-bytes > ${tape}/thumbnails/1920x1080.mp4`);
    await vfs.update(ADMIN_ACCESS, tape, { attrs: { mimetype: 'video/x-msvideo', duration: 3600 } });
    const runTape = () => client.exec(`${env} JSON_OUTPUT=1 detect-chapters ${tape}`);

    await t.step('a file EMS cannot decode, or will not, is written down and ends the step well', async () => {
      answer = () => Promise.resolve({ error: { code: 'refused', message: 'over the CPU budget', permanent: true }, status: 422 });
      const result = await runTape();
      assertEquals(result.success, true, `${result.error}`);
      const node = await vfs.get(ADMIN_ACCESS, `${tape}/metadata/chapters`);
      assertStringIncludes(String(node.attrs.unreadable), 'over the CPU budget');
      assertEquals(node.attrs.detectedAt, undefined);
    });

    await t.step('any other failure fails the step and writes nothing; an EMS without the op does not', async () => {
      await client.exec(`rm ${tape}/metadata/chapters`);
      for (
        const [error, status] of [
          [{ code: 'tool_failed', message: 'ffmpeg shot decode failed', permanent: false }, 500],
          // The rendition or the weights are not where EMS looks: not the video's fault.
          [{ code: 'not_found', message: 'Input path does not exist', permanent: true }, 404],
        ] as const
      ) {
        answer = () => Promise.resolve({ error, status });
        assertEquals((await runTape()).success, false, error.code);
        assertEquals(await vfs.exists(ADMIN_ACCESS, `${tape}/metadata/chapters`), false, error.code);
      }
      answer = () => Promise.resolve({ error: { code: 'http_404', message: 'Not Found' }, status: 404 });
      assertEquals((await run('-f')).skipped, 'ems-lacks-op');
    });

    await t.step('anything but a video is passed over', async () => {
      const photo = `${ALBUMS_ROOT}/t/p.jpg`;
      await client.exec(`mkfile ${photo}`);
      await vfs.update(ADMIN_ACCESS, photo, { attrs: { mimetype: 'image/jpeg' } });
      assertEquals((await client.execJson<DetectChaptersAnswer>(`${env} JSON_OUTPUT=1 detect-chapters ${photo}`)).skipped, 'not-video');
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
