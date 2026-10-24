/**
 * `archive-parse` end to end.
 *
 * Two paths matter and both are here. With a model — a stand-in command that `CFG_LANGUAGE_MODEL`
 * names, answering what each step says — the real pipeline runs: the proposal's prompt, a JSON
 * answer, validation, resolution against real nodes. With no model, or one that fails, it must
 * still parse, because a model server that is down may not take natural-language search offline.
 *
 * Nominatim is stubbed on loopback, so nothing here touches the network.
 */

import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals, assertObjectMatch } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import type { SearchParse, SearchSubjectRef } from '@ein/api';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

/** Nominatim's boundingbox order is south, north, west, east. Roughly Italy. */
const ITALY = {
  lat: '42.6',
  lon: '12.6',
  display_name: 'Italia',
  addresstype: 'country',
  boundingbox: ['35.4', '47.1', '6.6', '18.5'],
};

/** The stand-in model: it notes the message it was asked, and answers what the step left for it. */
const FAKE_MODEL = 'for a in "$@"; do last="$a"; done\necho "$last" >> /tmp/fake-model-asked\ncat /tmp/fake-model-answer\n';

Deno.test({
  name: 'archive-parse',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const write = async (path: string, text: string) => {
    await client.exec(`mkfile ${path}`);
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(text));
    } finally {
      await handle.close();
    }
  };
  client = await testCtx.server.createShellClient();
  await client.exec('mkdir -p /opt/bin');
  await write('/opt/bin/fake-model', FAKE_MODEL);
  await client.exec('chmod 755 /opt/bin/fake-model');
  await client.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
  client.close();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const nominatimQueries: string[] = [];
  const nominatim = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    nominatimQueries.push(q);
    return new Response(JSON.stringify(q.toLowerCase().includes('italy') ? [ITALY] : []), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const nominatimUrl = `http://localhost:${(nominatim.addr as Deno.NetAddr).port}/search`;

  /** Run archive-parse with a model that will answer `completion`; what it was asked, one message a call. */
  const withModel = async (completion: string, query: string, flags = ''): Promise<{ parsed: SearchParse; asked: string[] }> => {
    await write('/tmp/fake-model-answer', JSON.stringify({ content: completion, model: 'fake' }));
    await client.exec('rm -f /tmp/fake-model-asked');
    const parsed = await client.execJson<SearchParse>(`CFG_LANGUAGE_MODEL=fake-model NOMINATIM_SEARCH_URL=${nominatimUrl} archive-parse ${flags}${query}`);
    const asked = await client.exec('cat /tmp/fake-model-asked');
    return { parsed, asked: asked.success ? `${asked.data}`.split('\n').filter(Boolean) : [] };
  };
  const ofKind = (parsed: SearchParse, kind: string): Omit<SearchSubjectRef, 'kind'>[] =>
    parsed.subjects.filter((subject) => subject.kind === kind).map(({ kind: _, ...subject }) => subject);
  const HEMMA = { name: 'Hemma', ref: 'hemma', matches: [{ name: 'Hemma', ref: 'hemma' }] };
  const answer = (fields: Record<string, unknown>) => JSON.stringify({ people: [], locations: [], from: null, to: null, kinds: [], text: '', ...fields });

  try {
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}`);
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
    await cmd.shouldSucceed(`mknode -t person ${PEOPLE_ROOT}/olof`);
    await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/olof -s name='Olof'`);
    await cmd.shouldSucceed(`mknode -t person ${PEOPLE_ROOT}/olof-junior`);
    await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/olof-junior -s name='Olof Junior'`);
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/hemma`);
    await cmd.shouldSucceed(`attrs ${LOCATIONS_ROOT}/hemma -s name='Hemma'`);

    await t.step('an undeclared flag is named, not silently swallowed', async () => {
      await cmd.shouldFailWith('archive-parse --bogus q', 'unknown flag --bogus');
    });

    await t.step('the whole sentence: years and kinds by rule, a partial name, a geocoded region', async () => {
      const { parsed, asked } = await withModel(
        answer({ people: ['Olof', 'Stina'], locations: ['Italy'], from: '2011', to: '2011', kinds: ['photo'] }),
        "'Pictures from Italy in 2011 when Olof and Stina was there'",
      );

      assertEquals(parsed.source, 'llm');
      assertEquals(parsed.kinds, ['photo']);
      assertEquals([parsed.from, parsed.to], ['2011', '2011']);
      // "Olof" is two people: a partial name keeps them both, and picks neither.
      assertEquals(parsed.subjects, [{
        kind: 'person',
        name: 'Olof',
        matches: [
          { name: 'Olof', ref: 'olof' },
          { name: 'Olof Junior', ref: 'olof-junior' },
        ],
      }]);
      // Stina is nobody: reported, and searched as a word instead.
      assertEquals(parsed.unresolved, ['Stina']);
      assertEquals(parsed.text, 'Stina');
      // No location node called Italy, so it resolves to the geocoded box.
      assertEquals(parsed.region, { shape: 'bbox', north: 47.1, south: 35.4, east: 18.5, west: 6.6 });
      assertEquals(nominatimQueries.at(-1), 'Italy');

      // One short call, the sentence last.
      assertEquals(asked, ['Pictures from Italy in 2011 when Olof and Stina was there']);
    });

    await t.step('a full name that is one person is that person', async () => {
      const { parsed } = await withModel(answer({ people: ['Olof Junior'] }), "'Olof Junior 2019'");
      assertEquals(parsed.subjects, [{ kind: 'person', name: 'Olof Junior', ref: 'olof-junior', matches: [{ name: 'Olof Junior', ref: 'olof-junior' }] }]);
      assertEquals([parsed.from, parsed.to], ['2019', '2019']);
      assertEquals(parsed.text, '');
    });

    await t.step('a location that is a node wins over geocoding', async () => {
      const before = nominatimQueries.length;
      const { parsed } = await withModel(answer({ locations: ['Hemma'] }), "'bilder Hemma'");
      assertEquals(ofKind(parsed, 'location'), [HEMMA]);
      assertEquals(parsed.region, undefined);
      assertEquals(nominatimQueries.length, before);
    });

    await t.step('a person who is nobody but is a location node is that location; a stranger is not geocoded', async () => {
      const before = nominatimQueries.length;
      const { parsed } = await withModel(answer({ people: ['Olof Junior', 'Hemma', 'Stina'] }), "'Olof Junior Hemma Stina'");
      assertEquals(ofKind(parsed, 'person').map((person) => person.ref), ['olof-junior']);
      assertEquals(ofKind(parsed, 'location'), [HEMMA]);
      assertEquals(parsed.unresolved, ['Stina']);
      assertEquals(parsed.text, 'Stina');
      assertEquals(nominatimQueries.length, before);
    });

    await t.step('a model answer wrapped in prose still parses', async () => {
      const { parsed } = await withModel('```json\n' + answer({ text: 'beach' }) + '\n```', "'videos at the beach'");
      assertEquals(parsed.source, 'llm');
      assertEquals(parsed.kinds, ['video']);
      assertEquals(parsed.text, 'beach');
    });

    await t.step('a model answer that is not JSON falls back to the rules', async () => {
      const { parsed } = await withModel('I am sorry, I cannot help with that request.', "'photos from 2011'");
      assertEquals(parsed.source, 'rules');
      assertEquals(parsed.kinds, ['photo']);
      assertEquals([parsed.from, parsed.to], ['2011', '2011']);
    });

    await t.step('the rules read a one-sided year the model would close', async () => {
      const { parsed } = await withModel(answer({ from: '2010', to: '2010', text: 'snow' }), "'snow before 2010'");
      assertEquals([parsed.from, parsed.to], [undefined, '2010']);
      assertEquals(parsed.text, 'snow');
    });

    await t.step('a kind word the rules made a filter of is not also the description', async () => {
      const { parsed } = await withModel(answer({ locations: ['Hemma'], text: 'album' }), "'album Hemma'");
      assertEquals(parsed.kinds, ['album']);
      assertEquals(ofKind(parsed, 'location'), [HEMMA]);
      assertEquals(parsed.text, '');
    });

    await t.step('a paraphrased description gives way to the words the user wrote', async () => {
      const { parsed } = await withModel(
        answer({ people: ['Olof'], locations: ['Hemma'], text: 'a crimson yacht' }),
        "'photos of Olof at Hemma with a red sailing boat'",
      );
      assertEquals(parsed.text, 'red sailing boat');
      assertEquals(ofKind(parsed, 'location'), [HEMMA]);
    });

    await t.step('invented names cannot become filters or disappear from the text', async () => {
      const { parsed } = await withModel(answer({ people: ['Anna'], locations: ['Paris'] }), "'red sailing boat'");
      assertEquals(parsed.source, 'rules');
      assertEquals(parsed.text, 'red sailing boat');
      assertEquals(parsed.subjects, []);
    });

    await t.step('no model, or one that cannot answer, still parses', async () => {
      for (const model of ['', 'false']) {
        const parsed = await client.execJson<SearchParse>(`CFG_LANGUAGE_MODEL=${model} archive-parse 'bilder från 1998 till 2004'`);
        assertEquals(parsed.source, 'rules');
        assertEquals(parsed.kinds, ['photo']);
        assertEquals([parsed.from, parsed.to], ['1998', '2004']);
      }
    });

    await t.step('the account is in the language the search is written in', async () => {
      const sv = await withModel(answer({ people: ['Olof Junior'], from: '2019', to: '2019' }), "'bilder på Olof Junior från 2019'");
      assertEquals(sv.parsed.explain, 'bilder på Olof Junior från 2019');
      const en = await withModel(answer({ people: ['Olof Junior'], from: '2019', to: '2019' }), "'photos of Olof Junior in 2019'");
      assertEquals(en.parsed.explain, 'photos of Olof Junior from 2019');
    });

    await t.step('a kin word is reported, not searched for', async () => {
      const { parsed } = await withModel(answer({ people: ['pappa'] }), "'bilder på pappa'");
      assertEquals(parsed.subjects, []);
      assertEquals(parsed.unresolved, ['pappa']);
    });

    await t.step('--rules skips the model entirely', async () => {
      const { parsed, asked } = await withModel(answer({ people: ['Olof'] }), "'filmer 2010 Olof'", '--rules ');
      assertObjectMatch(parsed, { source: 'rules', kinds: ['video'], from: '2010', to: '2010', subjects: [], text: 'Olof' });
      assertEquals(asked, []);
    });

    await t.step('an empty query is an error, not an empty parse', async () => {
      assertEquals((await client.exec('archive-parse')).success, false);
    });
  } finally {
    await nominatim.shutdown();
    client.close();
    await testCtx.teardown();
  }
});
