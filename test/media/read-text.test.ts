/**
 * `read-text` against a stub EMS: a picture's text lands as its extracted text with its lines, its
 * language and a vector that carries its words, the file is stamped with the engine and the time,
 * a language set by hand is the one EMS is asked to read in, a reading that finds no text removes
 * an old one, and a picture EMS cannot read is marked read by the engine EMS runs, so it is not
 * announced again.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms, type StubAnswer } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });
const PPOCR = 'PP-OCRv6_medium';
const JINA = 'jina-embeddings-v5-text-small';

const SIGN = [
  { text: 'Hamngatan 4', box: [[0.1, 0.2], [0.5, 0.2], [0.5, 0.3], [0.1, 0.3]], score: 0.97 },
  { text: 'Öppet 10–18', box: [[0.1, 0.4], [0.5, 0.4], [0.5, 0.5], [0.1, 0.5]], score: 0.91 },
];

Deno.test({
  name: 'read-text',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const read = async (path: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return new TextDecoder().decode(await new Response(handle.readable).arrayBuffer());
    } finally {
      await handle.close();
    }
  };

  const signAnswer: StubAnswer = {
    result: { text: SIGN.map((line) => line.text).join('\n'), lines: SIGN, width: 4000, height: 3000 },
    producer: PPOCR,
    meta: { language: { code: 'sv', confidence: 0.97, given: false } },
  };
  let answer: StubAnswer = signAnswer;
  const stub = startStubEms({
    capabilities: { models: { ocr: PPOCR, text_embed: JINA } },
    ops: {
      'ocr.read': () => answer,
      'text.embed': (body) => ({ result: { embeddings: (body.texts as string[]).map(() => [1, 0]), dimension: 2 }, producer: JINA }),
    },
  });
  const run = (args: string) => client.exec(`CFG_EMS_URL=${stub.url} read-text ${args}`);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/stad/files`);
    const photo = `${ALBUMS_ROOT}/stad/files/skylt.jpg`;
    await cmd.shouldSucceed(`mknode -t file ${photo} --as name=skylt.jpg --as mimetype=image/jpeg --an angle=90 --as mirror=true`);

    await t.step('a picture is read in its display frame, and its text kept with its lines and words', async () => {
      const out = await run(photo);
      assertEquals(out.success, true, out.error);
      const asked = stub.requests.filter((r) => r.op === 'ocr.read').at(-1)!;
      const file = asked.body.file as { angle: number; mirror: boolean };
      assertEquals([file.angle, file.mirror], [90, true]);

      assertEquals(await read(`${photo}/metadata/content`), 'Hamngatan 4\nÖppet 10–18');
      const content = await vfs.get(ADMIN_ACCESS, `${photo}/metadata/content`);
      assertEquals([content.attrs.mimetype, content.attrs.lines], ['text/plain', SIGN]);
      assertEquals([content.attrs.ocrLanguage, content.attrs.ocrLanguageConfidence], ['sv', 0.97]);
      assertEquals('language' in asked.body, false);
      const vector = await vfs.get(ADMIN_ACCESS, `${photo}/metadata/content/text_jina5s`);
      assertEquals([vector.attrs.embeddedBy, vector.attrs.text], [JINA, 'Hamngatan 4\nÖppet 10–18']);

      const attrs = (await vfs.get(ADMIN_ACCESS, photo)).attrs;
      assertEquals([attrs.ocrBy, attrs.wordCount, typeof attrs.textIndexedAt], [PPOCR, 4, 'string']);
    });

    await t.step('a read picture is skipped without -f', async () => {
      const before = stub.requests.length;
      assertEquals((await run(photo)).success, true);
      assertEquals(stub.requests.length, before);
    });

    await t.step('a language set by hand is the one EMS reads in, and is stored without a confidence', async () => {
      await vfs.update(ADMIN_ACCESS, photo, { attrs: { ocrLanguageManual: 'en' } });
      answer = { ...signAnswer, meta: { language: { code: 'en', confidence: null, given: true } } } as StubAnswer;
      assertEquals((await run(`-f ${photo}`)).success, true);
      assertEquals(stub.requests.filter((r) => r.op === 'ocr.read').at(-1)!.body.language, 'en');
      const content = await vfs.get(ADMIN_ACCESS, `${photo}/metadata/content`);
      assertEquals([content.attrs.ocrLanguage, content.attrs.ocrLanguageConfidence ?? null], ['en', null]);
    });

    await t.step('read again and found empty, the old text goes', async () => {
      answer = { result: { text: '', lines: [], width: 4000, height: 3000 }, producer: PPOCR };
      assertEquals((await run(`-f ${photo}`)).success, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${photo}/metadata/content`), false);
      const attrs = (await vfs.get(ADMIN_ACCESS, photo)).attrs;
      assertEquals([attrs.ocrBy, attrs.wordCount], [PPOCR, undefined]);
    });

    await t.step('a picture EMS cannot read is read by the engine EMS runs, and the step succeeds', async () => {
      const broken = `${ALBUMS_ROOT}/stad/files/trasig.jpg`;
      await cmd.shouldSucceed(`mknode -t file ${broken} --as name=trasig.jpg --as mimetype=image/jpeg`);
      answer = { error: { code: 'unsupported', message: 'cannot identify image file', permanent: true }, status: 415 };
      const out = await run(broken);
      assertEquals(out.success, true, out.error);
      const attrs = (await vfs.get(ADMIN_ACCESS, broken)).attrs;
      assertEquals([attrs.ocrBy, typeof attrs.textIndexedAt], [PPOCR, 'string']);
    });

    await t.step('EMS busy is a failure to retry, and marks nothing', async () => {
      const later = `${ALBUMS_ROOT}/stad/files/senare.jpg`;
      await cmd.shouldSucceed(`mknode -t file ${later} --as name=senare.jpg --as mimetype=image/jpeg`);
      answer = { error: { code: 'busy', message: 'queue full' }, status: 503 };
      assertEquals((await run(later)).success, false);
      assertEquals((await vfs.get(ADMIN_ACCESS, later)).attrs.textIndexedAt, undefined);
    });
  } finally {
    await stub.close();
    client.close();
    await testCtx.teardown();
  }
});
