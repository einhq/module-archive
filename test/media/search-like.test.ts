/**
 * "More like this": `search-media --like` and `search --like` rank pictures by their picture
 * vectors against one picture's own.
 *
 * Pinned here: the picture's stored vectors are the question, and a file without any is embedded
 * through EMS on the spot (interactively) and kept nowhere; a video asks with each keyframe and is
 * found by its best one; the picture itself, a copy of its bytes and the rest of its stack are never an answer; the
 * score is the similarity; `--within` and the aggregator's filters narrow it; and words with a
 * picture are refused.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Hit = { path: string; score: number; id?: string };
type SearchAnswer = { results: Hit[]; filters: { like: string | null } };

const SIGLIP2 = 'ViT-SO400M-16-SigLIP2-384__webli';

Deno.test({
  name: 'search --like',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const album = `${ALBUMS_ROOT}/likeness`;
  const files = `${album}/files`;
  const path = (name: string) => `${files}/${name}`;
  const paths = (hits: Hit[]) => hits.map((hit) => hit.path);

  const write = async (at: string, vector: number[]) => {
    const handle = await vfs.open(ADMIN_ACCESS, at, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
  };
  const file = async (name: string, mimetype: string, sha256?: string) => {
    await vfs.create(ADMIN_ACCESS, 'file', files, name, { attrs: { name, mimetype, ...(sha256 ? { sha256 } : {}) } });
    return (await vfs.get(ADMIN_ACCESS, path(name))).id;
  };
  /** Picture vectors where `embed-picture` puts them: `embedding` for a photo, `k<N>` for a video. */
  const embed = async (name: string, vectors: Record<string, number[]>) => {
    await vfs.create(ADMIN_ACCESS, 'directory', path(name), 'metadata');
    await vfs.create(ADMIN_ACCESS, 'directory', `${path(name)}/metadata`, 'picture');
    for (const [vectorName, vector] of Object.entries(vectors)) {
      await vfs.create(ADMIN_ACCESS, 'embedding', `${path(name)}/metadata/picture`, vectorName, { attrs: { embeddingType: 'picture_siglip2', capacity: 3 } });
      await write(`${path(name)}/metadata/picture/${vectorName}`, vector);
    }
    await vfs.update(ADMIN_ACCESS, `${path(name)}/metadata/picture`, { attrs: { embeddedBy: SIGLIP2 } });
  };

  try {
    // The stack below is written by hand; an album refresh racing it would rewrite it.
    for (const service of ['archive-bridge', 'album-metadata']) await cmd.shouldSucceed(`service stop ${service}`);
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'likeness', { attrs: { name: 'Likeness' } });
    await vfs.create(ADMIN_ACCESS, 'directory', album, 'files');
    const boat = await file('boat.jpg', 'image/jpeg', 'aaaa');
    // The same bytes imported twice, with a vector of its own.
    await file('boat-copy.jpg', 'image/jpeg', 'aaaa');
    const burst = await file('boat-burst.jpg', 'image/jpeg');
    await file('boat-far.jpg', 'image/jpeg');
    await file('field.jpg', 'image/jpeg');
    await file('clip.mp4', 'video/mp4');
    await file('unembedded.jpg', 'image/jpeg');
    await file('notes.txt', 'text/plain');
    await embed('boat.jpg', { embedding: [1, 0, 0] });
    await embed('boat-copy.jpg', { embedding: [1, 0, 0] });
    await embed('boat-burst.jpg', { embedding: [0.99, 0.01, 0] });
    await embed('boat-far.jpg', { embedding: [0.8, 0.3, 0] });
    await embed('field.jpg', { embedding: [0.1, 0, 1] });
    // One keyframe of a field, one of a boat: the video is as near as its best one.
    await embed('clip.mp4', { k0: [0, 0.2, 1], k1: [0.95, 0.05, 0] });
    await vfs.update(ADMIN_ACCESS, album, {
      attrs: {
        mediaStacks: {
          version: 1,
          threshold: 0.85,
          maxGapSeconds: 10,
          sourceSignature: 'test',
          computedAt: '2012-01-01T00:01:00Z',
          excludedIds: [],
          groups: [{ frontId: boat, memberIds: [boat, burst] }],
        },
      },
    });

    await t.step('search-media says it ranks by a picture', async () => {
      const kinds = await client.execJson<{ like?: boolean }>('search-media --kinds');
      assertEquals(kinds.like, true);
    });

    await t.step('nearest first by similarity, without the picture itself, its copy or its stack', async () => {
      const out = await client.execJson<{ results: Hit[] }>(`search-media --like ${path('boat.jpg')} -l 10`);
      assertEquals(paths(out.results).slice(0, 2), [path('clip.mp4'), path('boat-far.jpg')]);
      assert(!paths(out.results).includes(path('boat.jpg')));
      assert(!paths(out.results).includes(path('boat-burst.jpg')));
      assert(!paths(out.results).includes(path('boat-copy.jpg')));
      // The score is the cosine, not a rank: the video's boat keyframe, then the farther boat.
      assertAlmostEquals(out.results[0].score, 0.95 / Math.hypot(0.95, 0.05), 1e-6);
      assertAlmostEquals(out.results[1].score, 0.8 / Math.hypot(0.8, 0.3), 1e-6);
      assertEquals(out.results[0].id, (await vfs.get(ADMIN_ACCESS, path('clip.mp4'))).id);
    });

    await t.step('a video asks with each of its keyframes', async () => {
      const out = await client.execJson<{ results: Hit[] }>(`search-media --like ${path('clip.mp4')} -l 10`);
      // The field keyframe finds the field; the boat keyframe finds the boats.
      assertEquals(paths(out.results).slice(0, 5).sort(), [path('boat-burst.jpg'), path('boat-copy.jpg'), path('boat-far.jpg'), path('boat.jpg'), path('field.jpg')]);
      assert(!paths(out.results).includes(path('clip.mp4')));
    });

    await t.step('--within ranks only the files it names', async () => {
      const name = 'like-within.json';
      await vfs.create(ADMIN_ACCESS, 'file', '/tmp', name, { attrs: { name, mimetype: 'application/json' } });
      const handle = await vfs.open(ADMIN_ACCESS, `/tmp/${name}`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(JSON.stringify([(await vfs.get(ADMIN_ACCESS, path('field.jpg'))).id])));
      } finally {
        await handle.close();
      }
      const out = await client.execJson<{ results: Hit[] }>(`search-media --like ${path('boat.jpg')} --within /tmp/${name}`);
      assertEquals(paths(out.results), [path('field.jpg')]);
    });

    await t.step('a picture without vectors is embedded now, interactively, and kept nowhere', async () => {
      const stub = startStubEms({ ops: { 'vision.embed': { result: { embedding: [1, 0, 0], dimension: 3 }, producer: SIGLIP2 } } });
      try {
        const out = await client.execJson<{ results: Hit[] }>(`CFG_EMS_URL=${stub.url} search-media --like ${path('unembedded.jpg')} -l 10`);
        assertEquals(paths(out.results).slice(0, 2).sort(), [path('boat-copy.jpg'), path('boat.jpg')]);
        assertEquals(stub.requests.map((request) => request.op), ['vision.embed']);
        assertEquals((stub.requests[0].body.options as { priority?: string }).priority, 'interactive');
        assertEquals(await vfs.exists(ADMIN_ACCESS, `${path('unembedded.jpg')}/metadata`), false);

        // A picture put in /tmp to search with, which is how one from outside the archive arrives.
        await vfs.create(ADMIN_ACCESS, 'file', '/tmp', 'like-print.jpg', { attrs: { name: 'like-print.jpg', mimetype: 'image/jpeg' } });
        const scratch = await client.execJson<SearchAnswer>(`CFG_EMS_URL=${stub.url} search --like /tmp/like-print.jpg --kind photo -l 4`);
        assertEquals(paths(scratch.results), [path('boat-copy.jpg'), path('boat.jpg'), path('boat-burst.jpg'), path('boat-far.jpg')]);
        assertEquals(scratch.filters.like, '/tmp/like-print.jpg');
      } finally {
        await stub.close();
      }
    });

    await t.step('search --like drives the aggregator, and its filters narrow it', async () => {
      const all = await client.execJson<SearchAnswer>(`search --like ${path('boat.jpg')}`);
      assertEquals(paths(all.results).slice(0, 2), [path('clip.mp4'), path('boat-far.jpg')]);
      assertEquals(all.filters.like, path('boat.jpg'));
      const photos = await client.execJson<SearchAnswer>(`search --like ${path('boat.jpg')} --kind photo`);
      assertEquals(paths(photos.results)[0], path('boat-far.jpg'));
      assert(!paths(photos.results).includes(path('clip.mp4')));
    });

    await t.step('words with a picture, a missing picture, or one that is not a picture are refused', async () => {
      await cmd.shouldFailWith(`search --like ${path('boat.jpg')} sailboat`, 'takes no words');
      await cmd.shouldFailWith(`search --like ${files}/nothing.jpg`, 'no such file');
      await cmd.shouldFailWith(`search --like ${path('boat.jpg')} --kind album`, 'by a picture');
      await cmd.shouldFailWith(`search-media --like ${path('notes.txt')}`, 'not a picture or a video');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
