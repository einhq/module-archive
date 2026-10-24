/**
 * person-relatives — a kin phrase walked through a small family tree, as a command.
 *
 * The walk itself is `kin.test.ts`'s business; this is what the command adds on top: a person
 * named by slug as well as by path, the Swedish chain an agent passes through verbatim, `--age`
 * turning into a capture-date span, and the two refusals — a phrase that is not kin words, and a
 * person that is not there — that must fail loudly rather than answer "nobody".
 *
 * Tree:   Gun (f, 1935) ── Tor (m, 1932)
 *                 │
 *        ┌────────┴────────┐
 *     Lena (f, 1960)    Maja (f, 1963)
 *        │
 *     Ebba (f, 1990)
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Relatives = {
  of: string;
  relation: string;
  relatives: { name: string; slug: string; path: string; born?: string; relation: { sv: string; en: string }; age?: number; taken?: { from: string; to: string } | null }[];
};

Deno.test({
  name: 'person-relatives',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const root = `${PEOPLE_ROOT}/rel`;

  try {
    await cmd.shouldSucceed(`mkdir -p ${root}`);
    for (
      const [slug, name, gender, born] of [
        ['gun', 'Gun', 'female', '1935'],
        ['tor', 'Tor', 'male', '1932'],
        ['lena', 'Lena', 'female', '1960'],
        ['maja', 'Maja', 'female', '1963'],
        ['ebba', 'Ebba', 'female', '1990-05-12'],
      ]
    ) {
      await cmd.shouldSucceed(`person-create ${root}/${slug} --name ${name} --gender ${gender} --born ${born}`);
    }
    for (const [child, parent] of [['lena', 'gun'], ['lena', 'tor'], ['maja', 'gun'], ['maja', 'tor'], ['ebba', 'lena']]) {
      await cmd.shouldSucceed(`person-set-parent ${root}/${child} ${root}/${parent}`);
    }

    await t.step('a single kin word', async () => {
      const result = await client.execJson<Relatives>(`person-relatives ${root}/ebba --relation mormor`);
      assertEquals(result.relatives.map((r) => r.name), ['Gun']);
    });

    await t.step('a person may be named by slug, as search-people hands one back', async () => {
      const result = await client.execJson<Relatives>(`person-relatives rel/ebba --relation mormor`);
      assertEquals(result.of, `${root}/ebba`);
      assertEquals(result.relatives.map((r) => r.name), ['Gun']);
    });

    await t.step('a Swedish chain, passed through as the user said it', async () => {
      const result = await client.execJson<Relatives>(`person-relatives ${root}/ebba --relation 'mammas syster'`);
      assertEquals(result.relatives.map((r) => r.name), ['Maja']);
      // What she IS comes from the graph, not from the phrase.
      assertEquals(result.relatives[0].relation.sv, 'moster');
    });

    await t.step('a plural word reaches everyone it covers', async () => {
      const result = await client.execJson<Relatives>(`person-relatives ${root}/gun --relation barn`);
      assertEquals(result.relatives.map((r) => r.name).toSorted(), ['Lena', 'Maja']);
    });

    await t.step('--age gives the span to search in, as coarse as the birth date', async () => {
      const result = await client.execJson<Relatives>(`person-relatives ${root}/lena --relation dotter --age 6`);
      assertEquals(result.relatives.map((r) => [r.name, r.taken]), [['Ebba', { from: '1996-05-12', to: '1997-05-12' }]]);
      const coarse = await client.execJson<Relatives>(`person-relatives ${root}/gun --relation dotter --age 6`);
      assertEquals(coarse.relatives.map((r) => r.taken).toSorted((a, b) => a!.from.localeCompare(b!.from)), [
        { from: '1966', to: '1967' },
        { from: '1969', to: '1970' },
      ]);
    });

    await t.step('nobody reached is an empty answer, not a failure', async () => {
      const result = await client.execJson<Relatives>(`person-relatives ${root}/ebba --relation son`);
      assertEquals(result.relatives, []);
    });

    await t.step('a phrase that is not kin words fails and says which words are', async () => {
      const failed = await cmd.shouldFail(`person-relatives ${root}/ebba --relation granne`);
      assertStringIncludes(failed.error ?? '', 'not a kin phrase');
    });

    await t.step('a person who is not there fails', async () => {
      const failed = await cmd.shouldFail(`person-relatives ${root}/nobody --relation mamma`);
      assertStringIncludes(failed.error ?? '', 'no person at');
    });

    await t.step('text mode names the relation both ways', async () => {
      const result = await cmd.shouldSucceed(`JSON_OUTPUT=0 person-relatives ${root}/ebba --relation mormor`);
      assertStringIncludes(String(result.data), 'Gun');
      assertStringIncludes(String(result.data), 'mormor');
    });
  } finally {
    await testCtx.teardown();
  }
});
