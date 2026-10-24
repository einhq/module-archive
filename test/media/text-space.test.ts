/**
 * The text space against a stub EMS: `media-reembed` embeds the stored text (extracted text,
 * transcripts) from the text nodes alone, a second run finds nothing to do, and search reads it —
 * the query embedded as a query, the hits climbed back to their files, a transcript hit with its
 * moment and, said in so many words, confident, and a text's words found by a phrase as well as
 * by meaning. A hand-written description is embedded when it is set, found, kept in step when edited
 * and removed when cleared. A long document is embedded in parts, so what it says past its opening
 * is found. Given paths, `media-reembed` does the same for those files alone.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });
const JINA = 'jina-embeddings-v5-text-small';

/**
 * A toy space: one axis per topic word, so a query and the text about it meet at cosine 1, and an
 * axis of its own for text about none of them.
 */
const TOPICS = ['segel', 'tårta', 'fiske', 'midsommar'];
const toy = (text: string): number[] => {
  const vector = TOPICS.map((topic) => text.toLowerCase().includes(topic) ? 1 : 0);
  return [...vector, vector.some(Boolean) ? 0 : 1];
};

type Hit = { path: string; channel: string; score: number; atSeconds?: number; confident?: boolean };

Deno.test({
  name: 'current text space',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const write = async (path: string, body: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };

  const stub = startStubEms({
    capabilities: { models: { text_embed: JINA } },
    ops: { 'text.embed': (body) => ({ result: { embeddings: (body.texts as string[]).map(toy), dimension: 5 }, producer: JINA }) },
  });
  const env = `CFG_EMS_URL=${stub.url}`;

  const album = `${ALBUMS_ROOT}/sommar`;
  const photo = `${album}/files/segel.jpg`;
  const scan = `${album}/files/kvitto.jpg`;
  const clip = `${album}/files/klipp.mp4`;

  try {
    // The background sweeps write albums of their own accord — `album-metadata` an album's span and
    // cover, staging's organizer its auto albums — and would race the nodes this test makes.
    for (const service of ['album-metadata', 'staging-organizer']) await cmd.shouldSucceed(`service stop ${service}`);
    await cmd.shouldSucceed(`mknode -t album ${album} --as name=sommar`);
    await cmd.shouldSucceed(`mkdir -p ${album}/files`);
    await cmd.shouldSucceed(`mknode -t file ${photo} --as name=segel.jpg --as mimetype=image/jpeg`);
    await cmd.shouldSucceed(`mknode -t file ${scan} --as name=kvitto.jpg --as mimetype=image/jpeg`);
    await cmd.shouldSucceed(`mknode -t file ${clip} --as name=klipp.mp4 --as mimetype=video/mp4`);
    for (const file of [photo, scan, clip]) await cmd.shouldSucceed(`mkdir -p ${file}/metadata`);

    // Text read out of two pictures, a sign and a receipt.
    await cmd.shouldSucceed(`mknode -t file ${photo}/metadata/content --as mimetype=text/plain`);
    await write(`${photo}/metadata/content`, 'Segelbåtar uthyres');
    await cmd.shouldSucceed(`mknode -t file ${scan}/metadata/content --as mimetype=text/plain`);
    await write(`${scan}/metadata/content`, 'Kvitto: en tårta, 245 kr');
    // A transcript.
    await cmd.shouldSucceed(`mknode -t file ${clip}/metadata/transcript --as mimetype=text/vtt --as transcribedAt=2026-09-01T10:00:00Z`);
    await write(
      `${clip}/metadata/transcript`,
      'WEBVTT\n\n00:00:00.000 --> 00:00:20.000\nHär börjar vi.\n\n00:01:10.000 --> 00:01:25.000\nNu ska vi åka och fiske i sjön.\n',
    );
    // A recording in which nothing was said.
    const quiet = `${album}/files/tyst.wav`;
    await cmd.shouldSucceed(`mknode -t file ${quiet} --as name=tyst.wav --as mimetype=audio/wav`);
    await cmd.shouldSucceed(`mkdir -p ${quiet}/metadata`);
    await cmd.shouldSucceed(`mknode -t file ${quiet}/metadata/transcript --as mimetype=text/vtt`);
    await write(`${quiet}/metadata/transcript`, 'WEBVTT\n\n');
    // A job log a document pipeline once indexed: system files, never the archive's text.
    await cmd.shouldSucceed('mkdir -p /var/logs/jobs/scan/stdout.log/metadata');
    await cmd.shouldSucceed('mknode -t file /var/logs/jobs/scan/stdout.log/metadata/content --as mimetype=text/plain');
    await write('/var/logs/jobs/scan/stdout.log/metadata/content', 'Scanned 12 file(s), segel och tårta');
    // A plain-text document: a file, but not a text node of anything.
    await cmd.shouldSucceed(`mknode -t file ${album}/files/notes.txt --as name=notes.txt --as mimetype=text/plain`);
    await write(`${album}/files/notes.txt`, 'Segel och tårta');

    await t.step('media-reembed embeds the text nodes, and nothing but the vector', async () => {
      const out = await client.execJson<{ embedded: number; transcripts: number; failed: number; complete: boolean }>(`${env} media-reembed`);
      assertEquals([out.embedded, out.transcripts, out.failed, out.complete], [2, 1, 0, true]);

      const sign = await vfs.get(ADMIN_ACCESS, `${photo}/metadata/content/text_jina5s`);
      assertEquals(sign.attrs.embeddingType, 'text_jina5s');
      assertEquals(sign.attrs.embeddedBy, JINA);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${album}/files/notes.txt/text_jina5s`), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/var/logs/jobs/scan/stdout.log/metadata/content/text_jina5s'), false);
      // Nothing said is done too: an empty set, stamped, so the next pass does not read it again.
      const silence = await vfs.get(ADMIN_ACCESS, `${quiet}/metadata/transcript/text_jina5s`);
      assertEquals([silence.type, silence.attrs.embeddedBy], ['directory', JINA]);

      assertEquals((await vfs.get(ADMIN_ACCESS, `${scan}/metadata/content/text_jina5s`)).attrs.embeddingType, 'text_jina5s');

      const chunks = (await vfs.children(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).map((c) => c.name).sort();
      assertEquals(chunks, ['t0', 't70']);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s/t70`)).attrs.startSeconds, 70);
      // Stamped with the length it was cut at, so a new length re-chunks it.
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).attrs.chunkSeconds, 60);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).attrs.embeddedBy, JINA);

      // Documents, not queries: the embedder reads them differently.
      const embeds = stub.requests.filter((r) => r.op === 'text.embed');
      assert(embeds.length > 0 && embeds.every((r) => r.body.model === 'current' && r.body.role === 'document'));
    });

    await t.step('a second run finds everything done', async () => {
      const before = stub.requests.length;
      const out = await client.execJson<{ embedded: number; transcripts: number; skipped: number; complete: boolean }>(`${env} media-reembed`);
      assertEquals([out.embedded, out.transcripts, out.skipped, out.complete], [0, 0, 4, true]);
      assertEquals(stub.requests.slice(before).filter((r) => r.op === 'text.embed').length, 0);
    });

    const search = (command: string, query: string) => client.execJson<{ results: Hit[] }>(`${env} ${command} '${query}' -l 10`);

    await t.step('search-media reads the text space, a query embedded as a query', async () => {
      const boats = await search('search-media', 'segelbåt');
      assertEquals(boats.results.map((hit) => hit.path), [photo]);
      assertEquals(stub.requests.filter((r) => r.op === 'text.embed').at(-1)!.body.role, 'query');

      // "tårta" is written on the receipt in so many words, which is the file meant.
      const cake = await search('search-media', 'tårta');
      assertEquals(cake.results.map((hit) => hit.path), [scan]);
      assertEquals([cake.results[0].channel, cake.results[0].confident], ['content', true]);

      // Meaning alone is not confident: only the transcript's similarities were measured.
      assertEquals(boats.results[0].confident, undefined);

      const spoken = await search('search-media', 'fiske');
      const hit = spoken.results.find((result) => result.path === clip);
      assert(hit, JSON.stringify(spoken.results));
      assertEquals(hit.atSeconds, 70);
      // Said in so many words: the recording meant, which `search` weighs as a name.
      assertEquals(hit.confident, true);
    });

    await t.step('what is said is found by its words, at the minute that says them', async () => {
      // The chunk carries the text it was embedded from.
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s/t70`)).attrs.text, 'Nu ska vi åka och fiske i sjön.');
      // "sjön" is about no topic, so its vector meets the minute about nothing, at 0 s; its words are
      // said at 70 s.
      const lake = await search('search-media', 'Sjön');
      const hit = lake.results.find((result) => result.path === clip && result.channel === 'transcript');
      assert(hit, JSON.stringify(lake.results));
      assertEquals([hit.atSeconds, hit.confident], [70, true]);
      assert(hit.score > 1, String(hit.score));

      // Inside a longer word it is found, below what says it as words of its own.
      const inside = (await search('search-media', 'sjö')).results.find((result) => result.path === clip && result.channel === 'transcript');
      assert(inside, 'not found inside a word');
      assertEquals(inside.atSeconds, 70);
      assert(inside.score > 1 && inside.score < hit.score, String(inside.score));

      // A phrase is matched whole, and a query too short to index is not matched by words.
      assertEquals((await search('search-media', 'åka och fiske')).results.find((result) => result.channel === 'transcript')?.atSeconds, 70);
      assertEquals((await search('search-media', 'sjön åka')).results.some((result) => result.channel === 'transcript' && (result.score > 1)), false);
      assertEquals((await search('search-media', 'nu')).results.some((result) => result.channel === 'transcript' && (result.score > 1)), false);

      // Inside a set without the clip, its words are no answer.
      await vfs.create(ADMIN_ACCESS, 'file', '/tmp', 'photo-only.json', { attrs: { name: 'photo-only.json', mimetype: 'application/json' } });
      await write('/tmp/photo-only.json', JSON.stringify([(await vfs.get(ADMIN_ACCESS, photo)).id]));
      const within = await client.execJson<{ results: Hit[] }>(`${env} search-media sjön --within /tmp/photo-only.json`);
      assertEquals(within.results.filter((result) => result.channel === 'transcript'), []);
    });

    await t.step('what is written is found by its words, which its vector does not say', async () => {
      // The vector carries the text it was embedded from.
      assertEquals((await vfs.get(ADMIN_ACCESS, `${photo}/metadata/content/text_jina5s`)).attrs.text, 'Segelbåtar uthyres');
      // "uthyres" is about no topic, so its vector meets nothing; the sign says it.
      const rent = await search('search-media', 'Uthyres');
      const hit = rent.results.find((result) => result.path === photo && result.channel === 'content');
      assert(hit, JSON.stringify(rent.results));
      assertEquals(hit.confident, true);
      assert(hit.score > 1, String(hit.score));

      // Inside a longer word it is found, below what says it as words of its own, and not confident.
      const inside = (await search('search-media', 'hyr')).results.find((result) => result.path === photo && result.channel === 'content');
      assert(inside && inside.score > 1 && inside.score < hit.score && !inside.confident, JSON.stringify(inside));

      // Inside a set without the sign, its words are no answer.
      await vfs.create(ADMIN_ACCESS, 'file', '/tmp', 'clip-only.json', { attrs: { name: 'clip-only.json', mimetype: 'application/json' } });
      await write('/tmp/clip-only.json', JSON.stringify([(await vfs.get(ADMIN_ACCESS, clip)).id]));
      const within = await client.execJson<{ results: Hit[] }>(`${env} search-media uthyres --within /tmp/clip-only.json`);
      assertEquals(within.results.filter((result) => result.channel === 'content'), []);
    });

    const hand = `${album}/files/hand.jpg`;
    const written = `${album}/files/written.jpg`;

    await t.step('a hand-written description is embedded as it is set, and search finds it', async () => {
      await cmd.shouldSucceed(`mknode -t file ${hand} --as name=hand.jpg --as mimetype=image/jpeg`);
      const set = await client.exec(`${env} file-set-description --text 'Mormor dansar runt midsommarstången' ${hand}`);
      assertEquals(set.success, true, set.error);
      const vector = await vfs.get(ADMIN_ACCESS, `${hand}/metadata/authored/text_jina5s`);
      assertEquals(vector.attrs.embeddedBy, JINA);
      assertEquals(typeof vector.attrs.authoredHash, 'string');

      const found = await search('search-media', 'midsommar');
      assertEquals(found.results.map((hit) => hit.path), [hand]);
    });

    await t.step('media-reembed embeds a description it finds by its attr, and an edited one again', async () => {
      await cmd.shouldSucceed(`mknode -t file ${written} --as name=written.jpg --as mimetype=image/jpeg`);
      await vfs.update(ADMIN_ACCESS, written, { attrs: { description: 'Pappa och fiske vid bryggan' } });
      const first = await client.execJson<{ authored: number; failed: number }>(`${env} media-reembed`);
      assertEquals([first.authored, first.failed], [1, 0]);
      assertEquals((await search('search-media', 'fiske')).results.some((hit) => hit.path === written), true);

      await vfs.update(ADMIN_ACCESS, hand, { attrs: { description: 'Mormor bakar en tårta' } });
      const edited = await client.execJson<{ authored: number }>(`${env} media-reembed`);
      assertEquals(edited.authored, 1);
      assertEquals((await search('search-media', 'tårta')).results.some((hit) => hit.path === hand), true);
      assertEquals((await search('search-media', 'midsommar')).results.some((hit) => hit.path === hand), false);
    });

    await t.step('a cleared description takes its vector with it', async () => {
      const cleared = await client.exec(`${env} file-set-description --text '' ${hand}`);
      assertEquals(cleared.success, true, cleared.error);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${hand}/metadata/authored`), false);
    });

    await t.step('a long document is embedded in parts, and found by what it says past its opening', async () => {
      const report = `${album}/files/rapport.pdf`;
      await cmd.shouldSucceed(`mknode -t file ${report} --as name=rapport.pdf --as mimetype=application/pdf`);
      await cmd.shouldSucceed(`mkdir -p ${report}/metadata`);
      await cmd.shouldSucceed(`mknode -t file ${report}/metadata/content --as mimetype=text/plain`);
      const filler = Array.from({ length: 6 }, (_, i) => `Avsnitt ${i}. ${'Styrelsen gick igenom budgeten och protokollet. '.repeat(30)}`);
      await write(`${report}/metadata/content`, [...filler, 'Till sist: sommarens fiske vid sjön.'].join('\n\n'));
      // One current vector of the opening only, which a run must redo.
      await cmd.shouldSucceed(`mknode -t embedding ${report}/metadata/content/text_jina5s --as embeddingType=text_jina5s --an capacity=5 --as embeddedBy=${JINA}`);
      await write(`${report}/metadata/content/text_jina5s`, JSON.stringify([0, 0, 0, 0, 1]));

      const out = await client.execJson<{ embedded: number; failed: number }>(`${env} media-reembed`);
      assertEquals([out.embedded, out.failed], [1, 0]);
      const dir = await vfs.get(ADMIN_ACCESS, `${report}/metadata/content/text_jina5s`);
      assertEquals([dir.type, dir.attrs.embeddedBy], ['directory', JINA]);
      const parts = (await vfs.children(ADMIN_ACCESS, `${report}/metadata/content/text_jina5s`)).map((c) => c.name);
      assert(parts.length > 3 && parts.includes('c0'), JSON.stringify(parts));

      assertEquals((await search('search-media', 'fiske')).results.some((hit) => hit.path === report), true);
      // Each part carries its own words, so a phrase past the opening is found by them too.
      const lake = (await search('search-media', 'sommarens fiske')).results.find((hit) => hit.path === report && hit.channel === 'content');
      assert(lake?.confident, JSON.stringify(lake));

      const again = await client.execJson<{ embedded: number }>(`${env} media-reembed`);
      assertEquals(again.embedded, 0);
    });

    await t.step('a chunk set cut at another length is chunked again', async () => {
      // A set with no stamped length, cut at 30 s.
      await vfs.update(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`, { attrs: { chunkSeconds: 30 } });
      const out = await client.execJson<{ transcripts: number }>(`${env} media-reembed`);
      assertEquals(out.transcripts, 1);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).attrs.chunkSeconds, 60);
      assertEquals((await client.execJson<{ transcripts: number }>(`${env} media-reembed`)).transcripts, 0);
    });

    await t.step('a re-embed with -f replaces a chunk set rather than adding to it', async () => {
      await write(`${clip}/metadata/transcript`, 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nBara fiske nu.\n');
      const out = await client.exec(`${env} media-reembed -f`);
      assertEquals(out.success, true, out.error);
      const chunks = (await vfs.children(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).map((c) => c.name);
      assertEquals(chunks, ['t0']);
    });

    await t.step('media-reembed with paths embeds what those files lack, and nothing elsewhere', async () => {
      await vfs.update(ADMIN_ACCESS, `${photo}/metadata/content/text_jina5s`, { attrs: { embeddedBy: 'another-text-model' } });
      await vfs.update(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`, { attrs: { chunkSeconds: 30 } });
      await vfs.update(ADMIN_ACCESS, scan, { attrs: { description: 'Ett kvitto på en tårta' } });

      const one = await client.execJson<{ embedded: number; transcripts: number; authored: number; failed: number }>(`${env} media-reembed ${photo}`);
      assertEquals([one.embedded, one.transcripts, one.authored, one.failed], [1, 0, 0, 0]);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${photo}/metadata/content/text_jina5s`)).attrs.embeddedBy, JINA);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).attrs.chunkSeconds, 30);

      const two = await client.execJson<{ embedded: number; transcripts: number; authored: number; skipped: number }>(`${env} media-reembed ${clip} ${scan}`);
      assertEquals([two.embedded, two.transcripts, two.authored, two.skipped], [0, 1, 1, 1]);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${clip}/metadata/transcript/text_jina5s`)).attrs.chunkSeconds, 60);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${scan}/metadata/authored/text_jina5s`), true);

      const again = await client.execJson<{ embedded: number; transcripts: number; authored: number }>(`${env} media-reembed ${photo} ${clip} ${scan}`);
      assertEquals([again.embedded, again.transcripts, again.authored], [0, 0, 0]);
    });
  } finally {
    await stub.close();
    await client.close();
    await testCtx.teardown();
  }
});
