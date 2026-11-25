/**
 * The archive bridge's rules: each rule set sees only the routing keys it binds; and the staging
 * rules, which announce `media.duplicates.stale` for files crossing an inbox's edge, and
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
  tracksOf: () => Promise.resolve([]),
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

/** A category directory, or a folder above one, which the lanes are read off. */
const CATEGORY_DIR = /^\/(home(\/[^/]+(\/staging(\/files(\/[^/]+)?)?)?)?)?$/;

/**
 * The subjects of the facts of `type` an event announces when `nodes` are what the bridge reads;
 * `reads` counts its reads of anything but a category or a folder above one.
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

Deno.test('staging rules: a file in an inbox or the library is announced when its prints land after its reading; a staged one also on its reading', async () => {
  const library = `${ALBUMS_ROOT}/lake/files/IMG_0001.jpg`;
  const exif = (path: string) => ({ [`${path}/metadata/exif`]: { id: 'e9', type: 'exif', attrs: { indexedAt: '2026-11-06T08:00:00Z' } } });
  const printed = { type: 'updated', changedAttrs: ['fingerprintedAt'] };
  const read = { type: 'updated', changedAttrs: ['takenAt', 'interpretedAt'] };
  const both = photo(undefined, { fingerprintedAt: '2026-11-06T08:05:00Z', interpretedAt: '2026-11-06T08:01:00Z' });

  // The prints land after the reading: announced on the prints.
  assertEquals((await stale({ ...printed, path: STAGED }, { [STAGED]: both })).subjects, [STAGED]);
  assertEquals((await stale({ ...printed, path: library }, { [library]: both })).subjects, [library]);
  // The prints land before the reading: nothing yet, then announced on the reading.
  const unread = photo(undefined, { fingerprintedAt: '2026-11-06T08:05:00Z' });
  assertEquals((await stale({ ...printed, path: STAGED }, { [STAGED]: unread })).subjects, []);
  assertEquals((await stale({ ...read, path: STAGED }, { [STAGED]: both, ...exif(STAGED) })).subjects, [STAGED]);
  // A reading with no prints yet, or with prints older than the file's read, announces nothing.
  const unprinted = photo(undefined, { interpretedAt: '2026-11-06T08:01:00Z' });
  assertEquals((await stale({ ...read, path: STAGED }, { [STAGED]: unprinted, ...exif(STAGED) })).subjects, []);
  const old = photo(undefined, { fingerprintedAt: '2026-10-01T08:00:00Z', interpretedAt: '2026-11-06T08:01:00Z' });
  assertEquals((await stale({ ...read, path: STAGED }, { [STAGED]: old, ...exif(STAGED) })).subjects, []);
  // A library file's reading announces nothing, its prints being of this read or not.
  assertEquals((await stale({ ...read, path: library }, { [library]: both, ...exif(library) })).subjects, []);
  // Outside every inbox and the library, nothing.
  const elsewhere = '/home/anna/elsewhere/IMG_0001.jpg';
  assertEquals((await stale({ ...printed, path: elsewhere }, { [elsewhere]: both })).subjects, []);
});

const ANNA = '/home/anna/staging/files';

/** Anna's `takeout` (its folder in the bulk lane) and `whatsapp`, and a folder of each. */
const TAKEOUT_DIR = `${ANNA}/takeout/upload-2026-10-18`;
const CHAT_DIR = `${ANNA}/whatsapp/upload-2026-10-18`;
const sidecarTree: Record<string, NodeSnapshot> = {
  [`${ANNA}/takeout`]: { id: 'c-takeout', type: 'directory', attrs: { stagingCategory: { label: 'Google Photos' }, lane: 'bulk' } },
  [`${ANNA}/whatsapp`]: { id: 'c-chat', type: 'directory', attrs: { stagingCategory: { label: 'WhatsApp' } } },
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

Deno.test('staging rules: a sidecar landing unpaired in a category announces its folder, in its lane', async () => {
  const sidecar = `${TAKEOUT_DIR}/IMG_0001.jpg.supplemental-metadata.json`;
  assertEquals((await arrivals({ path: sidecar }, { [sidecar]: json() })).facts, [[TAKEOUT_DIR, 'sidecar', 'bulk']]);
  assertEquals((await arrivals({ path: sidecar, type: 'moved', fromPath: '/home/anna/IMG_0001.jpg.json', changedAttrs: undefined }, { [sidecar]: json() })).facts, [[
    TAKEOUT_DIR,
    'sidecar',
    'bulk',
  ]]);
  // Every category pairs them.
  const chat = `${CHAT_DIR}/IMG-20190601-WA0001.jpg.json`;
  assertEquals((await arrivals({ path: chat }, { [chat]: json() })).facts, [[CHAT_DIR, 'sidecar', 'normal']]);
  // Not until its bytes have landed, and not once paired.
  assertEquals((await arrivals({ path: sidecar, changedAttrs: ['mimetype'] }, { [sidecar]: json() })).facts, []);
  assertEquals((await arrivals({ path: sidecar }, { [sidecar]: json({ sourceId: 'f1', sidecar: { kind: 'takeout' } }) })).facts, []);
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

Deno.test('staging rules: a directory moved into a category from outside it is announced whole', async () => {
  const moved = (path: string, fromPath: string) => arrivals({ type: 'moved', nodeType: 'directory', path, fromPath, changedAttrs: undefined }, {});
  assertEquals((await moved(`${ANNA}/takeout/part-2`, '/home/anna/part-2')).facts, [[`${ANNA}/takeout/part-2`, 'moved', 'bulk']]);
  assertEquals((await moved(`${ANNA}/takeout/part-2`, `${ANNA}/whatsapp/part-2`)).facts, [[`${ANNA}/takeout/part-2`, 'moved', 'bulk']]);
  assertEquals((await moved(`${ANNA}/takeout/part-2`, `${ANNA}/takeout/part-1`)).facts, []);
  assertEquals((await moved(`${ANNA}/whatsapp/part-2`, '/home/anna/part-2')).facts, [[`${ANNA}/whatsapp/part-2`, 'moved', 'normal']]);
});

Deno.test('staging rules: a file landing that a paired sidecar waits for as a source announces its folder; another does not', async () => {
  const master = `${TAKEOUT_DIR}/07.jxl`;
  const loose = (extra: Record<string, unknown> = {}): NodeSnapshot => ({
    id: 'f7',
    type: 'file',
    attrs: { mimetype: 'application/octet-stream', size: 900, sha256: SHA, ...extra },
  });
  const asked: [string, string][] = [];
  const context = (waiting: string[]): ArchiveRuleContext => ({
    ...ctx,
    getNode: (path) => Promise.resolve({ ...sidecarTree, [master]: loose(), [`${TAKEOUT_DIR}/07.avif/versions/07.jxl`]: loose({ sourceId: 'f1' }) }[path]),
    unpairedSidecarsIn: () => Promise.resolve(false),
    pendingSourceIn: (path, name) => {
      asked.push([path, name]);
      return Promise.resolve(waiting.includes(name));
    },
  });
  assertEquals((await arrivals({ path: master }, {}, [], context(['07.jxl']))).facts, [[TAKEOUT_DIR, 'source', 'bulk']]);
  assertEquals((await arrivals({ path: master }, {}, [], context([]))).facts, []);
  assertEquals(asked, [[TAKEOUT_DIR, '07.jxl'], [TAKEOUT_DIR, '07.jxl']]);
  // Filed as a version, it carries its picture's id and asks nothing.
  assertEquals(
    (await arrivals({ path: `${TAKEOUT_DIR}/07.avif/versions/07.jxl`, type: 'moved', fromPath: master, changedAttrs: undefined }, {}, [], context(['07.jxl']))).facts,
    [],
  );
  assertEquals(asked.length, 2);
});
