/**
 * The plan of a category, pure: clutter, machine names, seeds, scan runs, period and undated
 * lanes, significance and its presets, Everyday lanes by year and month, a person's edits, and
 * that every item ends in exactly one group whatever the strategy. Fast tier: no VFS.
 */
import type { StagingEdit } from '@archive/staging/api';
import { assert, assertEquals } from '@std/assert';
import { classifyItem, folderRuns, isMachineName, planCategory, type PlanContext, type PlanFolder, type PlanItem, type PlannedGroup } from '../../lib/staging/strategy.ts';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const STHLM = { lat: 59.33, lng: 18.06 };
const GBG = { lat: 57.7, lng: 11.97 };

const folders = new Map<string, PlanFolder>([
  ['batch', { id: 'batch', path: '/c/upload-2026-10-01', name: 'upload-2026-10-01', depth: 1 }],
  ['lake', { id: 'lake', path: '/c/upload-2026-10-01/Lake weekend', name: 'Lake weekend', depth: 2 }],
  ['dcim', { id: 'dcim', path: '/c/upload-2026-10-01/DCIM', name: 'DCIM', depth: 2 }],
  ['album', { id: 'album', path: '/c/Takeout', name: 'Takeout', depth: 1, title: 'Summer at the cottage' }],
  ['box', { id: 'box', path: '/c/box-3', name: 'box-3', depth: 1 }],
]);

let serial = 0;
/** A dated photo at `at` (ISO, UTC), in the batch folder unless said otherwise. */
const photo = (at: string, over: Partial<PlanItem> = {}): PlanItem => {
  const id = over.id ?? `i${String(serial++).padStart(5, '0')}`;
  const folder = folders.get(over.folderId ?? 'batch')!;
  return {
    id,
    path: `${folder.path}/${id}.jpg`,
    name: `${id}.jpg`,
    folderId: folder.id,
    folder: folder.path,
    mimetype: 'image/jpeg',
    timeMs: Date.parse(at),
    day: at.slice(0, 10),
    takenAt: at.replace('Z', ''),
    precision: 'instant',
    ...over,
  };
};

/** `n` photos `everyMin` minutes apart from `start`. */
const run = (start: string, n: number, everyMin = 5, over: Partial<PlanItem> = {}): PlanItem[] =>
  Array.from({ length: n }, (_, i) => photo(new Date(Date.parse(start) + i * everyMin * MIN).toISOString(), over));

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ strategy: 'events', significance: 'normal', edits: [], folders, home: () => STHLM, ...over });

/** Every item of `items` is in exactly one group. */
const assertPartition = (items: PlanItem[], groups: PlannedGroup[]) => {
  const seen = new Map<string, number>();
  for (const group of groups) for (const item of group.items) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
  assertEquals(seen.size, items.length, 'every item is in a group');
  assert([...seen.values()].every((count) => count === 1), 'no item is in two groups');
};

const kinds = (groups: PlannedGroup[]) => groups.map((group) => group.kind).sort();

Deno.test('clutter: screenshots and saved images by name, folder and screen size', () => {
  const base = { mimetype: 'image/jpeg', folderNames: [] as string[] };
  assertEquals(classifyItem({ ...base, name: 'Screenshot_20190601-101500.png' }), 'screenshot');
  assertEquals(classifyItem({ ...base, name: 'Skärmavbild 2019-06-01 kl. 10.15.00.png' }), 'screenshot');
  assertEquals(classifyItem({ ...base, name: 'IMG_0001.jpg', folderNames: ['Screenshots'] }), 'screenshot');
  assertEquals(classifyItem({ ...base, name: 'IMG-20190601-WA0003.jpg' }), 'saved');
  assertEquals(classifyItem({ ...base, name: 'FB_IMG_1559375700000.jpg' }), 'saved');
  assertEquals(classifyItem({ ...base, name: 'received_10157.jpeg' }), 'saved');
  assertEquals(classifyItem({ ...base, name: 'IMG_0001.jpg', folderNames: ['WhatsApp Images'] }), 'saved');
  const png = { name: 'image.png', mimetype: 'image/png', width: 1080, height: 1920, folderNames: [] };
  assertEquals(classifyItem(png), 'screenshot');
  assertEquals(classifyItem({ ...png, width: 1920, height: 1080 }), 'screenshot');
  // A camera, a GPS fix, a JPEG or another size: a photograph.
  assertEquals(classifyItem({ ...png, devicePath: '/archive/devices/phone' }), undefined);
  assertEquals(classifyItem({ ...png, takenAtSource: 'gps' }), undefined);
  assertEquals(classifyItem({ ...png, mimetype: 'image/jpeg' }), undefined);
  assertEquals(classifyItem({ ...png, width: 1000 }), undefined);
  assertEquals(classifyItem({ ...base, name: 'IMG_0001.jpg' }), undefined);
});

Deno.test('machine names are what cameras, exports and uploads call folders', () => {
  for (
    const name of [
      'DCIM',
      '100CANON',
      '101_FUJI',
      '2019',
      '2019-06',
      '2019-06-01',
      'Photos from 2019',
      'Takeout',
      'Google Photos',
      'upload-2026-10-01',
      'WhatsApp Images',
      'Screenshots',
    ]
  ) {
    assertEquals(isMachineName(name), true, name);
  }
  for (const name of ['Lake weekend', "Grandmother's 80th", 'Box 3']) assertEquals(isMachineName(name), false, name);
});

Deno.test('seeds: a named folder below a batch, or one an import titled; not a batch, not a machine name, not dismissed', () => {
  const lake = run('2019-06-14T10:00:00Z', 3, 5, { folderId: 'lake' });
  const dcim = run('2019-06-20T10:00:00Z', 3, 5, { folderId: 'dcim' });
  const titled = run('2019-07-01T10:00:00Z', 3, 5, { folderId: 'album' });
  const loose = run('2019-08-01T10:00:00Z', 3, 5);
  const items = [...lake, ...dcim, ...titled, ...loose];
  const plan = planCategory(items, ctx());
  const seeds = plan.groups.filter((group) => group.kind === 'seed');
  assertEquals(seeds.map((seed) => seed.seed), [{ source: 'folder', label: 'Lake weekend' }, { source: 'takeout-album', label: 'Summer at the cottage' }]);
  assertEquals(seeds[0].key, 'seed:lake');
  assertPartition(items, plan.groups);
  // Dismissed, its pictures go back to the timeline.
  const dismissed = planCategory(items, ctx({ edits: [{ category: 'inbox', op: 'dismiss', members: lake.map((item) => item.id) }] }));
  assertEquals(dismissed.groups.filter((group) => group.kind === 'seed').length, 1);
  assertPartition(items, dismissed.groups);
});

Deno.test('scan runs: a stem change, a counter jump, a change of year by hand and a cut end a run; a short run joins the one before', () => {
  const scan = (name: string, over: Partial<PlanItem> = {}): PlanItem => ({ ...photo('2026-10-01T10:00:00Z', { folderId: 'box' }), name, ...over });
  const names = (runs: PlanItem[][]) => runs.map((each) => each.map((item) => item.name));
  const box = ['scan_001', 'scan_002', 'scan_003', 'scan_004', 'scan_050', 'scan_051', 'scan_052', 'roll_001', 'roll_002', 'roll_003'].map((name) => scan(`${name}.tif`));
  assertEquals(names(folderRuns(box)), [
    ['roll_001.tif', 'roll_002.tif', 'roll_003.tif'],
    ['scan_001.tif', 'scan_002.tif', 'scan_003.tif', 'scan_004.tif'],
    ['scan_050.tif', 'scan_051.tif', 'scan_052.tif'],
  ]);
  // A two-scan run joins the run before it.
  const short = ['a_001', 'a_002', 'a_003', 'a_090', 'a_091'].map((name) => scan(`${name}.tif`));
  assertEquals(folderRuns(short).map((each) => each.length), [5]);
  // Dates set by hand in two years split a run.
  const dated = [
    scan('p_1.tif', { takenAtSource: 'manual', takenAt: '1975' }),
    scan('p_2.tif', { takenAtSource: 'manual', takenAt: '1975' }),
    scan('p_3.tif', { takenAtSource: 'manual', takenAt: '1975' }),
    scan('p_4.tif', { takenAtSource: 'manual', takenAt: '1980' }),
    scan('p_5.tif', { takenAtSource: 'manual', takenAt: '1980' }),
    scan('p_6.tif', { takenAtSource: 'manual', takenAt: '1980' }),
  ];
  assertEquals(folderRuns(dated).map((each) => each.length), [3, 3]);
  // A person's cut.
  assertEquals(folderRuns(box.slice(0, 4), new Set([box[1].id])).map((each) => each.length), [2, 2]);
  // Scan time never groups: a scans category plans runs, whatever the clock says.
  const plan = planCategory(box, ctx({ strategy: 'folders' }));
  assertEquals(plan.groups.map((group) => [group.kind, group.items.length]), [['folder', 3], ['folder', 4], ['folder', 3]]);
  assertPartition(box, plan.groups);
});

Deno.test('a run above 300 scans splits at its largest jump', () => {
  const box = Array.from(
    { length: 320 },
    (_, i) => ({ ...photo('2026-10-01T10:00:00Z', { folderId: 'box' }), name: `s_${String(i < 150 ? i : i + 15).padStart(4, '0')}.tif` }),
  );
  assertEquals(folderRuns(box).map((each) => each.length), [150, 170]);
});

Deno.test('pictures dated to a year or a month go to period lanes per folder, and undated ones to undated lanes; never at an instant', () => {
  const year = [photo('1974-12-31T23:00:00Z', { takenAt: '1975', precision: 'year' }), photo('1974-12-31T23:00:00Z', { takenAt: '1975', precision: 'year' })];
  const month = [photo('1975-05-31T23:00:00Z', { takenAt: '1975-06', precision: 'month' })];
  const none = [photo('2000-01-01T00:00:00Z', { precision: 'none', timeMs: Number.NaN, takenAt: undefined, day: undefined })];
  const plan = planCategory([...year, ...month, ...none], ctx());
  const keys = plan.groups.map((group) => [group.key, group.kind, group.precision, group.items.length]);
  assertEquals(keys, [['period:1975:batch', 'loose', 'year', 2], ['period:1975-06:batch', 'loose', 'month', 1], ['undated:batch', 'undated', undefined, 1]]);
  assertEquals(plan.groups[0].lane, { kind: 'period', folder: 'upload-2026-10-01', chunk: 1, period: '1975' });
});

Deno.test('significance: a big day, a trip and a small day under each preset', () => {
  // A usual day of two shots, most days of the year.
  const usual = Array.from({ length: 9 }, (_, d) => run(`2019-03-${String(d + 1).padStart(2, '0')}T12:00:00Z`, 2, 60)).flat();
  const small = run('2019-05-04T10:00:00Z', 3, 30);
  const big = run('2019-05-11T10:00:00Z', 12, 10);
  const trip = [...run('2019-07-01T10:00:00Z', 3, 30, GBG), ...run('2019-07-02T10:00:00Z', 3, 30, GBG)];
  const items = [...usual, ...small, ...big, ...trip];
  const normal = planCategory(items, ctx());
  assertEquals(normal.baselines['2019'], 2);
  const events = normal.groups.filter((group) => group.kind === 'event' || group.kind === 'trip');
  assertEquals(events.map((group) => [group.kind, group.significance?.reason, group.items.length]), [['event', 'size', 12], ['trip', 'trip', 6]]);
  assertEquals(normal.groups.filter((group) => group.kind === 'loose').map((group) => [group.key, group.items.length]), [['loose:2019', 21]]);
  assertPartition(items, normal.groups);
  // `more` keeps the three-shot day; `fewer` keeps neither day at home, but still the trip.
  assert(planCategory(items, ctx({ significance: 'more' })).groups.some((group) => group.kind === 'event' && group.items.length === 3));
  assertEquals(planCategory(items, ctx({ significance: 'fewer' })).groups.filter((group) => group.kind === 'event').map((group) => group.items.length), [12]);
});

Deno.test('an occasion, guests and a named place each keep a day', () => {
  const eve = run('2019-12-24T15:00:00Z', 3, 30);
  const guests = run('2019-03-09T15:00:00Z', 3, 30, { persons: ['visitor'] });
  const place = run('2019-04-13T15:00:00Z', 4, 30);
  const plain = run('2019-04-27T15:00:00Z', 3, 30);
  const items = [...eve, ...guests, ...place, ...plain];
  const plan = planCategory(items, ctx({ isGuest: (id) => id === 'visitor', atPlace: (members) => members.includes(place[0]) }));
  assertEquals(plan.groups.filter((group) => group.kind === 'event').map((group) => group.significance?.reason).sort(), ['guests', 'occasion', 'place']);
  assertEquals(plan.groups.find((group) => group.kind === 'loose')?.items.length, 3);
});

Deno.test('Everyday lanes: a year, months above 400 items once and for good, and a month chunked at day boundaries above 1,000', () => {
  const few = run('2014-06-01T10:00:00Z', 2, 600);
  assertEquals(planCategory(few, ctx()).groups.map((group) => group.key), ['loose:2014']);
  // An earlier run split the year: it stays split however few remain.
  const split = planCategory(few, ctx({ granularity: { 'loose:2014': 'month' } }));
  assertEquals(split.groups.map((group) => group.key), ['loose:2014-06']);
  assertEquals(split.granularity['loose:2014'], 'month');
  // Over 400 in a year: by month, and the plan says so for the next run.
  const many = Array.from({ length: 450 }, (_, i) => photo(new Date(Date.parse('2015-01-01T12:00:00Z') + i * 18 * HOUR).toISOString()));
  const monthly = planCategory(many, ctx({ significance: 'fewer', home: undefined }));
  assert(monthly.groups.filter((group) => group.kind === 'loose').every((group) => /^loose:\d{4}-\d{2}$/.test(group.key!)));
  assertEquals(monthly.granularity['loose:2015'], 'month');
  assertPartition(many, monthly.groups);
});

Deno.test('edits: a cut splits a day; a join holds two together; a dismissal demotes; an assignment moves', () => {
  // A usual day of one shot, most days of the year, beside a busy Saturday.
  const usual = Array.from({ length: 9 }, (_, d) => run(`2019-03-${String(d + 1).padStart(2, '0')}T12:00:00Z`, 1)).flat();
  const morning = run('2019-05-11T08:00:00Z', 6, 10);
  const later = run('2019-05-11T10:00:00Z', 6, 10);
  const items = [...usual, ...morning, ...later];
  const events = (groups: PlannedGroup[]) => groups.filter((group) => group.kind !== 'loose');
  assertEquals(events(planCategory(items, ctx()).groups).map((group) => [group.kind, group.items.length]), [['event', 12]]);

  const cut: StagingEdit = { category: 'inbox', op: 'cut', after: morning[5].id };
  const cutPlan = planCategory(items, ctx({ edits: [cut] }));
  assertEquals(events(cutPlan.groups).map((group) => [group.items.length, group.significance?.reason]), [[6, 'size'], [6, 'size']]);
  // Pieces too small to stand alone are kept as the person's.
  const pair = [...run('2019-05-18T08:00:00Z', 2, 10), ...run('2019-05-18T08:30:00Z', 2, 10)];
  const pairCut: StagingEdit = { category: 'inbox', op: 'cut', after: pair[1].id };
  assertEquals(events(planCategory([...usual, ...pair], ctx({ edits: [pairCut] })).groups).map((group) => [group.items.length, group.significance?.reason]), [[2, 'edited'], [
    2,
    'edited',
  ]]);

  // Two small days at home a week apart, joined by a person: one group.
  const a = run('2019-06-01T12:00:00Z', 2, 30);
  const b = run('2019-06-08T12:00:00Z', 2, 30);
  const join: StagingEdit = { category: 'inbox', op: 'join', first: a[0].id, last: b[1].id };
  assertEquals(planCategory([...a, ...b], ctx({ edits: [join] })).groups.map((group) => [group.kind, group.items.length]), [['event', 4]]);
  // Bounded, a run lifted out of its day stays apart from the rest of it.
  const day = run('2019-06-15T12:00:00Z', 6, 10);
  const lifted: StagingEdit = { category: 'inbox', op: 'join', first: day[2].id, last: day[3].id, bounded: true };
  assertEquals(planCategory(day, ctx({ edits: [lifted] })).groups.map((group) => group.items.length), [2, 2, 2]);

  const dismiss: StagingEdit = { category: 'inbox', op: 'dismiss', members: [...morning, ...later].map((item) => item.id) };
  assertEquals(kinds(planCategory(items, ctx({ edits: [dismiss] })).groups), ['loose']);

  const stray = photo('2019-08-01T12:00:00Z');
  const assign: StagingEdit = { category: 'inbox', op: 'assign', items: [stray.id], with: morning[0].id };
  const assigned = planCategory([...items, stray], ctx({ edits: [assign] }));
  assertEquals(events(assigned.groups).map((group) => [group.kind, group.items.length]), [['event', 13]]);
  assertPartition([...items, stray], assigned.groups);
});

Deno.test("a photo from a phone's messenger folder, as its Takeout sidecar names it, is clutter", () => {
  const saved = run('2019-06-01T10:00:00Z', 3, 5, { localFolder: 'WhatsApp Images' });
  const own = run('2019-06-01T10:01:00Z', 5);
  const plan = planCategory([...saved, ...own], ctx());
  const clutter = plan.groups.filter((group) => group.kind === 'clutter');
  assertEquals(clutter.flatMap((group) => group.items.map((item) => item.id)).sort(), saved.map((item) => item.id).sort());
  assertPartition([...saved, ...own], plan.groups);
});

Deno.test('a category grouped by month alone: a lane per folder and month', () => {
  const items = [...run('2019-06-01T10:00:00Z', 3), ...run('2019-07-01T10:00:00Z', 2), ...run('2019-06-02T10:00:00Z', 2, 5, { folderId: 'lake' })];
  const plan = planCategory(items, ctx({ strategy: 'none' }));
  const lanes = plan.groups.map((group) => `${group.key} ${group.kind} ${group.items.length}`).sort();
  assertEquals(lanes, ['none:batch:2019-06 loose 3', 'none:batch:2019-07 loose 2', 'none:lake:2019-06 loose 2']);
  assertPartition(items, plan.groups);
});

Deno.test('every item is in exactly one group, whatever the mix and the strategy', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const items: PlanItem[] = [];
  for (let i = 0; i < 2_000; i++) {
    const at = new Date(Date.parse('2016-01-01T00:00:00Z') + Math.floor(random() * 3 * 365 * 24 * 60) * MIN).toISOString();
    const roll = random();
    const folderId = random() < 0.1 ? 'lake' : random() < 0.1 ? 'dcim' : 'batch';
    const where = random() < 0.4 ? (random() < 0.8 ? STHLM : GBG) : {};
    if (roll < 0.05) items.push(photo(at, { folderId, precision: 'none', timeMs: Number.NaN, takenAt: undefined, day: undefined }));
    else if (roll < 0.08) items.push(photo(at, { folderId, precision: 'year', takenAt: at.slice(0, 4) }));
    else if (roll < 0.12) items.push(photo(at, { folderId, name: `Screenshot_${i}.png` }));
    else items.push(photo(at, { folderId, ...where, ...(random() < 0.2 ? { persons: [random() < 0.5 ? 'p1' : 'p2'] } : {}) }));
  }
  for (const strategy of ['events', 'folders', 'none'] as const) {
    const plan = planCategory(items, ctx({ strategy }));
    assertPartition(items, plan.groups);
  }
  // The same items in another order plan the same groups.
  const shuffled = items.toSorted(() => random() - 0.5);
  const ids = (plan: { groups: PlannedGroup[] }) => plan.groups.map((group) => group.items.map((item) => item.id).sort().join()).sort();
  assertEquals(ids(planCategory(shuffled, ctx())), ids(planCategory(items, ctx())));
});
