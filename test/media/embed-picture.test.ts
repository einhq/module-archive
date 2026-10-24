/**
 * `embed-picture` against a stub EMS: where a photo's and a video's vectors land, what marks the
 * work done, and that a re-embed starts from an empty directory rather than retyping nodes (a
 * retyped embedding node leaves its row in the old model's table).
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });
const SIGLIP = 'ViT-SO400M-16-SigLIP2-384__webli';

Deno.test({
  name: 'embed-picture',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const read = async (path: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return JSON.parse(new TextDecoder().decode(await new Response(handle.readable).arrayBuffer()));
    } finally {
      await handle.close();
    }
  };
  const children = async (path: string) => (await vfs.children(ADMIN_ACCESS, path)).map((c) => c.name).sort();

  let reply: Record<string, unknown> = { embedding: [0.6, 0.8, 0], dimension: 3 };
  let producer = SIGLIP;
  const stub = startStubEms({ ops: { 'vision.embed': () => ({ result: reply, producer }) } });
  const run = (args: string) => client.exec(`CFG_EMS_URL=${stub.url} embed-picture ${args}`);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/hav/files`);
    const photo = `${ALBUMS_ROOT}/hav/files/segel.jpg`;
    await cmd.shouldSucceed(`mknode -t file ${photo} --as name=segel.jpg --as mimetype=image/jpeg --an angle=90`);

    await t.step('a photo gets one vector, typed by its model, and the directory is stamped last', async () => {
      const out = await run(photo);
      assertEquals(out.success, true, out.error);
      assertEquals(await children(`${photo}/metadata/picture`), ['embedding']);
      const node = await vfs.get(ADMIN_ACCESS, `${photo}/metadata/picture/embedding`);
      assertEquals(node.attrs.embeddingType, 'picture_siglip2');
      assertEquals(node.attrs.capacity, 3);
      assertEquals(await read(`${photo}/metadata/picture/embedding`), [0.6, 0.8, 0]);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${photo}/metadata/picture`)).attrs.embeddedBy, SIGLIP);
      // The file's own rotation reached EMS: the vector is of the picture as it is shown.
      const asked = stub.requests.filter((r) => r.op === 'vision.embed').at(-1)!;
      assertEquals((asked.body.file as { angle: number }).angle, 90);
    });

    await t.step('a photo with an 800px rendition is embedded from it, unrotated', async () => {
      const shown = `${ALBUMS_ROOT}/hav/files/skepp.jpg`;
      await cmd.shouldSucceed(`mknode -t file ${shown} --as name=skepp.jpg --as mimetype=image/jpeg --an angle=270`);
      await cmd.shouldSucceed(`mkdir -p ${shown}/thumbnails`);
      await cmd.shouldSucceed(`mknode -t file ${shown}/thumbnails/800x800.avif --as name=800x800.avif --as mimetype=image/avif`);
      assertEquals((await run(shown)).success, true);
      const asked = stub.requests.filter((r) => r.op === 'vision.embed').at(-1)!;
      const file = asked.body.file as { angle: number; mimetype: string };
      assertEquals([file.angle, file.mimetype], [0, 'image/avif']);
    });

    await t.step('an embedded photo is skipped without -f', async () => {
      const before = stub.requests.length;
      assertEquals((await run(photo)).success, true);
      assertEquals(stub.requests.length, before);
    });

    await t.step('a model nothing has given a type is refused, and nothing is replaced', async () => {
      producer = 'ViT-B-32__openai';
      const out = await run(`-f ${photo}`);
      assertEquals(out.success, false);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${photo}/metadata/picture`)).attrs.embeddedBy, SIGLIP);
      producer = SIGLIP;
    });

    await t.step('a video gets a vector per keyframe, and a re-embed leaves no old node behind', async () => {
      const clip = `${ALBUMS_ROOT}/hav/files/segel.mp4`;
      await cmd.shouldSucceed(`mknode -t file ${clip} --as name=segel.mp4 --as mimetype=video/mp4`);
      reply = { frames: [0, 1, 2].map((i) => ({ at: i * 2.5, embedding: [i, 1, 0] })), dimension: 3 };
      assertEquals((await run(clip)).success, true);
      assertEquals(await children(`${clip}/metadata/picture`), ['k0', 'k1', 'k2']);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/picture/k1`)).attrs.atSeconds, 2.5);

      reply = { frames: [0, 1].map((i) => ({ at: i, embedding: [1, i, 0] })), dimension: 3 };
      assertEquals((await run(`-f ${clip}`)).success, true);
      assertEquals(await children(`${clip}/metadata/picture`), ['k0', 'k1']);
    });

    await t.step('audio is not a picture', async () => {
      const memo = `${ALBUMS_ROOT}/hav/files/memo.m4a`;
      await cmd.shouldSucceed(`mknode -t file ${memo} --as name=memo.m4a --as mimetype=audio/mp4`);
      assertEquals((await run(memo)).success, false);
    });
  } finally {
    await stub.close();
    client.close();
    await testCtx.teardown();
  }
});
