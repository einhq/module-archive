/**
 * Pure-unit tests for boundary segmentation. Fast tier: no VFS.
 *
 * The block of "boundary decisions" cases pins down when a change of location
 * cuts and when it does not.
 */

import { assertEquals } from '@std/assert';
import {
  baselineOf,
  boundaryDecision,
  type ClusterItem,
  clusterMedia,
  compareItems,
  mergeHomeDays,
  rollupClusters,
  shotsOf,
  usualLocation,
} from '../../lib/staging/cluster.ts';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const t = (h: number) => new Date('2026-06-01T00:00:00Z').getTime() + h * HOUR;

const opts = { gapMs: 4 * HOUR, splitMeters: 2000 };

// Stockholm, and points at a known distance east of it. 1 degree of longitude at
// 59.33 N is ~56.8 km, so the offsets below give roughly the metres named.
const STHLM = { lat: 59.33, lng: 18.06 };
const east = (meters: number) => ({ lat: STHLM.lat, lng: STHLM.lng + meters / (111_320 * Math.cos(STHLM.lat * Math.PI / 180)) });

Deno.test('splits on a time gap larger than gapMs', () => {
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0) },
    { path: '/b', timeMs: t(1) },
    // 5h gap -> new cluster
    { path: '/c', timeMs: t(6) },
    { path: '/d', timeMs: t(6.5) },
  ];
  const clusters = clusterMedia(items, opts);
  assertEquals(clusters.map((c) => c.items.map((i) => i.path)), [['/a', '/b'], ['/c', '/d']]);
  assertEquals(clusters[0].timeStart, new Date(t(0)).toISOString());
  assertEquals(clusters[0].timeEnd, new Date(t(1)).toISOString());
});

Deno.test('keeps a long day together when gaps stay under threshold', () => {
  const items: ClusterItem[] = [0, 3, 6, 9].map((h, n) => ({ path: `/p${n}`, timeMs: t(h) }));
  const clusters = clusterMedia(items, opts);
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].items.length, 4);
});

Deno.test('no spatial split when GPS is missing on one side', () => {
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0), ...STHLM },
    { path: '/b', timeMs: t(1) }, // no GPS
    { path: '/c', timeMs: t(2), lat: 57.70, lng: 11.97 }, // far, but no window agreement
  ];
  const clusters = clusterMedia(items, opts);
  assertEquals(clusters.length, 1);
});

/**
 * Two geotagged items each side of the boundary, `apart` metres and `gapMin`
 * minutes between the groups, optionally with a cast of people per side.
 */
const boundaryCase = (apart: number, gapMin: number, before?: string[], after?: string[]): ClusterItem[] => {
  const there = east(apart);
  return [
    { path: '/b1', timeMs: t(0), ...STHLM, persons: before },
    { path: '/b2', timeMs: t(0) + MIN, ...STHLM, persons: before },
    { path: '/a1', timeMs: t(0) + MIN + gapMin * MIN, ...there, persons: after },
    { path: '/a2', timeMs: t(0) + 2 * MIN + gapMin * MIN, ...there, persons: after },
  ];
};

const decide = (items: ClusterItem[]) => boundaryDecision(items, 2, 0, opts);

Deno.test('boundary: a venue change with the same people stays one album', () => {
  const d = decide(boundaryCase(3000, 1, ['p1', 'p2', 'p3'], ['p1', 'p2', 'p3']));
  assertEquals(d.scores.people, 1);
  assertEquals(d.cut, false);
});

Deno.test('boundary: same distance but a different cast does split', () => {
  const d = decide(boundaryCase(3000, 1, ['p1', 'p2', 'p3'], ['p9', 'p8']));
  assertEquals(d.scores.people, 0);
  assertEquals(d.cut, true);
});

Deno.test('boundary: a 20-minute drive with the same people stays together', () => {
  const d = decide(boundaryCase(3000, 20, ['p1', 'p2'], ['p1', 'p2']));
  assertEquals(d.cut, false);
});

Deno.test('boundary: three hours and a few km apart, nobody known, splits', () => {
  const d = decide(boundaryCase(3000, 180));
  assertEquals(d.scores.people, undefined);
  assertEquals(d.cut, true);
});

Deno.test('boundary: ten km apart with nobody known splits', () => {
  const d = decide(boundaryCase(10000, 1));
  assertEquals(d.cut, true);
});

Deno.test('boundary: an impossible jump is a bad fix, not a move', () => {
  // 400 km in 10 seconds. Location is dropped as unknown rather than counted,
  // so nothing is left that argues for a cut.
  const items: ClusterItem[] = [
    { path: '/b1', timeMs: t(0), ...STHLM },
    { path: '/b2', timeMs: t(0) + MIN, ...STHLM },
    { path: '/a1', timeMs: t(0) + MIN + 10_000, lat: 57.70, lng: 11.97 },
    { path: '/a2', timeMs: t(0) + MIN + 20_000, lat: 57.70, lng: 11.97 },
  ];
  const d = decide(items);
  assertEquals(d.scores.location, undefined);
  assertEquals(d.cut, false);
});

Deno.test('boundary: a single stray coordinate never cuts (needs confirmation)', () => {
  // One item in Gothenburg between two runs in Stockholm: unconfirmed on both
  // boundaries, so the day survives as one album.
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0), ...STHLM },
    { path: '/b', timeMs: t(0) + MIN, ...STHLM },
    { path: '/stray', timeMs: t(0) + 2 * MIN, lat: 57.70, lng: 11.97 },
    { path: '/c', timeMs: t(0) + 3 * MIN, ...STHLM },
    { path: '/d', timeMs: t(0) + 4 * MIN, ...STHLM },
  ];
  const clusters = clusterMedia(items, opts);
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].items.length, 5);
});

Deno.test('boundary: a fix flickering between two places is noise, not a move', () => {
  // The evening is at STHLM; the phone puts some photos at a stale fix 5 km
  // away, two of them together, at a believable speed. Counted, that distance
  // would cut. The stale group is nearest the boundary, but the window before it
  // also holds STHLM, so neither place is left behind and the run stays one part.
  const stale = east(5000);
  const items: ClusterItem[] = [
    { path: '/a1', timeMs: t(0), ...STHLM },
    { path: '/s1', timeMs: t(0) + MIN, ...stale },
    { path: '/s2', timeMs: t(0) + MIN, ...stale },
    { path: '/a2', timeMs: t(0) + 2 * MIN, ...STHLM },
    { path: '/a3', timeMs: t(0) + 3 * MIN, ...STHLM },
    { path: '/s3', timeMs: t(0) + 4 * MIN, ...stale },
    { path: '/a4', timeMs: t(0) + 6 * MIN, ...STHLM },
    { path: '/a5', timeMs: t(0) + 7 * MIN, ...STHLM },
  ];
  const d = boundaryDecision(items, 6, 0, opts);
  assertEquals(d.scores.location, undefined);
  assertEquals(d.cut, false);
  assertEquals(clusterMedia(items, opts).length, 1);
});

Deno.test('boundary: a move along a road is one-way, so its distance counts', () => {
  // The last photo on the way is already near the destination, but it is part
  // of the before side, not a second place in its window.
  const items: ClusterItem[] = [
    { path: '/w1', timeMs: t(0), ...STHLM },
    { path: '/w2', timeMs: t(0) + 2 * MIN, ...east(4000) },
    { path: '/w3', timeMs: t(0) + 4 * MIN, ...east(7000) },
    { path: '/w4', timeMs: t(0) + 5 * MIN, ...east(8500) },
    { path: '/d1', timeMs: t(0) + 7 * MIN, ...east(10000) },
    { path: '/d2', timeMs: t(0) + 8 * MIN, ...east(10000) },
  ];
  const d = boundaryDecision(items, 4, 0, opts);
  assertEquals(d.scores.location !== undefined, true);
});

Deno.test('a confirmed, plausible move to a far location still splits', () => {
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0), ...STHLM },
    { path: '/b', timeMs: t(0) + MIN, ...STHLM },
    { path: '/c', timeMs: t(1), ...east(20000) },
    { path: '/d', timeMs: t(1) + MIN, ...east(20000) },
  ];
  const clusters = clusterMedia(items, opts);
  assertEquals(clusters.map((c) => c.items.map((i) => i.path)), [['/a', '/b'], ['/c', '/d']]);
});

Deno.test('scores: tight cluster is temporally cohesive; overall present', () => {
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0), ...STHLM },
    { path: '/b', timeMs: t(0) + 60000, ...STHLM },
  ];
  const [c] = clusterMedia(items, opts);
  // 1-minute spacing under a 2h half-life -> temporal near 1
  assertEquals(c.scores.temporal! > 0.99, true);
  assertEquals(c.scores.location, 1); // identical points
  assertEquals(typeof c.scores.overall, 'number');
});

Deno.test('scores: people cohesion is 1 when the same cast recurs', () => {
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0), persons: ['p1', 'p2'] },
    { path: '/b', timeMs: t(0) + MIN, persons: ['p1', 'p2'] },
    { path: '/c', timeMs: t(0) + 2 * MIN }, // nobody in frame: does not count against it
  ];
  const [c] = clusterMedia(items, opts);
  assertEquals(c.scores.people, 1);
});

Deno.test('a cluster is not ready when any member is still waiting on the crawl', () => {
  const items: ClusterItem[] = [
    { path: '/a', timeMs: t(0), ready: true },
    { path: '/b', timeMs: t(0) + MIN, ready: false },
  ];
  assertEquals(clusterMedia(items, opts)[0].ready, false);
  assertEquals(clusterMedia([items[0]], opts)[0].ready, true);
});

Deno.test('scores: people cohesion ignores cast size, counts recurrence', () => {
  // A gathering with a large cast, everyone photographed twice, is cohesive
  // however many guests it had.
  const cast = Array.from({ length: 40 }, (_, n) => `p${n}`);
  const items: ClusterItem[] = Array.from({ length: 80 }, (_, n) => ({
    path: `/g${n}`,
    timeMs: t(0) + n * MIN,
    persons: [cast[n % 40]],
  }));
  assertEquals(clusterMedia(items, opts)[0].scores.people, 1);

  // A stream of strangers, each seen once, scores 0.
  const strangers: ClusterItem[] = Array.from({ length: 10 }, (_, n) => ({
    path: `/s${n}`,
    timeMs: t(0) + n * MIN,
    persons: [`x${n}`],
  }));
  assertEquals(clusterMedia(strangers, opts)[0].scores.people, 0);
});

/* ------------------------------------------------------------------ */
/* Second level: stays and days                                        */
/* ------------------------------------------------------------------ */

// Gothenburg: ~400 km from STHLM, so anywhere here is away from a Stockholm home.
const GBG = { lat: 57.70, lng: 11.97 };
const rollup = { splitMeters: 2000, home: () => STHLM };

/**
 * `n` photos a few minutes apart, starting at hour `h`, at `where` (or nowhere),
 * with `people` in frame — one level-1 part once clustered.
 */
const part = (name: string, h: number, where?: { lat: number; lng: number }, people?: string[], n = 3): ClusterItem[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/${name}${i}`, timeMs: t(h) + i * MIN, ...(where ?? {}), ...(people ? { persons: people } : {}) }));

const names = (clusters: { items: ClusterItem[] }[]) => clusters.map((c) => c.items.map((i) => i.path.replace(/\d+$/, '')).filter((v, i, a) => a.indexOf(v) === i));

Deno.test('rollup: a week away is one trip with a part per day-part', () => {
  const items = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [...part(`m${d}-`, d * 24 + 10, GBG), ...part(`e${d}-`, d * 24 + 19, GBG)]);
  const parts = clusterMedia(items, opts);
  assertEquals(parts.length, 14);
  const out = rollupClusters(parts, rollup);
  assertEquals(out.length, 1);
  assertEquals(out[0].kind, 'trip');
  assertEquals(out[0].days, 7);
  assertEquals(out[0].parts?.length, 14);
  assertEquals(out[0].away, true);
  assertEquals(out[0].items.length, 42);
});

Deno.test('rollup: consecutive days at home stay apart, but one day at home is one album', () => {
  const items = [0, 1, 2].flatMap((d) => [...part(`m${d}-`, d * 24 + 10, STHLM), ...part(`e${d}-`, d * 24 + 19, STHLM)]);
  const parts = clusterMedia(items, opts);
  assertEquals(parts.length, 6);
  const out = rollupClusters(parts, rollup);
  assertEquals(names(out), [['/m0-', '/e0-'], ['/m1-', '/e1-'], ['/m2-', '/e2-']]);
  assertEquals(out[0].kind, undefined);
  assertEquals(out[0].away, false);
  assertEquals(out[0].parts?.length, 2);
});

Deno.test('rollup: without day merge a day at home keeps its parts', () => {
  const items = [...part('m', 10, STHLM), ...part('e', 19, STHLM)];
  const out = rollupClusters(clusterMedia(items, opts), { ...rollup, dayMerge: false });
  assertEquals(out.length, 2);
});

Deno.test('rollup: a GPS-less part between two away parts joins the trip; one at the edge does not', () => {
  const items = [
    ...part('lead', 0 - 14, undefined), // the evening before, indoors, nothing says it belongs
    ...part('a', 10, GBG),
    ...part('museum', 15, undefined),
    ...part('b', 34, GBG),
  ];
  const out = rollupClusters(clusterMedia(items, opts), rollup);
  assertEquals(names(out), [['/lead'], ['/a', '/museum', '/b']]);
  assertEquals(out[1].kind, 'trip');
  assertEquals(out[0].away, undefined);
});

Deno.test('rollup: coming home ends the stay, and a longer gap starts another trip', () => {
  const items = [
    ...part('t1a', 10, GBG),
    ...part('t1b', 34, GBG),
    ...part('home', 58, STHLM),
    ...part('t2a', 82, GBG),
    ...part('t2b', 82 + 3 * 24, GBG), // 72 h later: past the stay gap
  ];
  const out = rollupClusters(clusterMedia(items, opts), rollup);
  assertEquals(names(out), [['/t1a', '/t1b'], ['/home'], ['/t2a'], ['/t2b']]);
  assertEquals(out[0].kind, 'trip');
  assertEquals(out[2].kind, undefined);
  assertEquals(out[2].away, true);
});

Deno.test('rollup: a day trip folds its morning and evening into one album, not a trip', () => {
  const out = rollupClusters(clusterMedia([...part('m', 9, GBG), ...part('e', 18, GBG)], opts), rollup);
  assertEquals(out.length, 1);
  assertEquals(out[0].days, 1);
  assertEquals(out[0].kind, undefined);
  assertEquals(out[0].away, true);
});

Deno.test('rollup: no home means no stays, only days', () => {
  const items = [...part('a', 10, GBG), ...part('b', 34, GBG), ...part('c', 58, GBG)];
  const out = rollupClusters(clusterMedia(items, opts), { splitMeters: 2000 });
  assertEquals(out.length, 3);
  assertEquals(out[0].away, undefined);
});

Deno.test('rollup: same day, different location, nobody known: still one day', () => {
  // Where alone does not split a day at home; an afternoon that moves is one afternoon.
  const out = rollupClusters(clusterMedia([...part('m', 10, STHLM), ...part('e', 19, east(5000))], opts), rollup);
  assertEquals(out.length, 1);
});

Deno.test('rollup: same day, disjoint casts at two locations: two happenings', () => {
  // The football team at the field, then dinner with friends across town.
  const out = rollupClusters(clusterMedia([...part('m', 10, east(4000), ['kid1', 'kid2', 'kid3']), ...part('e', 19, STHLM, ['f1', 'f2', 'f3'])], opts), rollup);
  assertEquals(out.length, 2);
});

Deno.test('rollup: same day, disjoint casts at the same location: one day; a cast alone never splits', () => {
  const team = ['kid1', 'kid2', 'kid3'];
  const friends = ['f1', 'f2', 'f3'];
  const sameLocation = rollupClusters(clusterMedia([...part('m', 10, STHLM, team), ...part('e', 19, STHLM, friends)], opts), rollup);
  assertEquals(sameLocation.length, 1);
  const unknown = rollupClusters(clusterMedia([...part('m', 10, east(4000), team), ...part('e', 19, STHLM)], opts), rollup);
  assertEquals(unknown.length, 1);
  // A small cast inside a large one agrees — the measure is the share of the
  // smaller cast, not Jaccard, which would score two of six as 0.33.
  const overlapping = rollupClusters(
    clusterMedia([...part('m', 10, east(4000), ['mom', 'dad']), ...part('e', 19, STHLM, ['mom', 'dad', 'f1', 'f2', 'f3', 'f4'])], opts),
    rollup,
  );
  assertEquals(overlapping.length, 1);
});

Deno.test('rollup: the same cast across a change of venue is one day', () => {
  // The wedding: church, then dinner five kilometres away, same people. Level 1
  // cuts it (large shifting cast, new location); the day rule joins it back.
  const items = [...part('church', 14, STHLM, ['a', 'b', 'c']), ...part('dinner', 19, east(5000), ['a', 'b', 'd'])];
  const out = rollupClusters(clusterMedia(items, opts), rollup);
  assertEquals(out.length, 1);
  assertEquals(out[0].parts?.length, 2);
});

Deno.test('rollup: anyone seen earlier in the day ties a part back, and everything between with it', () => {
  // The team at the field, dinner with friends across town — two happenings —
  // until kid1 turns up at the dinner: the day folds into one from the group
  // kid1 was first seen in.
  const items = [
    ...part('field', 10, east(4000), ['kid1', 'kid2', 'kid3']),
    ...part('dinner', 18, STHLM, ['f1', 'f2', 'f3']),
    ...part('late', 21, STHLM, ['kid1', 'f1']),
  ];
  const two = rollupClusters(clusterMedia(items.slice(0, 6), opts), rollup);
  assertEquals(names(two), [['/field'], ['/dinner']]);
  const one = rollupClusters(clusterMedia(items, opts), rollup);
  assertEquals(names(one), [['/field', '/dinner', '/late']]);
});

Deno.test('rollup: a part with nobody in it goes with the day, wherever it was', () => {
  const items = [
    ...part('a', 10, STHLM, ['a', 'b']),
    ...part('stray', 13, east(5000)), // three photos at one spot across town, no faces
    ...part('b', 17, STHLM, ['a', 'b', 'c']),
  ];
  const out = rollupClusters(clusterMedia(items, opts), rollup);
  assertEquals(names(out), [['/a', '/stray', '/b']]);
});

Deno.test('rollup: a part spread over several locations has no location to disagree with', () => {
  // Getting ready at home, then the drive: photos five kilometres apart inside
  // one part, so its centroid is nowhere in particular. Even with a cast the
  // venue never sees, it joins the afternoon there rather than being held
  // apart by a blended coordinate.
  const spread = [
    { path: '/s0', timeMs: t(9), ...STHLM, persons: ['bride', 'maid'] },
    { path: '/s1', timeMs: t(9) + MIN, ...STHLM, persons: ['bride', 'maid'] },
    { path: '/s2', timeMs: t(9) + 2 * MIN, ...east(1500) },
    { path: '/s3', timeMs: t(9) + 3 * MIN, ...east(3000) },
    { path: '/s4', timeMs: t(9) + 4 * MIN, ...east(4500) },
    { path: '/s5', timeMs: t(9) + 5 * MIN, ...east(6000) },
  ];
  const parts = clusterMedia([...spread, ...part('venue', 15, east(6000), ['groom', 'bestman'])], opts);
  assertEquals(parts.length, 2);
  assertEquals((parts[0].scores.location ?? 1) < 0.3, true);
  const out = rollupClusters(parts, rollup);
  assertEquals(out.length, 1);
});

Deno.test('rollup: the local day comes from the wall clock, not the instant', () => {
  // 22:30 and 01:00 UTC are one evening in Stockholm's day, but the second part
  // says so itself through `day`; the next morning's part starts a new day.
  const night = [...part('a', 22.5, STHLM), ...part('b', 25, STHLM)].map((i) => ({ ...i, day: '2026-06-01' }));
  const morning = part('c', 34, STHLM).map((i) => ({ ...i, day: '2026-06-02' }));
  const parts = clusterMedia([...night, ...morning], opts);
  assertEquals(parts.length, 2); // a and b are 2.5 h apart, one part; c is 9 h later
  assertEquals(parts[0].days, 1);
  const out = rollupClusters(parts, rollup);
  assertEquals(out.length, 2);
});

Deno.test("rollup: scores are the parts' weighted mean, and readiness needs every part", () => {
  const items = [...part('a', 10, GBG, ['x', 'y']), ...part('b', 34, GBG, ['x', 'y'], 6).map((i) => ({ ...i, ready: false }))];
  const parts = clusterMedia(items, opts);
  const out = rollupClusters(parts, rollup);
  assertEquals(out.length, 1);
  const expected = (key: 'temporal' | 'location' | 'people') => (parts[0].scores[key]! * 3 + parts[1].scores[key]! * 6) / 9;
  assertEquals(out[0].scores.temporal, expected('temporal'));
  assertEquals(out[0].scores.location, expected('location'));
  assertEquals(out[0].scores.people, expected('people'));
  assertEquals(out[0].ready, false);
});

Deno.test('usualLocation picks the densest cell and returns its mean', () => {
  const points = [
    ...Array.from({ length: 10 }, (_, n) => east(n * 100)), // home: ten points within a kilometre
    ...Array.from({ length: 6 }, () => GBG), // a trip with more photos per day, fewer overall
    { lat: 37.8, lng: -122.4 },
  ];
  const home = usualLocation(points)!;
  assertEquals(Math.abs(home.lat - STHLM.lat) < 0.01, true);
  assertEquals(Math.abs(home.lng - STHLM.lng) < 0.02, true);
  assertEquals(usualLocation([]), undefined);
});

// ── the adaptive cut, edits, the stay cap, home days, shots and baselines ──────

/** A burst: `n` shots `everyMin` minutes apart from hour `h`. */
const burst = (name: string, h: number, n: number, everyMin: number): ClusterItem[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/${name}${i}`, id: `${name}${i}`, timeMs: t(h) + i * everyMin * MIN }));

Deno.test('adaptive cut: a 40-minute pause in a dense burst ends a part; shorter pauses never do; the 4 h ceiling holds', () => {
  const items = [...burst('a', 10, 12, 1), ...burst('b', 10 + 11 / 60 + 40 / 60, 12, 1)];
  assertEquals(clusterMedia(items, { ...opts, adaptive: true }).length, 2);
  assertEquals(clusterMedia(items, opts).length, 1);
  // A 15-minute pause is under the floor, however dense the burst.
  const close = [...burst('a', 10, 12, 1), ...burst('b', 10 + 11 / 60 + 15 / 60, 12, 1)];
  assertEquals(clusterMedia(close, { ...opts, adaptive: true }).length, 1);
  // Photos an hour apart all day: no pause stands out, and none reaches 4 h.
  assertEquals(clusterMedia(burst('day', 8, 10, 60), { ...opts, adaptive: true }).length, 1);
});

Deno.test("a person's cut always cuts, and a joined run is never cut", () => {
  const items = [...burst('a', 10, 3, 5), ...burst('b', 20, 3, 5)];
  assertEquals(clusterMedia(items, { ...opts, cut: new Set([1]) }).map((c) => c.items.length), [1, 2, 3]);
  assertEquals(clusterMedia(items, { ...opts, keep: new Set([3]) }).length, 1);
});

Deno.test('items at one instant are ordered by id, so a shuffle plans the same', () => {
  const items: ClusterItem[] = ['c', 'a', 'b'].map((id) => ({ path: `/${id}`, id, timeMs: t(1) }));
  assertEquals(items.toSorted(compareItems).map((item) => item.id), ['a', 'b', 'c']);
  const shuffled = [...items].reverse().toSorted(compareItems);
  assertEquals(clusterMedia(shuffled, opts)[0].items.map((item) => item.id), ['a', 'b', 'c']);
});

Deno.test('rollup: a cut between two days away keeps them two albums', () => {
  const items = [...part('a', 10, GBG), ...part('b', 34, GBG)].map((item) => ({ ...item, id: item.path }));
  const parts = clusterMedia(items, opts);
  assertEquals(rollupClusters(parts, rollup).length, 1);
  assertEquals(rollupClusters(parts, { ...rollup, cutAfter: new Set(['/a2']) }).length, 2);
});

Deno.test('rollup: a stay over 21 days splits at its longest pause', () => {
  // Thirty days away, a photo every day, with one pause of two days in the middle.
  const days = [...Array.from({ length: 14 }, (_, d) => d), ...Array.from({ length: 14 }, (_, d) => d + 16)];
  const items = days.flatMap((d) => part(`d${d}-`, d * 24 + 12, GBG, undefined, 1));
  const out = rollupClusters(clusterMedia(items, opts), rollup);
  assertEquals(out.map((c) => c.days), [14, 14]);
  assertEquals(out.every((c) => c.kind === 'trip'), true);
});

Deno.test('home days: joined with evidence within 36 h and 4 days, never without', () => {
  const days = (n: number) => Array.from({ length: n }, (_, d) => part(`d${d}-`, d * 24 + 12, STHLM)).flat();
  const clusters = rollupClusters(clusterMedia(days(3), opts), rollup);
  assertEquals(clusters.length, 3);
  assertEquals(mergeHomeDays(clusters, { evidence: () => true }).length, 1);
  assertEquals(mergeHomeDays(clusters, { evidence: () => false }).length, 3);
  // Five days is over the run's limit: the fifth starts another.
  const five = mergeHomeDays(rollupClusters(clusterMedia(days(5), opts), rollup), { evidence: () => true });
  assertEquals(five.map((c) => c.days), [4, 1]);
  assertEquals(five[0].merged, true);
  // A night longer than 36 h is not bridged.
  const apart = rollupClusters(clusterMedia([...part('a', 12, STHLM), ...part('b', 12 + 50, STHLM)], opts), rollup);
  assertEquals(mergeHomeDays(apart, { evidence: () => true }).length, 2);
  // Nor a day away.
  const away = rollupClusters(clusterMedia([...part('a', 12, STHLM), ...part('b', 36, GBG)], opts), rollup);
  assertEquals(mergeHomeDays(away, { evidence: () => true }).length, 2);
});

Deno.test('shots: a burst from one camera is one shot; another camera a second later is another', () => {
  const at = (s: number, device?: string): ClusterItem => ({ path: `/${s}${device ?? ''}`, timeMs: t(1) + s * 1000, ...(device ? { device } : {}) });
  assertEquals(shotsOf([at(0, 'cam'), at(3, 'cam'), at(8, 'cam'), at(30, 'cam')]), 2);
  assertEquals(shotsOf([at(0, 'cam'), at(1, 'phone')]), 2);
  assertEquals(shotsOf([at(0), at(2), at(4)]), 1);
});

Deno.test("a year's usual day is the median of its days' shots, rounded down to the ladder", () => {
  assertEquals(baselineOf([]), 1);
  assertEquals(baselineOf([1, 1, 2]), 1);
  assertEquals(baselineOf([3, 4, 5, 6, 7]), 4);
  assertEquals(baselineOf([20, 21, 22]), 16);
  assertEquals(baselineOf([5, 6]), 4);
});
