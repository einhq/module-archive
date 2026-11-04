/**
 * search-people — a person found by what they are called, on the `name` channel's scale.
 *
 * What is pinned here is where a match lands against the 0.75 that `search` takes as the person
 * meant: a name typed as whole words of the person's, with middle names or a double surname left
 * out, is meant, and above an album whose name those words start; a word that only starts one of
 * theirs, or a surname alone, is not.
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Hit = { path: string; name: string; score: number };

Deno.test({
  name: 'search-people',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const search = async (query: string) => (await client.execJson<{ results: Hit[] }>(`search-people '${query}'`)).results;

  try {
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/Anna_B_K_Andersson --name 'Anna B K Andersson'`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/Lisa_Berg --name 'Lisa Berg-Andersson'`);

    await t.step('whole words of the name, middle names left out, are the person meant', async () => {
      assertEquals((await search('Anna Andersson')).map((hit) => [hit.path, hit.score]), [[`${PEOPLE_ROOT}/Anna_B_K_Andersson`, 0.85]]);
    });

    await t.step('one part of a double surname is a whole word too', async () => {
      assertEquals((await search('Lisa Berg')).map((hit) => hit.score), [0.85]);
      assertEquals((await search('lisa andersson')).map((hit) => hit.score), [0.85]);
    });

    await t.step('whole words of the name rank above an album the words start', async () => {
      await client.exec(`mkdir -p ${ALBUMS_ROOT}`);
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/anna-andersson-i-paris --name 'Anna Andersson i Paris'`);
      const albums = (await client.execJson<{ results: Hit[] }>("search-album 'Anna Andersson'")).results;
      const [person] = await search('Anna Andersson');
      assertEquals(albums.map((hit) => hit.path), [`${ALBUMS_ROOT}/anna-andersson-i-paris`]);
      assertEquals(person.score > albums[0].score, true);
    });

    await t.step('a word that only starts one of the name, or a surname alone, stays partial', async () => {
      const partial = [...await search('Ann Andersson'), ...await search('Andersson')];
      assertEquals(partial.length > 0, true);
      assertEquals(partial.every((hit) => hit.score < 0.75), true);
    });
  } finally {
    await testCtx.teardown();
  }
});
