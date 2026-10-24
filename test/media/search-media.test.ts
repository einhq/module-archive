/**
 * search-media's name half — the question a content embedding cannot answer.
 *
 * "DSC_4471" is a question about what a file is *called*, and nothing in the
 * picture says it. The content half needs an inference server and
 * belongs to the container tier; what is pinned here is the half that runs
 * without one: that a rendition is never a result, that the ranking is exact > prefix >
 * substring, and that a name matches wherever the query sits inside it.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertAlmostEquals, assertEquals, assertLess } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type ProviderHit = { path: string; channel: string; score: number; name: string; id?: string };

Deno.test({
  name: 'search-media',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const paths = (hits: { path: string }[]) => hits.map((h) => h.path).sort();
  const search = (args: string) => client.execJson<{ results: ProviderHit[] }>(`search-media ${args}`);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/vasan/files`);
    const file = (name: string, attrs = '') => cmd.shouldSucceed(`mknode -t file ${ALBUMS_ROOT}/vasan/files/${name} --as name=${name} --as mimetype=image/jpeg ${attrs}`);

    await file('DSC_4471.JPG');
    await file('DSC_4472.JPG');
    await file('vasaloppet.jpg');
    await file('vasaloppet-2011.jpg');
    await file('vasaloppet.jpg-thumb.jpg', '--as sourceId=01ABCDEFGHJKMNPQRSTVWXYZ00');
    // Not media: reachable by name, but not something this provider returns.
    await cmd.shouldSucceed(`mknode -t file ${ALBUMS_ROOT}/vasan/files/vasaloppet.txt --as name=vasaloppet.txt --as mimetype=text/plain`);

    await t.step('matches a filename mid-string', async () => {
      const out = await search('4471');
      assertEquals(paths(out.results), [`${ALBUMS_ROOT}/vasan/files/DSC_4471.JPG`]);
    });

    await t.step('matches case-insensitively', async () => {
      const out = await search('dsc_4472');
      assertEquals(paths(out.results), [`${ALBUMS_ROOT}/vasan/files/DSC_4472.JPG`]);
    });

    await t.step('an exact name outranks a prefix', async () => {
      // Both files match `vasaloppet`; only one *is* it. The extension is not
      // part of what a file is called, so the stem counts as exact.
      const out = await search('vasaloppet');
      assertEquals(out.results[0].path, `${ALBUMS_ROOT}/vasan/files/vasaloppet.jpg`);
      assertEquals(out.results[0].score, 0.95);
      assertEquals(out.results[1].path, `${ALBUMS_ROOT}/vasan/files/vasaloppet-2011.jpg`);
      assertEquals(out.results[1].score, 0.7);
      assertEquals(out.results.map((hit) => hit.channel), ['name', 'name']);
    });

    await t.step('a rendition is never a result, nor is a non-media file', async () => {
      // The thumb's name contains the query and it is excluded for carrying a
      // sourceId; the .txt is excluded for its mimetype. Both are reachable.
      const out = await search('vasaloppet');
      assertEquals(paths(out.results), [
        `${ALBUMS_ROOT}/vasan/files/vasaloppet-2011.jpg`,
        `${ALBUMS_ROOT}/vasan/files/vasaloppet.jpg`,
      ]);
    });

    await t.step('no match is an empty list, not an error', async () => {
      const out = await search('kajakpaddling');
      assertEquals(out.results, []);
    });

    /** The current embedder's answer: a boat query points at the boats, anything else away from them. */
    const JINA = (body: Record<string, unknown>) => ({
      result: { embeddings: (body.texts as string[]).map((text) => text.includes('boat') ? [1, 0, 0] : [0, 0, 1]), dimension: 3 },
      producer: 'jina-embeddings-v5-text-small',
    });

    await t.step('a content hit carries the file id, climbed from its embedding', async () => {
      // A text embedding where index-document puts a picture's text, and a stub EMS that embeds every
      // query to the same vector, so the content half matches it exactly.
      const file = `${ALBUMS_ROOT}/vasan/files/DSC_4471.JPG`;
      await cmd.shouldSucceed(`mkdir -p ${file}/metadata`);
      await cmd.shouldSucceed(`mknode -t text ${file}/metadata/content`);
      await cmd.shouldSucceed(`mknode -t embedding ${file}/metadata/content/text_jina5s --as embeddingType=text_jina5s --an capacity=3`);
      const handle = await vfs.open(ADMIN_ACCESS, `${file}/metadata/content/text_jina5s`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(JSON.stringify([1, 0, 0])));
      } finally {
        await handle.close();
      }
      const stub = startStubEms({ ops: { 'text.embed': JINA } });
      try {
        const out = await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-media 'a boat'`);
        assertEquals(out.results.map((hit) => [hit.path, hit.channel]), [[file, 'content']]);
        const node = await vfs.get(ADMIN_ACCESS, file);
        assertEquals(out.results[0].id, node.id);
      } finally {
        await stub.close();
      }
    });

    await t.step("an album description's text is no hit, by its meaning or its words", async () => {
      // The album's description, indexed as a document is: a vector that matches the query, and
      // the query's words in its text.
      const description = `${ALBUMS_ROOT}/vasan/metadata/description`;
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/vasan/metadata`);
      await cmd.shouldSucceed(`mknode -t file ${description} --as mimetype=text/plain`);
      await cmd.shouldSucceed(`mkdir -p ${description}/metadata`);
      await cmd.shouldSucceed(`mknode -t text ${description}/metadata/content`);
      await cmd.shouldSucceed(
        `mknode -t embedding ${description}/metadata/content/text_jina5s --as embeddingType=text_jina5s --an capacity=3 --as 'text=A boat on the lake'`,
      );
      const handle = await vfs.open(ADMIN_ACCESS, `${description}/metadata/content/text_jina5s`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(JSON.stringify([1, 0, 0])));
      } finally {
        await handle.close();
      }
      const stub = startStubEms({ ops: { 'text.embed': JINA } });
      try {
        const out = await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-media 'a boat'`);
        assertEquals(out.results.map((hit) => [hit.path, hit.channel]), [[`${ALBUMS_ROOT}/vasan/files/DSC_4471.JPG`, 'content']]);
      } finally {
        await stub.close();
      }
    });

    await t.step('--within ranks only the files it names, the far one included, and names too', async () => {
      // DSC_4471 is the exact content match; DSC_4472's text points the other way.
      const near = `${ALBUMS_ROOT}/vasan/files/DSC_4471.JPG`;
      const far = `${ALBUMS_ROOT}/vasan/files/DSC_4472.JPG`;
      await cmd.shouldSucceed(`mkdir -p ${far}/metadata`);
      await cmd.shouldSucceed(`mknode -t text ${far}/metadata/content`);
      await cmd.shouldSucceed(`mknode -t embedding ${far}/metadata/content/text_jina5s --as embeddingType=text_jina5s --an capacity=3`);
      const handle = await vfs.open(ADMIN_ACCESS, `${far}/metadata/content/text_jina5s`, { mode: 'w' });
      try {
        // A weak match (cosine 0.45), but above the text space's 0.35 floor.
        await handle.write(new TextEncoder().encode(JSON.stringify([0.5, 1, 0])));
      } finally {
        await handle.close();
      }
      const within = async (name: string, ids: string[]) => {
        await vfs.create(ADMIN_ACCESS, 'file', '/tmp', name, { attrs: { name, mimetype: 'application/json' } });
        const file = await vfs.open(ADMIN_ACCESS, `/tmp/${name}`, { mode: 'w' });
        try {
          await file.write(new TextEncoder().encode(JSON.stringify(ids)));
        } finally {
          await file.close();
        }
        return `/tmp/${name}`;
      };
      const farOnly = await within('far.json', [(await vfs.get(ADMIN_ACCESS, far)).id]);
      const stub = startStubEms({ ops: { 'text.embed': JINA } });
      try {
        const everywhere = await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-media 'a boat'`);
        assertEquals(everywhere.results[0].path, near);
        const inside = await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-media 'a boat' --within ${farOnly}`);
        assertEquals(inside.results.map((hit) => hit.path), [far]);
        // A name match outside the set is not an answer either.
        assertEquals((await client.execJson<{ results: ProviderHit[] }>(`CFG_EMS_URL=${stub.url} search-media vasaloppet --within ${farOnly}`)).results, []);
      } finally {
        await stub.close();
      }
    });

    await t.step('a cancelled search hangs up its query embeds, which carry a minute of deadline', async () => {
      const stub = startStubEms({ ops: { 'text.embed': JINA, 'vision.embed_text': { result: { embedding: [1, 0, 0] } } }, delayMs: 30_000 });
      try {
        const controller = new AbortController();
        const started = Date.now();
        const search = client.exec(`CFG_EMS_URL=${stub.url} search 'a boat'`, { signal: controller.signal, timeout: 20_000 });
        // Cancelled once the providers' embeds are waiting on EMS: both of search-media's, and the
        // other providers' text embeds.
        const ops = () => new Set(stub.requests.map((request) => request.op));
        while (ops().size < 2 && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 20));
        await new Promise((resolve) => setTimeout(resolve, 300));
        controller.abort();
        await search;
        assertLess(Date.now() - started, 10_000);

        const deadlines = stub.requests.map((request) => (request.body.options as { deadline?: number } | undefined)?.deadline ?? 0);
        for (const deadline of deadlines) assertAlmostEquals(deadline, started / 1000 + 60, 5);
        for (let i = 0; i < 100 && stub.hungUp.length < stub.requests.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
        assertEquals([...stub.hungUp].sort(), stub.requests.map((request) => request.op).sort());
        assertEquals(ops(), new Set(['text.embed', 'vision.embed_text']));
      } finally {
        await stub.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
