/**
 * The organizer's fact, `staging.category.changed`, as the bridge derives it: one for each
 * category a staged file was created, deleted, moved or retimed in, or got a GPS fix in, or a
 * folder moved into, out of or within; none for an update grouping does not read, nor for any
 * write under `albums/` (the groups, their links, the organizer's checkpoint) but a category's
 * request, which names its own category and home. The fact names the category's directory and is
 * in no lane, a bulk category's either. The paths and names are invented.
 */
import { type ArchiveRuleContext, deriveArchiveEvents, type VfsEventInput } from '@archive/event-rules';
import type { NodeSnapshot } from '@archive/media/event-rules';
import { STAGING_EVENTS } from '@archive/staging/facts';
import { assertEquals } from '@std/assert';

const ANNA = '/home/anna/staging';
const INBOX = `${ANNA}/files/inbox`;
const SCANS = `${ANNA}/files/scans`;
const BO = '/home/bo/staging';
const BO_INBOX = `${BO}/files/inbox`;

/** A category directory as the bridge reads it. */
const category = (id: string, lane?: string): NodeSnapshot => ({
  id,
  type: 'directory',
  attrs: { stagingCategory: { kind: 'generic', label: id, ...(lane ? { lane } : {}) } },
});

const tree: Record<string, NodeSnapshot> = {
  [INBOX]: category('c-inbox'),
  [SCANS]: category('c-scans', 'bulk'),
  [BO_INBOX]: category('c-bo'),
};

/** The rule context over `tree`, counting each read of a category. */
const context = () => {
  const reads: string[] = [];
  const ctx: ArchiveRuleContext = {
    getNode: (path) => {
      reads.push(path);
      return Promise.resolve(tree[path]);
    },
    exists: (path) => Promise.resolve(path in tree),
    getLink: () => Promise.resolve(undefined),
    hasPoint: () => Promise.resolve(false),
  };
  return { ctx, reads };
};

const event = (type: string, path: string, extra: Partial<VfsEventInput> = {}): VfsEventInput => ({ type, path, nodeId: 'n1', nodeType: 'file', timestamp: 1, ...extra });

/** The organizer's facts among those an event gives: subject, node, cause and lane. */
const organizerFacts = async (input: VfsEventInput, ctx = context().ctx) =>
  (await deriveArchiveEvents(input, ctx, 1)).filter((fact) => fact.type === STAGING_EVENTS.categoryChanged).map((
    fact,
  ) => [fact.subject, fact.nodeId, fact.data?.cause, fact.lane ?? 'normal']);

Deno.test('a staged file created, deleted or moved makes its category’s fact, both categories’ for a move between them', async () => {
  const file = `${INBOX}/upload-2026-10-01/IMG_0001.jpg`;
  assertEquals(await organizerFacts(event('created', file)), [[INBOX, 'c-inbox', 'created', 'normal']]);
  assertEquals(await organizerFacts(event('deleted', file)), [[INBOX, 'c-inbox', 'deleted', 'normal']]);
  assertEquals(await organizerFacts(event('moved', `${INBOX}/sorted/IMG_0001.jpg`, { fromPath: file })), [[INBOX, 'c-inbox', 'moved', 'normal']]);
  assertEquals(await organizerFacts(event('moved', `${SCANS}/box/IMG_0001.jpg`, { fromPath: file })), [[SCANS, 'c-scans', 'moved', 'normal'], [
    INBOX,
    'c-inbox',
    'moved',
    'normal',
  ]]);
  // Out of staging, into the library: the category it left.
  assertEquals(await organizerFacts(event('moved', '/archive/albums/a-sailboat/IMG_0001.jpg', { fromPath: file })), [[INBOX, 'c-inbox', 'moved', 'normal']]);
});

Deno.test('an update makes the fact when grouping reads what it changed, and a GPS fix or a folder moved in does', async () => {
  const file = `${INBOX}/upload-2026-10-01/IMG_0002.jpg`;
  for (const attr of ['takenAtUtc', 'indexedAt', 'facesAt', 'devicePath']) {
    assertEquals(await organizerFacts(event('updated', file, { changedAttrs: [attr] })), [[INBOX, 'c-inbox', 'updated', 'normal']], attr);
  }
  assertEquals(await organizerFacts(event('updated', file, { changedAttrs: ['sha256', 'textIndexedAt', 'duplicate'] })), []);
  assertEquals(await organizerFacts(event('created', `${file}/position`, { nodeType: 'position' })), [[INBOX, 'c-inbox', 'created', 'normal']]);
  assertEquals(await organizerFacts(event('moved', `${INBOX}/trip`, { nodeType: 'directory', fromPath: '/home/anna/Documents/trip' })), [[
    INBOX,
    'c-inbox',
    'moved',
    'normal',
  ]]);
  // A file outside every category makes none.
  assertEquals(await organizerFacts(event('created', '/home/anna/Documents/notes.txt')), []);
});

Deno.test('nothing under albums/ makes the fact but a request: not a group, its links, nor the checkpoint write', async () => {
  const groups = `${ANNA}/albums/inbox`;
  assertEquals(await organizerFacts(event('created', `${groups}/2019-06-14`, { nodeType: 'album' })), []);
  assertEquals(await organizerFacts(event('created', `${groups}/2019-06-14/IMG_0001.jpg`, { nodeType: 'softlink' })), []);
  assertEquals(await organizerFacts(event('created', `${groups}/.organizer`)), []);
  assertEquals(await organizerFacts(event('updated', `${groups}/.organizer`, { changedAttrs: ['stagingOrganizer', 'size'] })), []);
  // The request: a run of the category it lies with, in the home it lies in.
  assertEquals(await organizerFacts(event('created', `${groups}/.request`)), [[INBOX, 'c-inbox', 'request', 'normal']]);
  assertEquals(await organizerFacts(event('updated', `${groups}/.request`, { changedAttrs: ['stagingRequest'] })), [[INBOX, 'c-inbox', 'request', 'normal']]);
  assertEquals(await organizerFacts(event('updated', `${BO}/albums/inbox/.request`, { changedAttrs: ['stagingRequest'] })), [[BO_INBOX, 'c-bo', 'request', 'normal']]);
  // Anywhere else it is no request; nor for a category that is not there.
  assertEquals(await organizerFacts(event('created', `${groups}/2019-06-14/.request`)), []);
  assertEquals(await organizerFacts(event('created', `${ANNA}/albums/.request`)), []);
  assertEquals(await organizerFacts(event('created', `${ANNA}/albums/gone/.request`)), []);
});

Deno.test('a category’s id is read once a minute', async () => {
  const { ctx, reads } = context();
  for (let i = 0; i < 3; i++) await deriveArchiveEvents(event('created', `${INBOX}/upload-2026-10-01/IMG_000${i}.jpg`), ctx, 1);
  assertEquals(reads.filter((path) => path === INBOX).length, 1);
});
