/**
 * `voiceprint-file` against a stub EMS: one node per voice with its turns as data, what a person
 * decided surviving a re-run, and a face seen speaking becoming the voice's hint through the
 * region its embedding belongs to.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

const ANNA = [1, 0, 0, 0];
const EDVIN = [0, 1, 0, 0];

Deno.test({
  name: 'voiceprint-file',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const attrsOf = (path: string) => vfs.get<Record<string, unknown>>(ADMIN_ACCESS, path).then((n) => n.attrs);
  const names = async (path: string) => (await vfs.children(ADMIN_ACCESS, path)).map((c) => c.name).sort();

  // What EMS hears: two voices, and a turn it could tell for nobody.
  let speakers = [
    { id: 'speaker_0', turns: [[0, 6], [10, 14]], talkSeconds: 10, vector: ANNA },
    { id: 'speaker_1', turns: [[6, 10]], talkSeconds: 4, vector: EDVIN },
  ];
  let faces: unknown[] = [];
  const stub = startStubEms({
    ops: {
      'speech.voiceprint': () => ({
        result: {
          speech: true,
          audio: true,
          duration: 20,
          turns: [
            ...speakers.flatMap((s) => s.turns.map(([start, end]) => ({ start, end, speaker: s.id }))),
            { start: 15, end: 15.6, speaker: null },
          ],
          speakers,
        },
        producer: 'diar_sortformer_4spk-v1+titanet',
      }),
      'speech.active_speakers': () => ({ result: { speakers: faces, windows: 2, frames: 100 } }),
    },
  });
  const run = (args: string) => client.exec(`CFG_EMS_URL=${stub.url} voiceprint-file ${args}`);

  const recording = async (name: string, mimetype: string) => {
    const path = `${ALBUMS_ROOT}/fest/files/${name}`;
    await cmd.shouldSucceed(`mknode -t file ${path} --as name=${name} --as mimetype=${mimetype}`);
    await cmd.shouldSucceed(`mkdir -p ${path}/metadata`);
    await cmd.shouldSucceed(`mknode -t file ${path}/metadata/transcript --as mimetype=text/vtt --ab speech=true`);
    return path;
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/fest/files`);
    const audio = await recording('tal.m4a', 'audio/mp4');
    const dir = `${audio}/metadata/transcript/speakers`;

    await t.step('one node per voice, its turns as data, and the marker last', async () => {
      const out = await run(audio);
      assertEquals(out.success, true, out.error);
      assertEquals(await names(dir), ['s0', 's1']);
      const s0 = await attrsOf(`${dir}/s0`);
      assertEquals([s0.embeddingType, s0.speaker, s0.turns, s0.talkSeconds, s0.turnCount], ['voice', 'speaker_0', [[0, 6], [10, 14]], 10, 2]);
      assertEquals(s0.personId, null);
      assertEquals((await attrsOf(dir)).unattributed, [[15, 15.6]]);
      const file = await attrsOf(audio);
      assertEquals(file.speakerCount, 2);
      assertEquals(typeof file.speakersAt, 'string');
    });

    await t.step('a recording with no transcript yet is nothing to do, not a failure', async () => {
      const path = `${ALBUMS_ROOT}/fest/files/tyst.avi`;
      await cmd.shouldSucceed(`mknode -t file ${path} --as name=tyst.avi --as mimetype=video/x-msvideo`);
      const before = stub.requests.length;
      const out = await run(path);
      assertEquals(out.success, true, out.error);
      assertEquals(stub.requests.length, before);
      assertEquals((await attrsOf(path)).speakersAt, undefined);
    });

    await t.step('a voiceprinted recording is skipped without -f', async () => {
      const before = stub.requests.length;
      assertEquals((await run(audio)).success, true);
      assertEquals(stub.requests.length, before);
    });

    await t.step('a re-run keeps what a person decided, on the voice it now is', async () => {
      await vfs.update(ADMIN_ACCESS, `${dir}/s1`, { attrs: { personId: 'p-edvin', personSource: 'manual', assignLocked: true } });
      // EMS hears the voices in another order this time: Edvin's turn is now speaker_0.
      speakers = [
        { id: 'speaker_0', turns: [[6, 10]], talkSeconds: 4, vector: EDVIN },
        { id: 'speaker_1', turns: [[0, 6], [10, 14]], talkSeconds: 10, vector: ANNA },
      ];
      assertEquals((await run(`-f ${audio}`)).success, true);
      const s0 = await attrsOf(`${dir}/s0`);
      assertEquals([s0.personId, s0.personSource, s0.assignLocked], ['p-edvin', 'manual', true]);
      // Anna's voice did not inherit it. (Whether recognition has since given her a person is the
      // assignment pipeline's business, which runs on its own after the write.)
      assertEquals((await attrsOf(`${dir}/s1`)).personId === 'p-edvin', false);
    });

    await t.step("a face seen speaking, and known, becomes the voice's hint", async () => {
      // A known face: a region of a photo carrying the person, its vector beneath it.
      const photo = `${ALBUMS_ROOT}/fest/files/bild.jpg`;
      await cmd.shouldSucceed(`mknode -t file ${photo} --as name=bild.jpg --as mimetype=image/jpeg`);
      await cmd.shouldSucceed(`mkdir -p ${photo}/regions`);
      await cmd.shouldSucceed(`mknode -t media-region ${photo}/regions/face-0 --as personId=p-anna`);
      await cmd.shouldSucceed(`mknode -t embedding ${photo}/regions/face-0/embedding --as embeddingType=face --an capacity=4`);
      const handle = await vfs.open(ADMIN_ACCESS, `${photo}/regions/face-0/embedding`, { mode: 'w' });
      await handle.write(new TextEncoder().encode(JSON.stringify([0, 0, 1, 0])));
      await handle.close();

      const video = await recording('tal.mp4', 'video/mp4');
      await vfs.update(ADMIN_ACCESS, video, { attrs: { angle: 90 } });
      faces = [{ id: 'speaker_1', score: 0.88, t: 2, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: [0, 0, 1, 0] }];

      assertEquals((await run(video)).success, true);
      const s1 = await attrsOf(`${video}/metadata/transcript/speakers/s1`);
      assertEquals([s1.asdPersonId, s1.asdScore], ['p-anna', 0.88]);
      // The video's rotation reached EMS, so the faces were found the way the video is shown.
      const asked = stub.requests.filter((r) => r.op === 'speech.active_speakers').at(-1)!;
      assertEquals((asked.body.file as { angle: number }).angle, 90);
      assertEquals(s1.asdRegionId, null);
    });

    await t.step("a face seen speaking is tied to the video's own face on screen then", async () => {
      const video = await recording('fest.mp4', 'video/mp4');
      const region = async (name: string, appearances: [number, number][], vector: number[]) => {
        const path = `${video}/regions/${name}`;
        await cmd.shouldSucceed(`mkdir -p ${video}/regions`);
        await cmd.shouldSucceed(`mknode -t media-region ${path}`);
        await vfs.update(ADMIN_ACCESS, path, { attrs: { appearances } });
        await cmd.shouldSucceed(`mknode -t embedding ${path}/embedding --as embeddingType=face --an capacity=4`);
        const handle = await vfs.open(ADMIN_ACCESS, `${path}/embedding`, { mode: 'w' });
        await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
        await handle.close();
        return (await vfs.get(ADMIN_ACCESS, path)).id;
      };
      // Anna on screen early, nobody's yet; someone else beside her and on after her; Anna again,
      // her face matching the speaking one better, but only after the moment it was seen.
      const early = await region('face-0', [[0, 4]], [0, 0.2, 1, 0]);
      await region('face-1', [[3, 9]], [0, 0, 0, 1]);
      await region('face-2', [[10, 12]], [0, 0, 1, 0]);
      faces = [
        { id: 'speaker_1', score: 0.9, t: 3.5, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: [0, 0, 1, 0] },
        { id: 'speaker_0', score: 0.7, t: 6, box: { x: 0.5, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: [0, 0, 1, 0] },
      ];

      const out = await run(video);
      assertEquals(out.success, true, out.error);
      const speakersDir = `${video}/metadata/transcript/speakers`;
      const s1 = await attrsOf(`${speakersDir}/s1`);
      assertEquals([s1.asdRegionId, s1.asdPersonId, s1.asdScore], [early, 'p-anna', 0.9]);
      // At 6 s only someone else is on screen: no region of this video is the face, and the
      // archive-wide match still names it.
      const s0 = await attrsOf(`${speakersDir}/s0`);
      assertEquals([s0.asdRegionId, s0.asdPersonId], [null, 'p-anna']);
    });
  } finally {
    await stub.close();
    await client.close();
    await testCtx.teardown();
  }
});
