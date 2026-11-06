/**
 * A source whose container cannot be read at all is a fact about the file, not a pipeline
 * failure — see ein/core#145.
 *
 * `exif-extract` writes the reason onto the file node (@media/probe UNDECODABLE_ATTR);
 * `generate-derivatives`, invoked below a trigger, answers with it rather than spending an ffmpeg
 * per size on a file with no frame table, and `media-details` carries it.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const VIDEO = `${ALBUMS_ROOT}/a/files/truncated.MOV`;
const REASON = 'moov atom not found';

Deno.test({
  name: 'undecodable source',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a/files`);
    await cmd.shouldSucceed(`mkfile ${VIDEO}`);
    await cmd.shouldSucceed(`attrs ${VIDEO} -s mimetype=video/quicktime -s undecodable=${JSON.stringify(REASON)}`);

    await t.step('generate-derivatives makes no rendition and does not fail', async () => {
      const result = await client.execJson<{ created: string[]; failed: number; undecodable?: string }>(
        `generate-derivatives ${VIDEO}`,
      );
      assertEquals(result.created, []);
      assertEquals(result.failed, 0);
      assertEquals(result.undecodable, REASON);
    });

    await t.step('media-details carries the reason so the lightbox can say it', async () => {
      const details = await client.execJson<{ undecodable?: string }>(`media-details ${VIDEO}`);
      assertEquals(details.undecodable, REASON);
    });

    await t.step('a file with no mark is not treated as undecodable', async () => {
      // Null is how a re-index that succeeded clears the mark, so it must read as absent.
      const other = `${ALBUMS_ROOT}/a/files/fine.MOV`;
      await cmd.shouldSucceed(`mkfile ${other}`);
      await cmd.shouldSucceed(`attrs ${other} -s mimetype=video/quicktime`);
      await client.exec(`attrs ${other} -s undecodable=`);

      const details = await client.execJson<{ undecodable?: string }>(`media-details ${other}`);
      assertEquals(details.undecodable, undefined);

      // The guard is gone: the command gets as far as trying to encode, which this tier has no
      // ffmpeg for. That failure is the point — it is what the mark exists to stop paying for.
      const result = await client.exec(`generate-derivatives ${other}`);
      const output = JSON.stringify(result.data ?? result.error ?? '');
      assertEquals(output.includes('undecodable'), false, output);
    });
  } finally {
    await testCtx.teardown();
  }
});
