/**
 * search-document ranks documents, and only documents: the text pool it searches is shared with
 * every photo caption, so it names its own candidates first. With a set to rank within (`--within`,
 * a person's files) and no document in it, it answers at once without asking for an embedding.
 * A long document's text is in parts (`content/<type>/c<N>`), and it is one hit however many match.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Hit = { path: string; score: number };

Deno.test({ name: 'search-document', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const dir = `${ALBUMS_ROOT}/papers`;

  /** A file with a text vector at `<file>/metadata/content/text_jina5s`, as index-document writes them. */
  const embedded = async (name: string, mimetype: string, vector: number[]) => {
    const file = `${dir}/${name}`;
    await cmd.shouldSucceed(`mknode -t file ${file} --as name=${name} --as mimetype=${mimetype}`);
    await cmd.shouldSucceed(`mkdir -p ${file}/metadata`);
    await cmd.shouldSucceed(`mknode -t file ${file}/metadata/content --as mimetype=text/plain`);
    await cmd.shouldSucceed(`mknode -t embedding ${file}/metadata/content/text_jina5s --as embeddingType=text_jina5s --an capacity=3`);
    const handle = await vfs.open(ADMIN_ACCESS, `${file}/metadata/content/text_jina5s`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
    return file;
  };

  const within = async (name: string, paths: string[]) => {
    const ids = await Promise.all(paths.map(async (path) => (await vfs.get(ADMIN_ACCESS, path)).id));
    await vfs.create(ADMIN_ACCESS, 'file', '/tmp', name, { attrs: { name, mimetype: 'application/json' } });
    const file = await vfs.open(ADMIN_ACCESS, `/tmp/${name}`, { mode: 'w' });
    try {
      await file.write(new TextEncoder().encode(JSON.stringify(ids)));
    } finally {
      await file.close();
    }
    return `/tmp/${name}`;
  };

  const stub = startStubEms({
    ops: { 'text.embed': (body) => ({ result: { embeddings: (body.texts as string[]).map(() => [1, 0, 0]), dimension: 3 }, producer: 'jina-embeddings-v5-text-small' }) },
  });
  const search = (args: string) => client.execJson<{ results: Hit[] }>(`CFG_EMS_URL=${stub.url} search-document ${args}`);

  try {
    await cmd.shouldSucceed(`mkdir -p ${dir}`);
    const minutes = await embedded('minutes.pdf', 'application/pdf', [1, 0, 0]);
    const letter = await embedded('letter.txt', 'text/plain', [1, 0.6, 0]);
    // A photo whose text is the closest thing in the space: never a document hit.
    const photo = await embedded('sign.jpg', 'image/jpeg', [1, 0, 0]);

    await t.step('ranks documents, never the text of photos in the same space', async () => {
      const out = await search("'the board meeting'");
      assertEquals(out.results.map((hit) => hit.path), [minutes, letter]);
    });

    await t.step('--within ranks only the documents in the set', async () => {
      const out = await search(`'the board meeting' --within ${await within('letter.json', [letter, photo])}`);
      assertEquals(out.results.map((hit) => hit.path), [letter]);
    });

    await t.step('a set without documents answers at once, without embedding the query', async () => {
      const before = stub.requests.length;
      const out = await search(`'the board meeting' --within ${await within('photos.json', [photo])}`);
      assertEquals(out.results, []);
      assertEquals(stub.requests.length, before);
    });

    await t.step('a long document in parts is one hit, at its best part', async () => {
      const report = `${dir}/report.pdf`;
      await cmd.shouldSucceed(`mknode -t file ${report} --as name=report.pdf --as mimetype=application/pdf`);
      await cmd.shouldSucceed(`mkdir -p ${report}/metadata/content/text_jina5s`);
      for (const [name, vector] of [['c0', [0, 1, 0]], ['c1', [1, 0, 0]], ['c2', [0.9, 0.1, 0]]] as const) {
        const path = `${report}/metadata/content/text_jina5s/${name}`;
        await cmd.shouldSucceed(`mknode -t embedding ${path} --as embeddingType=text_jina5s --an capacity=3`);
        const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
        } finally {
          await handle.close();
        }
      }
      const out = await search(`'the board meeting' --within ${await within('report.json', [report, letter])}`);
      assertEquals(out.results.map((hit) => [hit.path, Math.round(hit.score * 100)]), [[report, 100], [letter, 86]]);
    });

    await t.step('--kinds says it ranks within a set, and leaves trees out', async () => {
      assertEquals(await client.execJson('search-document --kinds'), { kinds: ['document'], within: true, notWithin: true });
    });
  } finally {
    await stub.close();
    client.close();
    await testCtx.teardown();
  }
});
