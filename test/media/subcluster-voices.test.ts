/**
 * subcluster-voices end to end: a person heard in two orthogonal blobs of voices comes back as
 * two groups, with each voice's recording to play, and voices never voiceprinted are counted,
 * not clustered.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import type { VoiceSubclusterResult } from '@archive/media/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const DIM = 8;
const HALF = DIM / 2;

/** Two orthogonal directions, one per half of the coordinates — cosine 0 apart. */
const dir = (group: number) => Array.from({ length: DIM }, (_, i) => (Math.floor(i / HALF) === group ? 1 : 0));
const near = (group: number, seed: number) => dir(group).map((v, i) => (v === 1 && i % HALF === seed % HALF ? v + 0.02 : v));

Deno.test({
  name: 'subcluster-voices',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /** A person heard in one recording per voice, from `blobs` speakers; `unprinted` have no voiceprint. */
  const seedPerson = async (tag: string, blobs: number[], unprinted = 0) => {
    const person = await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, tag, {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: `Unknown ${tag}`, unnamed: true, origin: 'voice', createdBy: 'cluster-voices' },
    });

    let index = 0;
    const write = async (values: number[] | null) => {
      const file = `/rec/${tag}-${index}.mp4`;
      await client.exec(`echo x > ${file}`);
      await vfs.update(ADMIN_ACCESS, file, { attrs: { mimetype: 'video/mp4' } });
      await client.exec(`mkdir -p ${file}/metadata/transcript/speakers`);
      const fileId = (await vfs.get(ADMIN_ACCESS, file)).id;
      const path = `${file}/metadata/transcript/speakers/s0`;
      await client.exec(`mknode -t embedding ${path} --as embeddingType=voice --an capacity=${DIM} --as fileId=${fileId}`);
      // Longer talk for earlier voices, so the order they come back in is known.
      const talkSeconds = 100 - index;
      await vfs.update(ADMIN_ACCESS, path, { attrs: { turns: [[2, 2 + talkSeconds]], talkSeconds, turnCount: 1, personId: person.id, personSource: 'cluster' } });
      if (values) {
        const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify(values)));
        } finally {
          await handle.close();
        }
      }
      index++;
    };

    for (const [group, count] of blobs.entries()) {
      for (let i = 0; i < count; i++) await write(near(group, i));
    }
    for (let i = 0; i < unprinted; i++) await write(null);

    return `${PEOPLE_ROOT}/unknown/${tag}`;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}/unknown`);
    await client.exec('mkdir -p /rec');

    const fused = await seedPerson('fused', [4, 3], 1);

    await t.step('two speakers under one person come back as two groups', async () => {
      const res = await client.execJson<VoiceSubclusterResult>(`subcluster-voices ${fused}`);

      assertEquals(res.total, 7);
      assertEquals(res.withoutVector, 1);
      assertEquals(res.merges.length, 6);
      assertEquals(res.suggested.groups, 2);
      assertEquals(res.groups.map((g) => g.length), [4, 3]);
      assertEquals(res.groups.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
      // Longest heard first, each with its recording and the moment to play.
      assertEquals(res.voices.map((voice) => voice.talkSeconds), [100, 99, 98, 97, 96, 95, 94]);
      assertEquals(res.voices[0].filePath, '/rec/fused-0.mp4');
      assertEquals(res.voices[0].start, 2);
      assertEquals(res.voices[0].mimetype, 'video/mp4');
    });

    await t.step('--k and --threshold cut the same dendrogram', async () => {
      assertEquals((await client.execJson<VoiceSubclusterResult>(`subcluster-voices ${fused} --k 1`)).groups.length, 1);
      assertEquals((await client.execJson<VoiceSubclusterResult>(`subcluster-voices ${fused} --threshold 0.99999`)).groups.length, 7);
    });

    await t.step('a bad person or a bad flag fails cleanly', async () => {
      assertEquals((await client.exec('subcluster-voices')).success, false);
      assertEquals((await client.exec(`subcluster-voices ${PEOPLE_ROOT}/unknown/nope`)).success, false);
      assertEquals((await client.exec(`subcluster-voices ${fused} --threshold high`)).success, false);
      assertEquals((await client.exec('subcluster-voices fused')).success, true);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
