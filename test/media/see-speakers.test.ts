/**
 * `see-speakers` against a stub EMS: the voices a video already has are tied to the faces detected
 * since, with one active-speaker call over the voices as they are and no diarization.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

Deno.test({
  name: 'see-speakers',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  /** A voice's face fields; one written null is removed, and reads back as null here too. */
  const seenOf = async (path: string) => {
    const a = (await vfs.get<Record<string, unknown>>(ADMIN_ACCESS, path)).attrs;
    return [a.asdRegionId ?? null, a.asdPersonId ?? null, a.asdScore ?? null];
  };

  let faces: unknown[] = [];
  const stub = startStubEms({
    ops: { 'speech.active_speakers': () => ({ result: { speakers: faces, windows: 2, frames: 100 } }) },
  });
  const run = (args: string) => client.exec(`CFG_EMS_URL=${stub.url} see-speakers ${args}`);
  const asked = () => stub.requests.filter((r) => r.op === 'speech.active_speakers');

  const writeVector = async (path: string, vector: number[]) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    await handle.close();
  };

  const video = `${ALBUMS_ROOT}/fest/files/fest.mp4`;
  const speakers = `${video}/metadata/transcript/speakers`;

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/fest/files`);
    await cmd.shouldSucceed(`mknode -t file ${video} --as name=fest.mp4 --as mimetype=video/mp4`);
    await vfs.update(ADMIN_ACCESS, video, { attrs: { angle: 180, mirror: true } });

    await t.step('a video not voiceprinted yet asks EMS nothing', async () => {
      const out = await run(video);
      assertEquals(out.success, true, out.error);
      assertEquals(asked().length, 0);
    });

    await t.step('the voices are tied to the faces detected since', async () => {
      await cmd.shouldSucceed(`mkdir -p ${speakers}`);
      for (const [name, turns] of [['s0', [[0, 6], [10, 14]]], ['s1', [[6, 10]]]] as const) {
        await cmd.shouldSucceed(`mknode -t embedding ${speakers}/${name} --as embeddingType=voice --an capacity=4`);
        await vfs.update(ADMIN_ACCESS, `${speakers}/${name}`, { attrs: { turns, asdRegionId: null, asdPersonId: null, asdScore: null } });
      }
      // Anna's face on screen from 5 s to 11 s, nobody's yet.
      await cmd.shouldSucceed(`mkdir -p ${video}/regions && mknode -t media-region ${video}/regions/face-0`);
      await vfs.update(ADMIN_ACCESS, `${video}/regions/face-0`, { attrs: { appearances: [[5, 11]] } });
      await cmd.shouldSucceed(`mknode -t embedding ${video}/regions/face-0/embedding --as embeddingType=face --an capacity=4`);
      await writeVector(`${video}/regions/face-0/embedding`, [0, 0, 1, 0]);
      const region = (await vfs.get(ADMIN_ACCESS, `${video}/regions/face-0`)).id;
      faces = [{ id: 's1', score: 0.85, t: 8, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: [0, 0.1, 1, 0] }];

      const out = await client.execJson<{ speakers: number; seen: number; regions: number }>(`CFG_EMS_URL=${stub.url} see-speakers ${video}`);
      assertEquals(out, { path: video, speakers: 2, seen: 1, regions: 1 } as typeof out);
      // EMS heard the voices as they are, by their node names, and saw the video as it is shown.
      const body = asked().at(-1)!.body as { speakers: unknown; file: { angle: number; mirror: boolean } };
      assertEquals(body.speakers, [{ id: 's0', turns: [[0, 6], [10, 14]] }, { id: 's1', turns: [[6, 10]] }]);
      assertEquals([body.file.angle, body.file.mirror], [180, true]);
      assertEquals(await seenOf(`${speakers}/s1`), [region, null, 0.85]);
      assertEquals(await seenOf(`${speakers}/s0`), [null, null, null]);
      // The voices themselves are untouched: no voiceprint was asked for.
      assertEquals(stub.requests.some((r) => r.op === 'speech.voiceprint'), false);
    });

    await t.step('a voice EMS sees no face for now keeps none', async () => {
      faces = [];
      assertEquals((await run(video)).success, true);
      assertEquals(await seenOf(`${speakers}/s1`), [null, null, null]);
    });

    await t.step('a recording with no picture is refused', async () => {
      const audio = `${ALBUMS_ROOT}/fest/files/tal.m4a`;
      await cmd.shouldSucceed(`mknode -t file ${audio} --as name=tal.m4a --as mimetype=audio/mp4`);
      await cmd.shouldFailWith(`CFG_EMS_URL=${stub.url} see-speakers ${audio}`, 'not a video');
    });
  } finally {
    await stub.close();
    await client.close();
    await testCtx.teardown();
  }
});
