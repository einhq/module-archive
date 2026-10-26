/**
 * `detect-faces` on a video against a stub EMS: one region per face it shows, with the second
 * its box is of and when it is on screen, the photo's quality gate on each face's clearest look,
 * a crop cut from that frame, and the marker on the video either way.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';
import { toText } from '@std/streams/to-text';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

const LANDMARKS = [[0.42, 0.25], [0.48, 0.25], [0.45, 0.28], [0.43, 0.31], [0.47, 0.31]];

Deno.test({
  name: 'detect-faces on a video',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const attrsOf = (path: string) => vfs.get<Record<string, unknown>>(ADMIN_ACCESS, path).then((n) => n.attrs);
  const names = async (path: string) => (await vfs.children(ADMIN_ACCESS, path)).map((c) => c.name).sort();

  let faces: unknown[] = [
    {
      appearances: [[0.5, 9.5], [30.5, 34.5]],
      detections: 14,
      t: 4,
      box: { x: 0.4, y: 0.2, width: 0.1, height: 0.18 },
      confidence: 0.93,
      landmarks: LANDMARKS,
      pose: { pitch: 1, yaw: -8, roll: 0 },
      embedding: [1, 0, 0, 0],
      track: [[1, 0.39, 0.2, 0.1, 0.18], [4, 0.4, 0.2, 0.1, 0.18], [31, 0.5, 0.25, 0.08, 0.15]],
    },
    // Seen for a moment at the edge of the crowd, and too weak to be a face anyone could name.
    { appearances: [[12.5, 13.5]], detections: 1, t: 13, box: { x: 0.8, y: 0.1, width: 0.05, height: 0.08 }, confidence: 0.6, embedding: [0, 1, 0, 0] },
    {
      appearances: [[20.5, 26.5]],
      detections: 7,
      t: 22,
      box: { x: 0.1, y: 0.3, width: 0.12, height: 0.2 },
      confidence: 0.88,
      embedding: [0, 0, 1, 0],
    },
  ];
  const stub = startStubEms({
    ops: {
      'faces.detect_video': () => ({ result: { frame: { width: 1920, height: 1080 }, duration: 35, interval: 1, samples: 35, faces } }),
      'video.poster': (body) => ({
        result: { frame: { width: 1920, height: 1080 }, t: body.at, targets: (body.targets as unknown[]).map(() => ({ path: '', width: 200, height: 240, bytes: 1 })) },
      }),
    },
  });
  const run = (args: string) => client.exec(`CFG_EMS_URL=${stub.url} detect-faces ${args}`);

  try {
    const clip = `${ALBUMS_ROOT}/fest/files/MVI_0012.MP4`;
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/fest/files`);
    await cmd.shouldSucceed(`mknode -t file ${clip} --as name=MVI_0012.MP4 --as mimetype=video/mp4 --an width=1920 --an height=1080 --an angle=90`);

    await t.step('a region per face it shows, with when it is on screen', async () => {
      const out = await run(clip);
      assertEquals(out.success, true, out.error);
      assertEquals(await names(`${clip}/regions`), ['face-0', 'face-2']);
      const anna = await attrsOf(`${clip}/regions/face-0`);
      assertEquals(anna.atSeconds, 4);
      assertEquals(anna.appearances, [[0.5, 9.5], [30.5, 34.5]]);
      assertEquals(anna.faceBox, { x: 0.4, y: 0.2, width: 0.1, height: 0.18 });
      assertEquals(anna.confidence, 0.93);
      assertEquals(anna.pose, { pitch: 1, yaw: -8, roll: 0 });
      assertEquals(anna.personId, undefined);
      assertEquals(await names(`${clip}/regions/face-0`), ['embedding', 'image.avif', 'track']);
      // Its box in every frame it was seen in, a line a frame.
      assertEquals((await attrsOf(`${clip}/regions/face-0/track`)).mimetype, 'application/x-ndjson');
      const handle = await vfs.open(ADMIN_ACCESS, `${clip}/regions/face-0/track`, { mode: 'r' });
      const track = await toText(handle.readable).finally(() => handle.close());
      assertEquals(track.trim().split('\n').map((line) => JSON.parse(line)), [[1, 0.39, 0.2, 0.1, 0.18], [4, 0.4, 0.2, 0.1, 0.18], [31, 0.5, 0.25, 0.08, 0.15]]);
      // A face EMS gave no track has none.
      assertEquals(await names(`${clip}/regions/face-2`), ['embedding', 'image.avif']);
      assertEquals((await attrsOf(`${clip}/regions/face-0/embedding`)).embeddingType, 'face');
      assertEquals((await attrsOf(`${clip}/regions/face-2/image.avif`)).sourceId, (await vfs.get(ADMIN_ACCESS, clip)).id);
      const file = await attrsOf(clip);
      assertEquals(file.faceCount, 2);
      assertEquals(typeof file.facesAt, 'string');
    });

    await t.step('EMS is asked in the display frame, with the gate as far as it can apply it', async () => {
      const asked = stub.requests.find((r) => r.op === 'faces.detect_video')!.body;
      assertEquals((asked.file as { angle: number }).angle, 90);
      // 24 display pixels of the shorter side; the display frame of a turned 1920x1080 is 1080 wide.
      assertEquals(asked.min_size, 24 / 1080);
      assertEquals(asked.min_confidence, 0.5);
    });

    await t.step('each crop is cut from the frame its face was seen at', async () => {
      const cuts = stub.requests.filter((r) => r.op === 'video.poster');
      assertEquals(cuts.map((r) => r.body.at), [4, 22]);
      assertEquals((cuts[0].body.file as { angle: number }).angle, 90);
    });

    await t.step('a video nobody is seen in is marked as detected all the same', async () => {
      faces = [];
      const empty = `${ALBUMS_ROOT}/fest/files/MVI_0013.MP4`;
      await cmd.shouldSucceed(`mknode -t file ${empty} --as name=MVI_0013.MP4 --as mimetype=video/mp4`);
      const out = await run(empty);
      assertEquals(out.success, true, out.error);
      const file = await attrsOf(empty);
      assertEquals([file.faceCount, typeof file.facesAt], [0, 'string']);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${empty}/regions`), false);
    });

    await t.step('a video nothing can decode is not sent to EMS, and the step succeeds', async () => {
      const broken = `${ALBUMS_ROOT}/fest/files/P1030159.MOV`;
      await cmd.shouldSucceed(`mknode -t file ${broken} --as name=P1030159.MOV --as mimetype=video/quicktime --as 'undecodable=moov atom not found'`);
      const asked = stub.requests.length;
      const out = await run(broken);
      assertEquals(out.success, true, out.error);
      assertEquals(stub.requests.length, asked);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${broken}/regions`), false);
    });

    await t.step('a recording is not something faces are looked for in', async () => {
      const sound = `${ALBUMS_ROOT}/fest/files/tal.m4a`;
      await cmd.shouldSucceed(`mknode -t file ${sound} --as name=tal.m4a --as mimetype=audio/mp4`);
      const out = await run(sound);
      assertEquals(out.success, false);
      assertEquals((await attrsOf(sound)).facesAt, undefined);
    });
  } finally {
    await stub.close();
    await client.close();
    await testCtx.teardown();
  }
});
