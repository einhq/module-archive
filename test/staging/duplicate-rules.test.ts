/**
 * The rules a duplicate set is resolved by (`@archive/staging/duplicate-rules`): the library file
 * is always kept, else the first staged one or a person's choice; only copies in the folder read
 * go; what the kept file would gain mirrors the fill-only merge; and what blocks a set.
 */
import { carriesOf, decideExactSet, type ExactSetInput, type RuleFile, unionFields } from '@archive/staging/duplicate-rules';
import { assertEquals } from '@std/assert';

const file = (id: string, more: Partial<RuleFile> = {}): RuleFile => ({
  id,
  place: 'inbox',
  inScope: true,
  size: 100,
  hasPosition: false,
  labels: [],
  starred: false,
  hasComments: false,
  hasPeople: false,
  hasSidecar: false,
  ...more,
});

const input = (more: Partial<ExactSetInput> = {}): ExactSetInput => ({
  original: file('a'),
  originalId: 'a',
  copies: [file('b'), file('c')],
  keepWritable: () => true,
  ...more,
});

Deno.test('a library original is kept over every staged copy, as the library', () => {
  const rules = decideExactSet(input({ original: file('a', { place: 'library', inScope: false }) }));
  assertEquals([rules.keep, rules.discard], ['a', ['b', 'c']]);
  assertEquals(rules.reasons, [{ rule: 'library', keep: 'a', over: 'b' }, { rule: 'library', keep: 'a', over: 'c' }]);
  assertEquals([rules.bulk, rules.blocked, rules.reclaimableBytes, rules.flags], [true, undefined, 200, []]);
});

Deno.test('within the inbox the first staged file is kept, and a chosen one instead when named', () => {
  const first = decideExactSet(input());
  assertEquals([first.keep, first.discard, first.reasons[0].rule], ['a', ['b', 'c'], 'earliest']);
  const chosen = decideExactSet(input({ chosen: 'c' }));
  assertEquals([chosen.keep, chosen.discard, chosen.reasons.map((reason) => reason.rule)], ['c', ['a', 'b'], ['chosen', 'chosen']]);
  // A choice of a file not in the set is no choice.
  assertEquals(decideExactSet(input({ chosen: 'z' })).keep, 'a');
});

Deno.test('only copies in the folder read are dropped; the others flag the set', () => {
  const rules = decideExactSet(input({ copies: [file('b'), file('c', { inScope: false })] }));
  assertEquals([rules.discard, rules.flags], [['b'], ['outside-scope']]);
  // A staged original outside the folder stays, and is the kept file.
  const away = decideExactSet(input({ original: file('a', { inScope: false }) }));
  assertEquals([away.keep, away.discard, away.flags], ['a', ['b', 'c'], []]);
});

Deno.test('a set whose original is not found is blocked, and gains nothing', () => {
  const rules = decideExactSet(input({ original: undefined }));
  assertEquals([rules.keep, rules.discard, rules.gains, rules.bulk, rules.blocked], ['a', ['b', 'c'], [], false, 'keep-gone']);
});

Deno.test('a kept file that would be filled in must be writable; a star needs no write', () => {
  const described = input({ copies: [file('b', { description: 'Lake at dawn' })], keepWritable: () => false });
  const blocked = decideExactSet(described);
  assertEquals([blocked.gains, blocked.bulk, blocked.blocked], [['description'], false, 'keep-not-writable']);
  const starred = decideExactSet({ ...described, copies: [file('b', { starred: true })] });
  assertEquals([starred.gains, starred.bulk, starred.blocked], [['star'], true, undefined]);
});

Deno.test('what a copy carries mirrors the fill-only merge', () => {
  const keep = file('k', { description: 'kept', labels: ['boat'], hasPosition: true });
  assertEquals(carriesOf(keep, file('d', { description: 'other', labels: ['boat'], positionManual: true })), []);
  assertEquals(
    carriesOf(file('k'), file('d', { description: 'Lake', whenManual: '1974', positionManual: true, labels: ['boat'], starred: true, hasPeople: true, hasComments: true })),
    [
      'description',
      'time',
      'place',
      'labels',
      'star',
      'people',
      'comments',
    ],
  );
  assertEquals(carriesOf(file('k', { starred: true }), file('d', { starred: true })), []);
  assertEquals(carriesOf(file('k'), file('d', { hasPosition: true })), ['place']);
  // A paired sidecar goes over to a kept file that has none.
  assertEquals(carriesOf(file('k'), file('d', { hasSidecar: true })), ['sidecar']);
  assertEquals(carriesOf(file('k', { hasSidecar: true }), file('d', { hasSidecar: true })), []);
  assertEquals(unionFields([['star', 'labels'], ['description', 'labels']]), ['description', 'labels', 'star']);
});
