/**
 * A source whose container cannot be read at all is a fact about the file, not a pipeline
 * failure — see ein/core#145.
 *
 * `exif-extract` writes the reason onto the file node (@archive/media/media-probe UNDECODABLE_ATTR);
 * the pipelines that would try to decode it skip on the attr, and the two commands that
 * can also be invoked below a trigger answer the same way rather than spending an ffmpeg per
 * size on a file with no frame table.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';
import { createTestContext, testCommands } from '@ein/testing';

const moduleRoot = new URL('../../', import.meta.url);

type PipelineFile = { trigger?: { skipIfAttr?: string }; triggers?: { skipIfAttr?: string }[] };

/** Everything triggered by `media.metadata.extracted` that needs to decode the bytes. */
const DECODING_PIPELINES = [
  'media-stills',
  'media-transcode',
  'media-fingerprint',
  'media-transcribe',
];

Deno.test('every pipeline that decodes a source skips one that cannot be decoded', async () => {
  for (const name of DECODING_PIPELINES) {
    const def = parseYaml(await Deno.readTextFile(new URL(`pipelines/${name}.yaml`, moduleRoot))) as PipelineFile;
    const triggers = def.triggers ?? (def.trigger ? [def.trigger] : []);
    assertEquals(triggers.every((trigger) => trigger.skipIfAttr === 'undecodable'), true, name);
  }
});

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

    await t.step('compute-fingerprint writes nothing and does not fail', async () => {
      const result = await client.execJson<{ count: number; undecodable?: string }>(`compute-fingerprint ${VIDEO}`);
      assertEquals(result.count, 0);
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
