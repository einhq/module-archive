/**
 * file-set-text-language: a picture's language is set as `ocrLanguageManual`, `auto` removes it, the
 * same language again is no change, and anything but a picture or a two-letter code is refused.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'file-set-text-language',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const LETTER = `${ALBUMS_ROOT}/brev/files/sida1.jpg`;
  const CLIP = `${ALBUMS_ROOT}/brev/files/klipp.mp4`;
  const language = async () => (await vfs.get(ADMIN_ACCESS, LETTER)).attrs.ocrLanguageManual ?? null;

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/brev/files`);
    await cmd.shouldSucceed(`mknode -t file ${LETTER} --as name=sida1.jpg --as mimetype=image/jpeg`);
    await cmd.shouldSucceed(`mknode -t file ${CLIP} --as name=klipp.mp4 --as mimetype=video/mp4`);

    await t.step('a language is set, in lower case', async () => {
      const out = await client.execJson(`JSON_OUTPUT=1 file-set-text-language ${LETTER} EN`);
      assertEquals(out, { ok: true, path: LETTER, language: 'en', changed: true });
      assertEquals(await language(), 'en');
    });

    await t.step('the same language again changes nothing', async () => {
      const out = await client.execJson<{ changed: boolean }>(`JSON_OUTPUT=1 file-set-text-language ${LETTER} en`);
      assertEquals(out.changed, false);
    });

    await t.step('auto hands the language back to the reading', async () => {
      await cmd.shouldSucceed(`file-set-text-language ${LETTER} auto`);
      assertEquals(await language(), null);
    });

    await t.step('a word for a language, or a video, is refused', async () => {
      await cmd.shouldFailWith(`file-set-text-language ${LETTER} English`, 'not a two-letter ISO 639-1 code');
      await cmd.shouldFailWith(`file-set-text-language ${CLIP} en`, 'not a picture');
      await cmd.shouldFailWith(`file-set-text-language ${LETTER}`, 'usage');
      assertEquals(await language(), null);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
