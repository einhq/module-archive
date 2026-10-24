/**
 * retime: recomputing an ordered batch of capture times from a start time.
 *
 * The cases worth pinning down are the ones where the batch is not uniform — a mix of dated and
 * undated media, an order that contradicts the dates, a burst of frames sharing one second — plus
 * the anchoring rule, which is what makes a hand-edited row carry the rest of the list with it.
 */

import { assertEquals } from '@std/assert';
import { DEFAULT_GAP_MS, formatNaive, formatPicker, parseNaive, retime, type RetimeEntry, sortByName, sortByTime } from '../retime.ts';

const MINUTE = 60_000;

/** `entries` from `path: original-ms-or-undefined` pairs, keeping the tests readable. */
const build = (spec: Record<string, number | undefined>): Map<string, RetimeEntry> => new Map(Object.entries(spec).map(([path, original]) => [path, { path, original }]));

const run = (
  order: string[],
  spec: Record<string, number | undefined>,
  start: number,
  anchors: Record<string, number> = {},
): number[] => {
  const times = retime({
    order,
    entries: build(spec),
    start,
    anchors: new Map(Object.entries(anchors)),
    gapMs: DEFAULT_GAP_MS,
  });
  return order.map((path) => times.get(path)!);
};

Deno.test('a dated batch keeps its spacing and moves onto the start time', () => {
  // 0, +2 min, +2.5 min from an original that is itself wrong.
  const spec = { a: 1_000_000, b: 1_000_000 + 2 * MINUTE, c: 1_000_000 + 4.5 * MINUTE };
  assertEquals(run(['a', 'b', 'c'], spec, 5_000_000), [
    5_000_000,
    5_000_000 + 2 * MINUTE,
    5_000_000 + 4.5 * MINUTE,
  ]);
});

Deno.test('an undated batch spreads at one a minute', () => {
  assertEquals(run(['a', 'b', 'c'], { a: undefined, b: undefined, c: undefined }, 5_000_000), [
    5_000_000,
    5_000_000 + MINUTE,
    5_000_000 + 2 * MINUTE,
  ]);
});

Deno.test('a mixed batch keeps real gaps and fills the rest', () => {
  // b has no date, so both the a→b and b→c steps fall back to the gap; c→d is real again.
  const spec = { a: 0, b: undefined, c: 10 * MINUTE, d: 12 * MINUTE };
  assertEquals(run(['a', 'b', 'c', 'd'], spec, 0), [0, MINUTE, 2 * MINUTE, 4 * MINUTE]);
});

Deno.test('frames from the same second stay simultaneous', () => {
  // A burst: spreading it a minute apart would invent a spacing that never existed.
  assertEquals(run(['a', 'b', 'c'], { a: 500, b: 500, c: 500 }, 9_000), [9_000, 9_000, 9_000]);
});

Deno.test('an order that contradicts the dates falls back to the gap', () => {
  // c was taken first but dragged last; it does not drag the timeline backwards with it.
  assertEquals(run(['a', 'b', 'c'], { a: 10 * MINUTE, b: 12 * MINUTE, c: 0 }, 0), [
    0,
    2 * MINUTE,
    3 * MINUTE,
  ]);
});

Deno.test('an anchor pins its row and carries the rest of the list', () => {
  const spec = { a: 0, b: 2 * MINUTE, c: 3 * MINUTE, d: 4 * MINUTE };
  const times = run(['a', 'b', 'c', 'd'], spec, 0, { c: 100 * MINUTE });

  // a and b are untouched, c takes the pinned value, d keeps its 1-minute distance from c.
  assertEquals(times, [0, 2 * MINUTE, 100 * MINUTE, 101 * MINUTE]);
});

Deno.test('several anchors each govern up to the next one', () => {
  const spec = { a: 0, b: MINUTE, c: 2 * MINUTE, d: 3 * MINUTE };
  const times = run(['a', 'b', 'c', 'd'], spec, 0, { b: 50 * MINUTE, d: 80 * MINUTE });
  assertEquals(times, [0, 50 * MINUTE, 51 * MINUTE, 80 * MINUTE]);
});

Deno.test('an anchor on the first row wins over the start time', () => {
  assertEquals(run(['a', 'b'], { a: 0, b: MINUTE }, 7 * MINUTE, { a: 20 * MINUTE }), [
    20 * MINUTE,
    21 * MINUTE,
  ]);
});

Deno.test('sortByTime puts undated media last', () => {
  const entries = build({ a: 3 * MINUTE, b: undefined, c: MINUTE, d: undefined });
  assertEquals(sortByTime(['a', 'b', 'c', 'd'], entries), ['c', 'a', 'b', 'd']);
});

Deno.test('sortByName collates numerically', () => {
  const names = new Map([['/x/2', 'IMG_2.jpg'], ['/x/10', 'IMG_10.jpg'], ['/x/1', 'IMG_1.jpg']]);
  assertEquals(sortByName(['/x/10', '/x/2', '/x/1'], names), ['/x/1', '/x/2', '/x/10']);
});

Deno.test('a naive timestamp round-trips through parse and format', () => {
  const iso = '2015-07-25T14:03:11';
  assertEquals(formatNaive(parseNaive(iso)!), iso);
  assertEquals(formatPicker(parseNaive(iso)!), '2015-07-25 14:03:11');
  // The picker's spelling reads back as the same instant.
  assertEquals(parseNaive('2015-07-25 14:03:11'), parseNaive(iso));
});

Deno.test('parseNaive rejects what is not a time', () => {
  assertEquals(parseNaive(undefined), undefined);
  assertEquals(parseNaive(''), undefined);
  assertEquals(parseNaive('not-a-date'), undefined);
});

Deno.test('a zoned timestamp becomes local wall-clock, once', () => {
  // Reading is the only conversion; what comes back out has no zone and never shifts again.
  const once = formatNaive(parseNaive('2015-07-25T14:03:11Z')!);
  assertEquals(formatNaive(parseNaive(once)!), once);
});

Deno.test('a row vaguer than a day is left as it is', async (t) => {
  const start = Date.UTC(2015, 6, 25, 12, 0, 0);

  await t.step('it gets no new time, and its neighbours do not inherit its position', () => {
    // "Some time in 1975" is not a distance from anything, so it neither moves nor moves
    // anything else.
    const entries = build({ a: undefined, b: undefined, c: undefined });
    entries.set('b', { path: 'b', original: Date.UTC(1975, 0, 1), vague: true });
    const times = retime({ order: ['a', 'b', 'c'], entries, start, anchors: new Map(), gapMs: MINUTE });

    assertEquals(times.has('b'), false);
    assertEquals(times.get('a'), start);
    assertEquals(times.get('c'), start + MINUTE);
  });

  await t.step('a batch starting with one begins at the first row that takes a time', () => {
    const entries = build({ a: undefined, b: undefined });
    entries.set('a', { path: 'a', original: Date.UTC(1975, 0, 1), vague: true });
    const times = retime({ order: ['a', 'b'], entries, start, anchors: new Map(), gapMs: MINUTE });

    assertEquals(times.has('a'), false);
    assertEquals(times.get('b'), start);
  });

  await t.step('pinning it is the opt-in, and it then carries the rest', () => {
    const entries = build({ a: undefined, b: undefined, c: undefined });
    entries.set('b', { path: 'b', original: Date.UTC(1975, 0, 1), vague: true });
    const pinned = Date.UTC(1975, 5, 6, 9, 0, 0);
    const times = retime({ order: ['a', 'b', 'c'], entries, start, anchors: new Map([['b', pinned]]), gapMs: MINUTE });

    assertEquals(times.get('b'), pinned);
    assertEquals(times.get('c'), pinned + MINUTE);
  });
});
