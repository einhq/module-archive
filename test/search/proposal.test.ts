import { assertEquals } from '@std/assert';
import { PROPOSAL_PROMPT, readProposal } from '@archive/search/proposal';

Deno.test('a proposal keeps what the user wrote and drops what the model invented', async (t) => {
  await t.step('a clean answer, fence and prose around it', () => {
    const got = readProposal(
      'Visa bilder på Anna Andersson i Göteborg från 2019',
      'Sure!\n```json\n{"people":["Anna Andersson"],"locations":["Göteborg"],"from":"2019","to":"2019","kinds":["photo"],"text":""}\n```',
    );
    assertEquals(got, { people: ['Anna Andersson'], locations: ['Göteborg'], from: '2019', to: '2019', kinds: ['photo'], text: '' });
  });

  await t.step('case aside, a name must be words the user wrote', () => {
    assertEquals(readProposal('visa bilder på anna', '{"people":["Anna"],"locations":[]}')?.people, ['Anna']);
    // Corrected, translated or invented: nothing to trust, so the rules alone read the search.
    assertEquals(readProposal('Show photos from Rome', '{"people":[],"locations":["Roma"]}'), undefined);
    assertEquals(readProposal('Visa bilder på Ana', '{"people":["Anna"],"locations":[]}'), undefined);
  });

  await t.step('years are four digits, a lone from is its own to, kinds are three words', () => {
    const got = readProposal('Visa filmer från 2012', '{"people":[],"locations":[],"from":2012,"to":null,"kinds":["video","gif"],"text":""}');
    assertEquals(got, { people: [], locations: [], from: '2012', to: '2012', kinds: ['video'], text: '' });
    assertEquals(readProposal('Visa bilder från förra året', '{"people":[],"locations":[],"from":"last year"}')?.from, undefined);
  });

  await t.step('anything that is not one JSON object is no answer', () => {
    assertEquals(readProposal('Visa bilder', 'I cannot help with that.'), undefined);
    assertEquals(readProposal('Visa bilder', '["Anna"]'), undefined);
    assertEquals(readProposal('Visa bilder', '{"people": ["Anna"'), undefined);
  });

  await t.step('the prompt is the system text and the examples as earlier turns, the same for every request', () => {
    assertEquals(PROPOSAL_PROMPT.history.length % 2, 0);
    assertEquals(PROPOSAL_PROMPT.history.map((turn) => turn.role).slice(0, 2), ['user', 'assistant']);
    assertEquals(JSON.parse(PROPOSAL_PROMPT.history[1].content).people, ['Anna', 'Erik']);
  });
});
