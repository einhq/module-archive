/**
 * Lanes in the archive's bridge: a folder that says it is of the bulk lane (`lane`) puts every fact
 * about a file in it in the bulk lane (`withLanes`) and leaves every other fact in the normal one,
 * decided per fact by the folder its subject is in now.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import { type ArchiveRuleContext, deriveArchiveEvents, type VfsEventInput } from '@archive/event-rules';
import { MEDIA_EVENTS, type NodeSnapshot } from '@archive/media/event-rules';
import { assertEquals } from '@std/assert';

const FILES = '/home/anna/staging/files';
const TAKEOUT = `${FILES}/takeout`;
const INBOX = `${FILES}/inbox`;
const SHA = 'e'.repeat(64);

/** A category directory as the bridge reads it, its folder in the bulk lane or not. */
const category = (id: string, bulk: boolean): NodeSnapshot => ({ id, type: 'directory', attrs: { stagingCategory: { label: id }, ...(bulk ? { lane: 'bulk' } : {}) } });

/** A photo whose metadata is read and interpreted: what the bridge announces as `media.metadata.interpreted`. */
const photo = (id: string, attrs: Record<string, unknown> = {}): NodeSnapshot => ({
  id,
  type: 'file',
  attrs: { mimetype: 'image/jpeg', size: 10, sha256: SHA, interpretedAt: 'now', ...attrs },
});

/** The nodes of read photos: each and its metadata. */
const read = (photos: Record<string, NodeSnapshot>): Record<string, NodeSnapshot> =>
  Object.fromEntries(
    Object.entries(photos).flatMap((
      [path, node],
    ) => [[path, node], [`${path}/metadata/exif`, { id: `e-${node.id}`, type: 'exif', attrs: { indexedAt: 'now', sourceSha256: SHA } }]]),
  );

/** Anna's `takeout` (bulk) and `inbox` (normal), and the folders in them. */
const tree: Record<string, NodeSnapshot> = {
  [TAKEOUT]: category('c-takeout', true),
  [INBOX]: category('c-inbox', false),
  [`${TAKEOUT}/part-1`]: { id: 'd-takeout', type: 'directory', attrs: {} },
  [`${INBOX}/upload-2026-10-01`]: { id: 'd-inbox', type: 'directory', attrs: {} },
};

/** The rule context over `tree` and `nodes`, counting each read of a category. */
const context = (nodes: Record<string, NodeSnapshot>) => {
  const categoryReads: string[] = [];
  const ctx: ArchiveRuleContext = {
    getNode: (path) => {
      if (path === TAKEOUT || path === INBOX) categoryReads.push(path);
      return Promise.resolve({ ...tree, ...read(nodes) }[path]);
    },
    exists: (path) => Promise.resolve(path in tree || path in read(nodes)),
    getLink: () => Promise.resolve(undefined),
    hasPoint: () => Promise.resolve(false),
    tracksOf: () => Promise.resolve([]),
  };
  return { ctx, categoryReads };
};

const updated = (path: string, id: string): VfsEventInput => ({ type: 'updated', path, nodeId: id, nodeType: 'file', timestamp: 1, changedAttrs: ['interpretedAt'] });

/** Each fact's type, subject and lane. */
const lanes = (facts: { type: string; subject: string; lane?: string }[]) => facts.map((fact) => [fact.type, fact.subject, fact.lane ?? 'normal']);

Deno.test('a fact about a file in a bulk folder is in the bulk lane, one about a file elsewhere is not', async () => {
  const bulkFile = `${TAKEOUT}/part-1/IMG_0001.jpg`;
  const inboxFile = `${INBOX}/upload-2026-10-01/IMG_0002.jpg`;
  const { ctx } = context({ [bulkFile]: photo('f1'), [inboxFile]: photo('f2') });

  assertEquals(lanes(await deriveArchiveEvents(updated(bulkFile, 'f1'), ctx, 1)), [[MEDIA_EVENTS.metadataInterpreted, bulkFile, 'bulk']]);
  assertEquals(lanes(await deriveArchiveEvents(updated(inboxFile, 'f2'), ctx, 1)), [[MEDIA_EVENTS.metadataInterpreted, inboxFile, 'normal']]);
});

Deno.test('a fact outside every category reads no category and stays in the normal lane', async () => {
  const library = `${ALBUMS_ROOT}/lake/files/IMG_0003.jpg`;
  const { ctx, categoryReads } = context({ [library]: photo('f3') });
  assertEquals(lanes(await deriveArchiveEvents(updated(library, 'f3'), ctx, 1)), [[MEDIA_EVENTS.metadataInterpreted, library, 'normal']]);
  assertEquals(categoryReads, []);
});

Deno.test("a folder's lane is read once a minute, so a change reaches the bridge within one", async () => {
  const file = `${TAKEOUT}/part-1/IMG_0004.jpg`;
  const { ctx, categoryReads } = context({ [file]: photo('f4') });
  await deriveArchiveEvents(updated(file, 'f4'), ctx, 1_000);
  await deriveArchiveEvents(updated(file, 'f4'), ctx, 30_000);
  assertEquals(categoryReads, [TAKEOUT]);

  tree[TAKEOUT] = category('c-takeout', false);
  try {
    assertEquals(lanes(await deriveArchiveEvents(updated(file, 'f4'), ctx, 59_000)), [[MEDIA_EVENTS.metadataInterpreted, file, 'bulk']]);
    assertEquals(lanes(await deriveArchiveEvents(updated(file, 'f4'), ctx, 61_001)), [[MEDIA_EVENTS.metadataInterpreted, file, 'normal']]);
    assertEquals(categoryReads, [TAKEOUT, TAKEOUT]);
  } finally {
    tree[TAKEOUT] = category('c-takeout', true);
  }
});

Deno.test('a file moved between lanes has its facts in the lane of the folder it is in now', async () => {
  const name = 'IMG_0005.jpg';
  const inInbox = `${INBOX}/upload-2026-10-01/${name}`;
  const inTakeout = `${TAKEOUT}/part-1/${name}`;
  assertEquals(lanes(await deriveArchiveEvents(updated(inInbox, 'f5'), context({ [inInbox]: photo('f5') }).ctx, 1)), [[MEDIA_EVENTS.metadataInterpreted, inInbox, 'normal']]);
  assertEquals(lanes(await deriveArchiveEvents(updated(inTakeout, 'f5'), context({ [inTakeout]: photo('f5') }).ctx, 1)), [[
    MEDIA_EVENTS.metadataInterpreted,
    inTakeout,
    'bulk',
  ]]);
});
