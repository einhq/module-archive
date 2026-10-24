/**
 * file-set-text: a picture's text is replaced by a person's, without the read lines, and marked
 * `textManual` with no `ocrBy`; `read-text` then leaves it alone even forced; empty text removes
 * it; anything but a picture is refused.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const base64 = (text: string): string => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

Deno.test({
  name: 'file-set-text',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const LETTER = `${ALBUMS_ROOT}/brev/files/sida1.jpg`;
  const CLIP = `${ALBUMS_ROOT}/brev/files/klipp.mp4`;
  const CONTENT = `${LETTER}/metadata/content`;
  const content = async () => {
    if (!await vfs.exists(ADMIN_ACCESS, CONTENT)) return null;
    const handle = await vfs.open(ADMIN_ACCESS, CONTENT, { mode: 'r' });
    try {
      return new TextDecoder().decode(await new Response(handle.readable).arrayBuffer());
    } finally {
      await handle.close();
    }
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/brev/files`);
    await cmd.shouldSucceed(`mknode -t file ${LETTER} --as name=sida1.jpg --as mimetype=image/jpeg --as ocrBy=engine-1 --as textIndexedAt=2026-01-01T00:00:00Z`);
    await cmd.shouldSucceed(`mknode -t file ${CLIP} --as name=klipp.mp4 --as mimetype=video/mp4`);
    await cmd.shouldSucceed(`mkdir -p ${LETTER}/metadata`);
    await cmd.shouldSucceed(`mknode -t file ${CONTENT} --as mimetype=text/plain --tier db --as lines=read`);

    await t.step('the text is replaced, its lines dropped and the file marked', async () => {
      const out = await client.execJson(`JSON_OUTPUT=1 file-set-text ${LETTER} --text-base64 ${base64('Kära Anna,\nvi har det bra.\n')}`);
      assertEquals(out, { ok: true, path: LETTER, wordCount: 6 });
      assertEquals(await content(), 'Kära Anna,\nvi har det bra.');
      assertEquals((await vfs.get(ADMIN_ACCESS, CONTENT)).attrs.lines ?? null, null);
      const { attrs } = await vfs.get(ADMIN_ACCESS, LETTER);
      assertEquals([attrs.textManual, attrs.ocrBy ?? null, attrs.wordCount, attrs.textIndexedAt], [true, null, 6, '2026-01-01T00:00:00Z']);
    });

    await t.step('a forced reading leaves the written text alone', async () => {
      await cmd.shouldSucceed(`read-text -f ${LETTER}`);
      assertEquals(await content(), 'Kära Anna,\nvi har det bra.');
    });

    await t.step('empty text removes it', async () => {
      await cmd.shouldSucceed(`file-set-text ${LETTER} --text ''`);
      assertEquals(await content(), null);
      assertEquals((await vfs.get(ADMIN_ACCESS, LETTER)).attrs.textManual, true);
    });

    await t.step('a video, or no text, is refused', async () => {
      await cmd.shouldFailWith(`file-set-text ${CLIP} --text hej`, 'not a picture');
      await cmd.shouldFailWith(`file-set-text ${LETTER}`, 'usage');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
