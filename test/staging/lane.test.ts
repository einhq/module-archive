/**
 * Lanes: a category's `lane` setting, its kinds' presets and `staging category --lane`; and the
 * bridge's stamping, which puts every fact about a file of a bulk category in the bulk lane and
 * leaves every other fact in the normal one, decided per fact by the category its subject is in now.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { StagingCategoryAnswer } from '@archive/staging/api';
import { CATEGORY_KINDS, parseCategorySettings, presetSettings } from '@archive/staging/category';
import { type ArchiveRuleContext, deriveArchiveEvents, type VfsEventInput } from '@archive/event-rules';
import { MEDIA_EVENTS, type NodeSnapshot } from '@archive/media/event-rules';
import { STAGING_EVENTS } from '@archive/staging/facts';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

Deno.test('a Takeout and a box of scans start in the bulk lane, every other kind in the normal one', () => {
  const bulk = CATEGORY_KINDS.filter((kind) => presetSettings(kind, kind).lane === 'bulk');
  assertEquals(bulk.sort(), ['google-photos', 'scans']);
});

Deno.test("a stored lane is kept; a missing or unknown one is the kind's", () => {
  assertEquals(parseCategorySettings({ kind: 'camera', lane: 'bulk' }, 'camera').lane, 'bulk');
  assertEquals(parseCategorySettings({ kind: 'scans', lane: 'normal' }, 'box-3').lane, 'normal');
  assertEquals(parseCategorySettings({ kind: 'scans' }, 'box-3').lane, 'bulk');
  assertEquals(parseCategorySettings({ kind: 'scans', lane: 'fast' }, 'box-3').lane, 'bulk');
  assertEquals(parseCategorySettings({ kind: 'phone', lane: 'bulk ' }, 'phone').lane, 'normal');
});

const FILES = '/home/anna/staging/files';
const TAKEOUT = `${FILES}/takeout`;
const INBOX = `${FILES}/inbox`;
const SHA = 'e'.repeat(64);

/** A category directory as the bridge reads it, with the lane and time rules given. */
const category = (id: string, lane: string | undefined, time: { digitized: boolean; filenameDates: boolean }): NodeSnapshot => ({
  id,
  type: 'directory',
  attrs: { stagingCategory: { kind: 'generic', label: id, ...(lane ? { lane } : {}), time } },
});

/** A photo with a checksum and no metadata yet: what the bridge announces as discovered. */
const photo = (id: string, attrs: Record<string, unknown> = {}): NodeSnapshot => ({ id, type: 'file', attrs: { mimetype: 'image/jpeg', size: 10, sha256: SHA, ...attrs } });

/** Anna's `takeout` (bulk, own clocks) and `inbox` (normal, names are dates), and the folders in them. */
const tree: Record<string, NodeSnapshot> = {
  [TAKEOUT]: category('c-takeout', 'bulk', { digitized: false, filenameDates: false }),
  [INBOX]: category('c-inbox', undefined, { digitized: false, filenameDates: true }),
  [`${TAKEOUT}/part-1`]: { id: 'd-takeout', type: 'directory', attrs: {} },
  [`${INBOX}/upload-2026-10-01`]: { id: 'd-inbox', type: 'directory', attrs: {} },
};

/** The rule context over `tree` and `nodes`, counting each read of a category. */
const context = (nodes: Record<string, NodeSnapshot>) => {
  const categoryReads: string[] = [];
  const ctx: ArchiveRuleContext = {
    getNode: (path) => {
      if (path === TAKEOUT || path === INBOX) categoryReads.push(path);
      return Promise.resolve({ ...tree, ...nodes }[path]);
    },
    exists: (path) => Promise.resolve(path in tree || path in nodes),
    getLink: () => Promise.resolve(undefined),
    hasPoint: () => Promise.resolve(false),
  };
  return { ctx, categoryReads };
};

const updated = (path: string, id: string): VfsEventInput => ({ type: 'updated', path, nodeId: id, nodeType: 'file', timestamp: 1, changedAttrs: ['sha256'] });

/** Each fact's type, subject and lane. */
const lanes = (facts: { type: string; subject: string; lane?: string }[]) => facts.map((fact) => [fact.type, fact.subject, fact.lane ?? 'normal']);

Deno.test('a fact about a file of a bulk category is in the bulk lane, one about a file of another category is not', async () => {
  const bulkFile = `${TAKEOUT}/part-1/IMG_0001.jpg`;
  const inboxFile = `${INBOX}/upload-2026-10-01/IMG_0002.jpg`;
  const { ctx } = context({ [bulkFile]: photo('f1'), [inboxFile]: photo('f2') });

  assertEquals(lanes(await deriveArchiveEvents(updated(bulkFile, 'f1'), ctx, 1)), [[MEDIA_EVENTS.fileDiscovered, bulkFile, 'bulk']]);
  assertEquals(lanes(await deriveArchiveEvents(updated(inboxFile, 'f2'), ctx, 1)), [[MEDIA_EVENTS.fileDiscovered, inboxFile, 'normal']]);
});

Deno.test('a fact outside every category reads no category and stays in the normal lane', async () => {
  const library = `${ALBUMS_ROOT}/lake/files/IMG_0003.jpg`;
  const { ctx, categoryReads } = context({ [library]: photo('f3') });
  assertEquals(lanes(await deriveArchiveEvents(updated(library, 'f3'), ctx, 1)), [[MEDIA_EVENTS.fileDiscovered, library, 'normal']]);
  assertEquals(categoryReads, []);
});

Deno.test("a category's lane is read once a minute, so a change reaches the bridge within one", async () => {
  const file = `${TAKEOUT}/part-1/IMG_0004.jpg`;
  const { ctx, categoryReads } = context({ [file]: photo('f4') });
  await deriveArchiveEvents(updated(file, 'f4'), ctx, 1_000);
  await deriveArchiveEvents(updated(file, 'f4'), ctx, 30_000);
  assertEquals(categoryReads, [TAKEOUT]);

  tree[TAKEOUT] = category('c-takeout', 'normal', { digitized: false, filenameDates: false });
  try {
    assertEquals(lanes(await deriveArchiveEvents(updated(file, 'f4'), ctx, 59_000)), [[MEDIA_EVENTS.fileDiscovered, file, 'bulk']]);
    assertEquals(lanes(await deriveArchiveEvents(updated(file, 'f4'), ctx, 61_001)), [[MEDIA_EVENTS.fileDiscovered, file, 'normal']]);
    assertEquals(categoryReads, [TAKEOUT, TAKEOUT]);
  } finally {
    tree[TAKEOUT] = category('c-takeout', 'bulk', { digitized: false, filenameDates: false });
  }
});

Deno.test('a file moved between lanes has its facts in the lane of the category it is in now', async () => {
  const name = 'IMG_20190601_123456.jpg';
  const inInbox = `${INBOX}/upload-2026-10-01/${name}`;
  const inTakeout = `${TAKEOUT}/part-1/${name}`;
  const moved = (path: string, fromPath: string): VfsEventInput => ({ type: 'moved', path, fromPath, nodeId: 'f5', nodeType: 'file', timestamp: 1 });

  // Out of the bulk lane: the inbox dates by names, so the file's folder is dated again, in the normal lane.
  const out = context({ [inInbox]: photo('f5') });
  const outFacts = (await deriveArchiveEvents(moved(inInbox, inTakeout), out.ctx, 1)).filter((fact) => fact.type === STAGING_EVENTS.retimeRequested);
  assertEquals(lanes(outFacts), [[STAGING_EVENTS.retimeRequested, `${INBOX}/upload-2026-10-01`, 'normal']]);

  // Into it: a file dated by its name is dated again by the camera's clocks, in the bulk lane, and so is what it announces next.
  const into = context({ [inTakeout]: photo('f5', { whenName: '2019-06-01T12:34:56' }) });
  const intoFacts = (await deriveArchiveEvents(moved(inTakeout, inInbox), into.ctx, 1)).filter((fact) => fact.type === STAGING_EVENTS.retimeRequested);
  assertEquals(lanes(intoFacts), [[STAGING_EVENTS.retimeRequested, `${TAKEOUT}/part-1`, 'bulk']]);
  assertEquals(lanes(await deriveArchiveEvents(updated(inTakeout, 'f5'), into.ctx, 1)), [[MEDIA_EVENTS.fileDiscovered, inTakeout, 'bulk']]);
});

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'staging category --lane', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('staging init --user admin');

    await t.step("a new category takes its kind's lane, or the one asked for", async () => {
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category takeout --create --kind google-photos')).category?.settings.lane, 'bulk');
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category phone --create --kind phone --lane bulk')).category?.settings.lane, 'bulk');
      assertEquals((await client.execJson<StagingCategoryAnswer>('staging category inbox')).category?.settings.lane, 'normal');
    });

    await t.step('the lane changes, is named among what changed, and an unknown one is refused', async () => {
      let answer = await client.execJson<StagingCategoryAnswer>('staging category takeout --lane normal');
      assertEquals([answer.changed, answer.category?.settings.lane, answer.retime], [['lane'], 'normal', null]);
      answer = await client.execJson<StagingCategoryAnswer>('staging category takeout --lane normal');
      assertEquals(answer.changed, []);
      await cmd.shouldFailWith('staging category takeout --lane fast', "unknown lane 'fast'");
    });

    await t.step('the text answer says a category is in the bulk lane', async () => {
      assertStringIncludes(await client.execString('staging category phone', { json: false }), 'phone: Phone (phone), bulk lane; 0 media');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
