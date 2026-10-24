/**
 * The archive bridge's rules: each rule set sees only the routing keys it binds; and the staging
 * rules, which announce `media.duplicates.stale` for files crossing an inbox's edge,
 * `staging.retime.requested` for files moved into a category that dates by other clocks, and
 * `staging.sidecars.arrived` for a folder where a sidecar may now pair with its file.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ARCHIVE_BRIDGE_ROUTING_KEYS, type ArchiveRuleContext, deriveArchiveEvents, type VfsEventInput } from '../lib/event-rules.ts';
import { MEDIA_BRIDGE_ROUTING_KEYS, MEDIA_EVENTS, type NodeSnapshot } from '../lib/media/event-rules.ts';
import { LOCATION_BRIDGE_ROUTING_KEYS, LOCATION_EVENTS } from '../lib/location/event-rules.ts';
import { STAGING_BRIDGE_ROUTING_KEYS, STAGING_EVENTS } from '../lib/staging/facts.ts';

const FILE = `${ALBUMS_ROOT}/trip/files/a.jpg`;
const POINT = `${FILE}/position`;

/** A photo with a GPS point written. */
const nodes: Record<string, NodeSnapshot> = {
  [FILE]: { id: 'f1', type: 'file', attrs: { mimetype: 'image/jpeg', size: 10 } },
  [POINT]: { id: 'p1', type: 'position', attrs: {} },
};

const ctx: ArchiveRuleContext = {
  getNode: (path) => Promise.resolve(nodes[path]),
  exists: (path) => Promise.resolve(path in nodes),
  getLink: () => Promise.resolve(undefined),
  hasPoint: (path) => Promise.resolve(path === POINT),
};

const event = (type: string, changedAttrs?: string[]): VfsEventInput => ({
  type,
  path: POINT,
  nodeId: 'p1',
  nodeType: 'position',
  timestamp: 1,
  ...(changedAttrs ? { changedAttrs } : {}),
});

const types = async (input: VfsEventInput) => (await deriveArchiveEvents(input, ctx, 1)).map((fact) => fact.type).sort();

Deno.test('archive rules: the queue binds every key of every rule set, each once', () => {
  assertEquals(new Set(ARCHIVE_BRIDGE_ROUTING_KEYS), new Set([...STAGING_BRIDGE_ROUTING_KEYS, ...MEDIA_BRIDGE_ROUTING_KEYS, ...LOCATION_BRIDGE_ROUTING_KEYS]));
  assertEquals(ARCHIVE_BRIDGE_ROUTING_KEYS.length, new Set(ARCHIVE_BRIDGE_ROUTING_KEYS).size);
});

Deno.test('archive rules: a key both rule sets bind reaches both', async () => {
  assertEquals(await types(event('created')), [LOCATION_EVENTS.pointChanged, MEDIA_EVENTS.positionAvailable].sort());
});

Deno.test('archive rules: a key only one rule set binds reaches only that one', async () => {
  // The media rules would announce the position again on every write of the point.
  assertEquals(await types(event('updated', [])), [LOCATION_EVENTS.pointChanged]);
});

Deno.test('archive rules: every fact names the write it was derived from, when the trail kept one', async () => {
  const facts = await deriveArchiveEvents({ ...event('created'), uid: 1001, auditId: 'r1' }, ctx, 1);
  assertEquals(facts.map((fact) => fact.write), [{ auditId: 'r1', uid: 1001 }, { auditId: 'r1', uid: 1001 }]);
  assertEquals((await deriveArchiveEvents(event('created'), ctx, 1)).map((fact) => fact.write), [undefined, undefined]);
});

const INBOX = '/home/anna/staging/files/inbox';
const STAGED = `${INBOX}/upload-2026-10-01/IMG_0001.jpg`;
const SHA = 'c'.repeat(64);

/** A staged photo with checksum `SHA` and the finding given, at `path`. */
const photo = (duplicate?: Record<string, unknown>, extra: Record<string, unknown> = {}): NodeSnapshot => ({
  id: 'f9',
  type: 'file',
  attrs: { mimetype: 'image/jpeg', size: 10, sha256: SHA, ...(duplicate ? { duplicate } : {}), ...extra },
});

/** A category directory: what the staging rules read a category's time rules off. */
const CATEGORY_DIR = /^\/home\/[^/]+\/staging\/files\/[^/]+$/;

/**
 * The subjects of the facts of `type` an event announces when `nodes` are what the bridge reads;
 * `reads` counts its reads of anything but a category.
 */
const announced = async (type: string, input: Partial<VfsEventInput>, nodes: Record<string, NodeSnapshot> = {}) => {
  let reads = 0;
  const staging: ArchiveRuleContext = {
    ...ctx,
    getNode: (path) => {
      if (!CATEGORY_DIR.test(path)) reads++;
      return Promise.resolve(nodes[path]);
    },
  };
  const event: VfsEventInput = { type: 'moved', path: STAGED, nodeId: 'f9', nodeType: 'file', timestamp: 1, ...input };
  const facts = await deriveArchiveEvents(event, staging, 1);
  return { subjects: facts.filter((fact) => fact.type === type).map((fact) => fact.subject), reads };
};

const stale = (input: Partial<VfsEventInput>, nodes: Record<string, NodeSnapshot> = {}) => announced(MEDIA_EVENTS.duplicatesStale, input, nodes);

Deno.test('staging rules: a file moved into an inbox is announced unless its finding holds there', async () => {
  const from = { fromPath: '/home/anna/elsewhere/IMG_0001.jpg' };
  assertEquals((await stale(from, { [STAGED]: photo() })).subjects, [STAGED]);
  assertEquals((await stale(from, { [STAGED]: photo({ inbox: 'bob', sha256: SHA, at: 'x' }) })).subjects, [STAGED]);
  assertEquals((await stale(from, { [STAGED]: photo({ inbox: 'anna', sha256: 'd'.repeat(64), at: 'x' }) })).subjects, [STAGED]);
  assertEquals((await stale(from, { [STAGED]: photo({ inbox: 'anna', sha256: SHA, at: 'x' }) })).subjects, []);
  // Out of a trash: the trashed form is in no inbox.
  assertEquals((await stale({ fromPath: '/home/anna/.trash/01J/01K/IMG_0001.jpg' }, { [STAGED]: photo({ sha256: SHA, at: 'x' }) })).subjects, [STAGED]);
  // Nothing to find for what is no media original with a checksum.
  assertEquals((await stale(from, { [STAGED]: photo(undefined, { sourceId: 'f0' }) })).subjects, []);
  assertEquals((await stale(from, { [STAGED]: photo(undefined, { sha256: undefined }) })).subjects, []);
});

Deno.test('staging rules: a move inside an inbox, between categories too, announces no copies and reads no file', async () => {
  const moved = await stale({ fromPath: '/home/anna/staging/files/scans/box-3/IMG_0001.jpg' }, { [STAGED]: photo() });
  assertEquals(moved, { subjects: [], reads: 0 });
  const dir = await stale({ path: `${INBOX}/box-3`, nodeType: 'directory', fromPath: '/home/anna/staging/files/scans/box-3' });
  assertEquals(dir, { subjects: [], reads: 0 });
});

Deno.test('staging rules: a directory moved into an inbox from outside is announced whole, without a read', async () => {
  const dir = `${INBOX}/box-3`;
  assertEquals(await stale({ path: dir, nodeType: 'directory', fromPath: '/home/anna/box-3' }), { subjects: [dir], reads: 0 });
  assertEquals(await stale({ path: dir, nodeType: 'directory', fromPath: '/home/bob/staging/files/inbox/box-3' }), { subjects: [dir], reads: 0 });
});

Deno.test('staging rules: a file filed into the library is announced; a move within the library is not', async () => {
  const filed = `${ALBUMS_ROOT}/lake/files/IMG_0001.jpg`;
  assertEquals((await stale({ path: filed, fromPath: STAGED }, { [filed]: photo() })).subjects, [filed]);
  assertEquals((await stale({ path: filed, fromPath: `${ALBUMS_ROOT}/pier/files/IMG_0001.jpg` }, { [filed]: photo() })).subjects, []);
  assertEquals((await stale({ path: `${ALBUMS_ROOT}/lake`, nodeType: 'directory', fromPath: '/home/anna/lake' })).subjects, [`${ALBUMS_ROOT}/lake`]);
  // A move anywhere else concerns no finding.
  assertEquals(await stale({ path: '/home/anna/elsewhere/IMG_0001.jpg', fromPath: STAGED }), { subjects: [], reads: 0 });
});

Deno.test('staging rules: a file whose fingerprint lands is announced nowhere, as compute-fingerprint checks it', async () => {
  const library = `${ALBUMS_ROOT}/lake/files/IMG_0001.jpg`;
  const fingerprinted = { type: 'updated', changedAttrs: ['fingerprintedAt'] };
  assertEquals((await stale({ ...fingerprinted, path: library }, { [library]: photo() })).subjects, []);
  assertEquals((await stale({ ...fingerprinted, path: STAGED }, { [STAGED]: photo() })).subjects, []);
});

/** A category directory of `kind`'s time rules, as the bridge reads it. */
const category = (id: string, time?: { digitized: boolean; filenameDates: boolean }): NodeSnapshot => ({
  id,
  type: 'directory',
  attrs: { stagingCategory: { kind: 'generic', label: id, group: { strategy: 'events', significance: 'normal' }, ...(time ? { time } : {}) } },
});
const CLOCKS = { digitized: false, filenameDates: false };
const DIGITIZED = { digitized: true, filenameDates: false };
const ANNA = '/home/anna/staging/files';
const BATCH = `${INBOX}/upload-2026-10-01`;
/** Anna's categories: the inbox (names are dates), `camera` and `cards` (own clocks), `scans` (digitized), and the batch folder. */
const categories: Record<string, NodeSnapshot> = {
  [INBOX]: category('c-inbox', { digitized: false, filenameDates: true }),
  [`${ANNA}/camera`]: category('c-camera', CLOCKS),
  [`${ANNA}/cards`]: category('c-cards'),
  [`${ANNA}/scans`]: category('c-scans', DIGITIZED),
  [BATCH]: { id: 'd-batch', type: 'directory', attrs: {} },
};
const retime = (input: Partial<VfsEventInput>, nodes: Record<string, NodeSnapshot> = {}) => announced(STAGING_EVENTS.retimeRequested, input, { ...categories, ...nodes });
/** A staged photo named `IMG_20190601_123456.jpg`, with the stamps given. */
const named = `${BATCH}/IMG_20190601_123456.jpg`;
const stamped = (attrs: Record<string, unknown> = {}): NodeSnapshot => ({ id: 'f9', type: 'file', attrs: { mimetype: 'image/jpeg', size: 10, ...attrs } });

Deno.test('staging rules: a move between categories with the same time rules announces no retime and reads no file', async () => {
  // `cards` stores no time rules, and reads as its generic kind's: the camera's.
  for (const [from, to] of [[`${ANNA}/camera/a`, `${ANNA}/cards/a`], [`${ANNA}/cards/a`, `${ANNA}/camera/a`]]) {
    assertEquals(await retime({ path: to, nodeType: 'directory', fromPath: from }), { subjects: [], reads: 0 });
    assertEquals(await retime({ path: `${to}/IMG_0001.jpg`, fromPath: `${from}/IMG_0001.jpg` }), { subjects: [], reads: 0 });
  }
  // Nor does a move within one category, or out of staging.
  assertEquals(await retime({ path: `${BATCH}/a`, nodeType: 'directory', fromPath: `${INBOX}/b` }), { subjects: [], reads: 0 });
  assertEquals((await retime({ path: `${ALBUMS_ROOT}/lake/files/a.jpg`, fromPath: `${ANNA}/scans/a.jpg` }, { [`${ALBUMS_ROOT}/lake/files/a.jpg`]: stamped() })).subjects, []);
});

Deno.test('staging rules: a directory moved into a category with other time rules, or from outside every category, is announced whole', async () => {
  const box = `${ANNA}/scans/box-3`;
  assertEquals(await retime({ path: box, nodeType: 'directory', fromPath: `${INBOX}/box-3` }), { subjects: [box], reads: 0 });
  assertEquals(await retime({ path: `${INBOX}/box-3`, nodeType: 'directory', fromPath: box }), { subjects: [`${INBOX}/box-3`], reads: 0 });
  assertEquals(await retime({ path: box, nodeType: 'directory', fromPath: '/home/anna/box-3' }), { subjects: [box], reads: 0 });
  // A category that cannot be read is no reason to retime anything.
  assertEquals(await retime({ path: `${ANNA}/gone/box-3`, nodeType: 'directory', fromPath: box }), { subjects: [], reads: 0 });
});

Deno.test("staging rules: a file moved in is announced, by its folder, when its stamps disagree with the category's rules", async () => {
  const from = { fromPath: `${ANNA}/camera/IMG_20190601_123456.jpg` };
  // Into the inbox, whose names are dates: unstamped, it is retimed; stamped with its name's date, not.
  assertEquals((await retime({ path: named, ...from }, { [named]: stamped() })).subjects, [BATCH]);
  assertEquals((await retime({ path: named, ...from }, { [named]: stamped({ whenName: '2019-06-01T12:34:56' }) })).subjects, []);
  // From the library too, which has no rules of its own: the stamps alone decide.
  const filed = { fromPath: `${ALBUMS_ROOT}/lake/files/IMG_20190601_123456.jpg` };
  assertEquals((await retime({ path: named, ...filed }, { [named]: stamped({ digitized: true }) })).subjects, [BATCH]);
  assertEquals((await retime({ path: named, ...filed }, { [named]: stamped({ whenName: '2019-06-01T12:34:56' }) })).subjects, []);
  // Into scans: a file not stamped as digitized is retimed.
  const scan = `${ANNA}/scans/IMG_0001.jpg`;
  assertEquals((await retime({ path: scan, fromPath: `${INBOX}/IMG_0001.jpg` }, { [scan]: stamped(), [`${ANNA}/scans`]: categories[`${ANNA}/scans`] })).subjects, [
    `${ANNA}/scans`,
  ]);
  // What is no media original is never dated.
  assertEquals((await retime({ path: named, ...from }, { [named]: stamped({ sourceId: 'f0' }) })).subjects, []);
  assertEquals((await retime({ path: named, ...from }, { [named]: stamped({ mimetype: 'text/plain' }) })).subjects, []);
});

Deno.test('staging rules: a retime fact names the category, and the file a folder stands for', async () => {
  const staging: ArchiveRuleContext = { ...ctx, getNode: (path) => Promise.resolve({ ...categories, [named]: stamped() }[path]) };
  const facts = await deriveArchiveEvents({ type: 'moved', path: named, nodeId: 'f9', nodeType: 'file', timestamp: 1, fromPath: `${ANNA}/camera/x.jpg` }, staging, 1);
  const fact = facts.find((each) => each.type === STAGING_EVENTS.retimeRequested)!;
  assertEquals([fact.subject, fact.nodeId, fact.data], [BATCH, 'd-batch', { cause: 'moved', category: 'anna/inbox', file: named }]);
});

/** Anna's `takeout` (pairs sidecars) and `whatsapp` (a messaging category: does not), and a folder of each. */
const TAKEOUT_DIR = `${ANNA}/takeout/upload-2026-10-18`;
const CHAT_DIR = `${ANNA}/whatsapp/upload-2026-10-18`;
const sidecarTree: Record<string, NodeSnapshot> = {
  [`${ANNA}/takeout`]: { id: 'c-takeout', type: 'directory', attrs: { stagingCategory: { kind: 'google-photos' } } },
  [`${ANNA}/whatsapp`]: { id: 'c-chat', type: 'directory', attrs: { stagingCategory: { kind: 'messaging' } } },
  [TAKEOUT_DIR]: { id: 'd-takeout', type: 'directory', attrs: {} },
  [CHAT_DIR]: { id: 'd-chat', type: 'directory', attrs: {} },
};
const json = (attrs: Record<string, unknown> = {}): NodeSnapshot => ({ id: 's1', type: 'file', attrs: { mimetype: 'application/json', size: 400, sha256: SHA, ...attrs } });

/** The sidecar facts of `input`, as subject and cause, and the folders asked for an unpaired sidecar. */
const arrivals = async (input: Partial<VfsEventInput>, nodes: Record<string, NodeSnapshot>, unpaired: string[] = [], context?: ArchiveRuleContext) => {
  const asked: string[] = [];
  const staging: ArchiveRuleContext = context ?? {
    ...ctx,
    getNode: (path) => Promise.resolve({ ...sidecarTree, ...nodes }[path]),
    unpairedSidecarsIn: (path) => {
      asked.push(path);
      return Promise.resolve(unpaired.includes(path));
    },
  };
  const event: VfsEventInput = { type: 'updated', path: '', nodeId: 'n1', nodeType: 'file', timestamp: 1, changedAttrs: ['sha256'], ...input };
  const facts = (await deriveArchiveEvents(event, staging, 1)).filter((fact) => fact.type === STAGING_EVENTS.sidecarsArrived);
  return { facts: facts.map((fact) => [fact.subject, fact.data?.cause, fact.lane ?? 'normal']), asked };
};

Deno.test('staging rules: a sidecar landing unpaired in a category that pairs them announces its folder, in its lane', async () => {
  const sidecar = `${TAKEOUT_DIR}/IMG_0001.jpg.supplemental-metadata.json`;
  assertEquals((await arrivals({ path: sidecar }, { [sidecar]: json() })).facts, [[TAKEOUT_DIR, 'sidecar', 'bulk']]);
  assertEquals((await arrivals({ path: sidecar, type: 'moved', fromPath: '/home/anna/IMG_0001.jpg.json', changedAttrs: undefined }, { [sidecar]: json() })).facts, [[
    TAKEOUT_DIR,
    'sidecar',
    'bulk',
  ]]);
  // Not until its bytes have landed, not once paired, and not where sidecars are not paired.
  assertEquals((await arrivals({ path: sidecar, changedAttrs: ['mimetype'] }, { [sidecar]: json() })).facts, []);
  assertEquals((await arrivals({ path: sidecar }, { [sidecar]: json({ sourceId: 'f1', sidecar: { kind: 'takeout' } }) })).facts, []);
  const chat = `${CHAT_DIR}/IMG-20190601-WA0001.jpg.json`;
  assertEquals((await arrivals({ path: chat }, { [chat]: json() })).facts, []);
});

Deno.test('staging rules: a photo landing beside an unpaired sidecar announces its folder; elsewhere it asks once in ten seconds', async () => {
  const photoPath = `${TAKEOUT_DIR}/IMG_0001.jpg`;
  const nodes = { [photoPath]: photo() };
  assertEquals(await arrivals({ path: photoPath }, nodes, [TAKEOUT_DIR]), { facts: [[TAKEOUT_DIR, 'media', 'bulk']], asked: [TAKEOUT_DIR] });
  assertEquals(await arrivals({ path: photoPath }, nodes, []), { facts: [], asked: [TAKEOUT_DIR] });
  // A rendition under a photo is no arrival.
  const thumb = `${photoPath}/thumbnails/w320.webp`;
  assertEquals((await arrivals({ path: thumb }, { [thumb]: photo(undefined, { sourceId: 'f9' }) }, [`${photoPath}/thumbnails`])).facts, []);

  // One context, as the bridge keeps it: a folder's answer is kept, and a sidecar landing there changes it at once.
  const asked: string[] = [];
  const bridge: ArchiveRuleContext = {
    ...ctx,
    getNode: (path) => Promise.resolve({ ...sidecarTree, ...nodes, [`${TAKEOUT_DIR}/IMG_0001.jpg.json`]: json() }[path]),
    unpairedSidecarsIn: (path) => {
      asked.push(path);
      return Promise.resolve(false);
    },
  };
  assertEquals((await arrivals({ path: photoPath }, {}, [], bridge)).facts, []);
  assertEquals((await arrivals({ path: photoPath }, {}, [], bridge)).facts, []);
  assertEquals((await arrivals({ path: `${TAKEOUT_DIR}/IMG_0001.jpg.json` }, {}, [], bridge)).facts, [[TAKEOUT_DIR, 'sidecar', 'bulk']]);
  assertEquals((await arrivals({ path: photoPath }, {}, [], bridge)).facts, [[TAKEOUT_DIR, 'media', 'bulk']]);
  assertEquals(asked, [TAKEOUT_DIR]);
});

Deno.test('staging rules: a directory moved into a category that pairs sidecars is announced whole', async () => {
  const moved = (path: string, fromPath: string) => arrivals({ type: 'moved', nodeType: 'directory', path, fromPath, changedAttrs: undefined }, {});
  assertEquals((await moved(`${ANNA}/takeout/part-2`, '/home/anna/part-2')).facts, [[`${ANNA}/takeout/part-2`, 'moved', 'bulk']]);
  assertEquals((await moved(`${ANNA}/takeout/part-2`, `${ANNA}/whatsapp/part-2`)).facts, [[`${ANNA}/takeout/part-2`, 'moved', 'bulk']]);
  assertEquals((await moved(`${ANNA}/takeout/part-2`, `${ANNA}/takeout/part-1`)).facts, []);
  assertEquals((await moved(`${ANNA}/whatsapp/part-2`, '/home/anna/part-2')).facts, []);
});
