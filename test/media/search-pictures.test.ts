/**
 * The picture channel of a text search: the query through the picture embedder's text tower against
 * every picture vector.
 *
 * Pinned here: the lookup asks for about as many vectors as files wanted, and for more when a
 * video's keyframes take the places of other files (ein/core#1077); and `search` sees a change made
 * since it last asked the same, though it keeps the providers' answers for the next page.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type ProviderHit = { path: string; channel: string; score: number };
type SearchAnswer = { results: { path: string }[] };

const SIGLIP2 = 'ViT-SO400M-16-SigLIP2-384__webli';

Deno.test({
  name: 'search-media pictures',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const files = `${ALBUMS_ROOT}/sea/files`;
  const path = (name: string) => `${files}/${name}`;
  const write = async (at: string, vector: number[]) => {
    const handle = await vfs.open(ADMIN_ACCESS, at, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
  };
  /** A file with picture vectors where `embed-picture` puts them: `embedding` for a photo, `k<N>` for a video. */
  const picture = async (name: string, mimetype: string, vectors: Record<string, number[]>) => {
    await vfs.create(ADMIN_ACCESS, 'file', files, name, { attrs: { name, mimetype } });
    await vfs.create(ADMIN_ACCESS, 'directory', path(name), 'metadata');
    await vfs.create(ADMIN_ACCESS, 'directory', `${path(name)}/metadata`, 'picture');
    for (const [vectorName, vector] of Object.entries(vectors)) {
      await vfs.create(ADMIN_ACCESS, 'embedding', `${path(name)}/metadata/picture`, vectorName, { attrs: { embeddingType: 'picture_siglip2', capacity: 3 } });
      await write(`${path(name)}/metadata/picture/${vectorName}`, vector);
    }
    await vfs.update(ADMIN_ACCESS, `${path(name)}/metadata/picture`, { attrs: { embeddedBy: SIGLIP2 } });
  };

  // Every query points at the boats in the pictures' space, and away from every text.
  const stub = startStubEms({
    ops: {
      'vision.embed_text': { result: { embedding: [1, 0, 0] }, producer: SIGLIP2 },
      'text.embed': (body: Record<string, unknown>) => ({
        result: { embeddings: (body.texts as string[]).map(() => [0, 0, 1]), dimension: 3 },
        producer: 'bge-m3',
      }),
    },
  });

  try {
    await client.exec(`mkdir -p ${files}`);
    // Three keyframes nearer the query than any photo: the first vectors found are all one file.
    await picture('clip.mp4', 'video/mp4', { k0: [1, 0, 0], k1: [1, 0.01, 0], k2: [1, 0, 0.01] });
    await picture('boat.jpg', 'image/jpeg', { embedding: [0.9, 0.2, 0] });

    await t.step('a video found by its keyframes leaves room for the files after it', async () => {
      const out = await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-media 'a boat' -l 2`);
      assertEquals(out.results.filter((hit) => hit.channel === 'picture').map((hit) => hit.path), [path('clip.mp4'), path('boat.jpg')]);
    });

    await t.step('a search asked again sees a picture added since', async () => {
      const search = () => client.execJson<SearchAnswer>(`CFG_EMS_URL=${stub.url} search 'a boat' --kind photo,video`);
      assertEquals((await search()).results.map((hit) => hit.path).sort(), [path('boat.jpg'), path('clip.mp4')]);
      await picture('dinghy.jpg', 'image/jpeg', { embedding: [0.95, 0.1, 0] });
      assertEquals((await search()).results.map((hit) => hit.path).sort(), [path('boat.jpg'), path('clip.mp4'), path('dinghy.jpg')]);
    });
  } finally {
    await stub.close();
    client.close();
    await testCtx.teardown();
  }
});
