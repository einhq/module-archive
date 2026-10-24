/**
 * file-set-description: the hand-written description, which the UI writes
 * base64-encoded because it is arbitrary multi-line text on its way through a
 * shell command string.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { encodeBase64 } from '@std/encoding/base64';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const FILE = `${ALBUMS_ROOT}/a/p.jpg`;

const b64 = (text: string) => encodeBase64(new TextEncoder().encode(text));

Deno.test({
  name: 'file-set-description',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a`);
    await cmd.shouldSucceed(`mkfile ${FILE}`);

    await t.step('--text sets the attr', async () => {
      await cmd.shouldSucceed(`file-set-description ${FILE} --text "Boat trip"`);
      const attrs = await client.execJson<{ description?: string }>(`attrs ${FILE}`);
      assertEquals(attrs.description, 'Boat trip');
    });

    await t.step('--text-base64 round-trips multi-line text with quotes', async () => {
      // The whole reason the flag exists: none of this survives a shell string.
      const text = 'Line one\nLine "two" — with $VARS and \'quotes\'\nLine three';
      await cmd.shouldSucceed(`file-set-description ${FILE} --text-base64 ${b64(text)}`);

      const attrs = await client.execJson<{ description?: string }>(`attrs ${FILE}`);
      assertEquals(attrs.description, text);
    });

    await t.step('media-details reports it as the hand-written description', async () => {
      const details = await client.execJson<{ description?: string; caption?: string }>(`media-details ${FILE}`);
      assertEquals(details.description?.startsWith('Line one'), true);
      // The machine-written one is a separate node and stays untouched.
      assertEquals(details.caption, undefined);
    });

    await t.step('empty text clears the attr rather than storing an empty string', async () => {
      await cmd.shouldSucceed(`file-set-description ${FILE} --text-base64 ${b64('   ')}`);
      const attrs = await client.execJson<{ description?: string }>(`attrs ${FILE}`);
      assertEquals(attrs.description ?? null, null);
    });

    await t.step('bad base64 fails rather than storing mojibake', async () => {
      await cmd.shouldFail(`file-set-description ${FILE} --text-base64 'not base64!!'`);
    });

    await t.step('no text at all is a usage error', async () => {
      await cmd.shouldFail(`file-set-description ${FILE}`);
    });

    await t.step('missing file fails', async () => {
      await cmd.shouldFail(`file-set-description ${ALBUMS_ROOT}/a/nope.jpg --text hi`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
