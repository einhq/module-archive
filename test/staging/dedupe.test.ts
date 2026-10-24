/**
 * `staging duplicates` and `staging dedupe` over an inbox's stored exact findings: pages list every
 * set once, in class order, whatever the page size and the folder read; a set is answered on the
 * page of its first copy in the folder, so a copy elsewhere never hides it; the cursor holds over
 * copies trashed by hand; counts; a set read whole (kept file, album, thumbnails, what the kept one
 * gains); resolving by key, with a chosen kept file, and in bulk, each call one journal entry and
 * one trash batch, the sets read again when it runs; and `staging undo` puts every copy back, with
 * its finding and its place in its group.
 *
 * The photos are invented: files with a checksum, recorded with `duplicates --record`.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { DuplicateCounts, DuplicateFinding, DuplicatePage, DuplicateResolveResult, DuplicateSet } from '@archive/media/api';
import type { StagingJournalPage, StagingUndoResult } from '@archive/staging/api';
import type { TrashEntry } from '@ein/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { makeGroup, readMembers } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const FILES = '/home/admin/staging/files';
const INBOX = `${FILES}/inbox`;
const SCANS = `${FILES}/scans`;
const BATCH = `${INBOX}/upload-2019-06-14`;
const GROUPS = '/home/admin/staging/albums/inbox';
const LAKE = `${ALBUMS_ROOT}/lake`;

/** An invented checksum per name. */
const hash = (name: string) => name.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'e');

Deno.test({ name: 'staging duplicates and dedupe', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
  const finding = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs.duplicate as DuplicateFinding | undefined;
  /** A media file at `path` with the checksum of `twin`, its id after every file put before it. */
  const put = async (path: string, twin: string, attrs: Record<string, unknown> = {}) => {
    // Ids are ULIDs: a millisecond apart, they sort as the files were made.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const slash = path.lastIndexOf('/');
    await vfs.createTree(ADMIN_ACCESS, path.slice(0, slash), [{
      type: 'file',
      name: path.slice(slash + 1),
      props: { mode: 0o640 },
      attrs: { mimetype: 'image/jpeg', size: 100, sha256: hash(twin), width: 40, height: 30, ...attrs },
    }]);
    return path;
  };
  /** Every page of `staging duplicates <args>` at `limit` sets a page: the keys in order, and the pages read. */
  const allPages = async (args: string, limit: number) => {
    const keys: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: DuplicatePage = await client.execJson<DuplicatePage>(`staging duplicates ${args} --limit ${limit}${cursor ? ` --cursor ${cursor}` : ''}`);
      assert(page.sets.length <= limit);
      keys.push(...page.sets.map((set) => set.key));
      cursor = page.cursor;
      pages++;
    } while (cursor !== null && pages < 200);
    return { keys, pages };
  };
  /** The set keys the copies in `under` name, by class: what paging must list. */
  const expectedKeys = async (under: string) => {
    const rows = await vfs.query(ADMIN_ACCESS, { within: under, types: ['file'], where: [{ ref: { path: ['duplicate', 'kind'] }, op: 'exists' }], limit: 1_000 });
    const keys = { library: new Set<string>(), inbox: new Set<string>() };
    for (const row of rows) {
      const found = row.node.attrs.duplicate as DuplicateFinding;
      keys[found.where!].add(`exact:${found.of}`);
    }
    return { library: [...keys.library].sort(), inbox: [...keys.inbox].sort() };
  };
  const setOf = async (key: string, scope = INBOX) => {
    const { keys } = await allPages(scope, 50);
    assert(keys.includes(key), `${key} is listed`);
    const page = await client.execJson<DuplicatePage>(`staging duplicates ${scope} --limit 200`);
    return page.sets.find((set) => set.key === key) as DuplicateSet;
  };

  try {
    await cmd.shouldSucceed('staging init');
    await cmd.shouldSucceed('staging category scans --create --kind scans');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && mknode -t album ${LAKE} --as name='Lake trip' && mkdir -p ${LAKE}/files ${BATCH}`);

    // Library photos first, so their ids are the smallest; then the staged files, each set's
    // original before its copies.
    const lib1 = await put(`${LAKE}/files/lake-1.jpg`, 'a1');
    const lib2 = await put(`${LAKE}/files/lake-2.jpg`, 'a2');
    await vfs.create(ADMIN_ACCESS, 'directory', lib1, 'thumbnails');
    const pierScan = await put(`${SCANS}/pier-original.jpg`, 'd');
    const a1 = await put(`${BATCH}/lake-1 copy.jpg`, 'a1', { description: 'Lake at dawn' });
    const a2 = await put(`${BATCH}/lake-1 (2).jpg`, 'a1');
    const b1 = await put(`${BATCH}/lake-2.jpg`, 'a2');
    const b2 = await put(`${SCANS}/lake-2.jpg`, 'a2');
    const c0 = await put(`${BATCH}/boat.jpg`, 'c', { labels: ['boat'] });
    const c1 = await put(`${BATCH}/boat (2).jpg`, 'c');
    const c2 = await put(`${BATCH}/boat (3).jpg`, 'c', { labels: ['sailing'] });
    const d1 = await put(`${BATCH}/pier.jpg`, 'd');
    const singles: string[][] = [];
    for (let i = 0; i < 8; i++) singles.push([await put(`${BATCH}/shore-${i}.jpg`, `f${i}`), await put(`${BATCH}/shore-${i} copy.jpg`, `f${i}`)]);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    await makeGroup(vfs, `${GROUPS}/2019-06-14`, 'Lake weekend', [a1, c0, singles[0][0]], { uid: home.props.uid, gid: home.props.gid });
    await cmd.shouldSucceed(`duplicates --record ${FILES}`);

    const key1 = `exact:${await idOf(lib1)}`;
    const key2 = `exact:${await idOf(lib2)}`;
    const keyC = `exact:${await idOf(c0)}`;
    const keyD = `exact:${await idOf(pierScan)}`;

    await t.step('the findings recorded are the fixture as planned', async () => {
      assertEquals((await finding(a1))?.of, await idOf(lib1));
      assertEquals([(await finding(c1))?.of, (await finding(c2))?.of, (await finding(c0))?.kind], [await idOf(c0), await idOf(c0), undefined]);
      assertEquals([(await finding(d1))?.where, (await finding(d1))?.of], ['inbox', await idOf(pierScan)]);
    });

    await t.step('counts: the copies of the scope by where their originals lie', async () => {
      assertEquals(await client.execJson<DuplicateCounts>('staging duplicates --counts'), {
        scope: FILES,
        exact: { library: 4, inbox: 11 },
        near: { library: 0, inbox: 0 },
        total: 15,
      });
      assertEquals(await client.execJson<DuplicateCounts>('staging duplicates inbox --counts'), {
        scope: INBOX,
        exact: { library: 3, inbox: 11 },
        near: { library: 0, inbox: 0 },
        total: 14,
      });
      assertEquals(await client.execJson<DuplicateCounts>('staging duplicates scans --counts'), {
        scope: SCANS,
        exact: { library: 1, inbox: 0 },
        near: { library: 0, inbox: 0 },
        total: 1,
      });
    });

    await t.step('pages list every set once, library copies first, at any page size and in any folder', async () => {
      for (const [scope, under] of [['', FILES], ['inbox', INBOX], ['scans', SCANS], [BATCH, BATCH]]) {
        const expected = await expectedKeys(under);
        for (const limit of [1, 2, 50]) {
          const { keys } = await allPages(scope, limit);
          assertEquals(new Set(keys).size, keys.length, `${scope} at ${limit}: each set once`);
          assertEquals(keys.slice(0, expected.library.length).sort(), expected.library, `${scope} at ${limit}: library sets first`);
          assertEquals(keys.slice(expected.library.length).sort(), expected.inbox, `${scope} at ${limit}`);
        }
      }
      // One class alone.
      assertEquals((await allPages('inbox --where library', 1)).keys.sort(), [key1, key2].sort());
    });

    await t.step('a set is anchored in the folder read: a copy elsewhere hides none', async () => {
      // The pier's original is in scans and its copy in the inbox; the second lake photo has a copy in each.
      assert((await allPages('inbox', 1)).keys.includes(keyD));
      assertEquals((await allPages('scans', 1)).keys, [key2]);
      const lake2 = await setOf(key2);
      assertEquals([lake2.discard, lake2.flags], [[await idOf(b1)], ['outside-scope']]);
      assertEquals(lake2.staged.map((member) => [member.path, member.inScope]), [[b1, true], [b2, false]]);
    });

    await t.step('a set read whole: the kept file, its album and thumbnails, and what it would gain', async () => {
      const lake1 = await setOf(key1);
      assertEquals([lake1.kind, lake1.where, lake1.keep, lake1.discard.sort()], ['exact', 'library', await idOf(lib1), [await idOf(a1), await idOf(a2)].sort()]);
      assertEquals(lake1.existing.map((member) => [member.path, member.album, member.thumbnails]), [[lib1, { path: LAKE, name: 'Lake trip' }, true]]);
      // A copy without renditions of its own shows its twin's.
      assertEquals(lake1.staged.map((member) => [member.previewPath, member.thumbnails]), [[lib1, true], [lib1, true]]);
      assertEquals(lake1.carries, ['description']);
      assertEquals(lake1.staged.find((member) => member.path === a1)?.carries, ['description']);
      assertEquals(lake1.reasons.map((reason) => reason.rule), ['library', 'library']);
      assertEquals([lake1.bulk, lake1.blocked, lake1.reclaimableBytes], [true, undefined, 200]);

      const boat = await setOf(keyC);
      assertEquals([boat.where, boat.keep, boat.staged[0].path, boat.carries, boat.reasons[0].rule], ['inbox', await idOf(c0), c0, ['labels'], 'earliest']);
    });

    await t.step('the cursor holds when copies are put in the trash by hand', async () => {
      const before = await allPages('inbox --where inbox', 1);
      // Five copies straight to the trash, findings and all: their rows are no longer readable.
      await cmd.shouldSucceed(`trash put ${singles.slice(2, 7).map(([, copy]) => `'${copy}'`).join(' ')}`);
      const trashed = new Set(await Promise.all(singles.slice(2, 7).map(async ([original]) => `exact:${await idOf(original)}`)));
      const after = await allPages('inbox --where inbox', 1);
      assertEquals(after.keys, before.keys.filter((key) => !trashed.has(key)));
      assertEquals(after.keys.length, before.keys.length - 5);
      await cmd.shouldSucceed('staging duplicates --repair');
      assertEquals((await client.execJson<DuplicateCounts>('staging duplicates inbox --counts')).exact.inbox, 6);
    });

    await t.step('a set resolved by key: the kept file gains, the copies go as one entry and one batch, and undo puts them back', async () => {
      const [a1Id, a2Id] = [await idOf(a1), await idOf(a2)];
      const dry = await client.execJson<DuplicateResolveResult>(`staging dedupe inbox ${key1} --dry-run`);
      assertEquals([dry.dryRun, dry.resolved, dry.discarded, dry.journal, dry.merged], [true, 1, 2, null, [{ keep: lib1, fields: ['description'] }]]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, a1), true);

      const result = await client.execJson<DuplicateResolveResult>(`staging dedupe inbox ${key1}`);
      assertEquals([result.resolved, result.discarded, result.skipped, result.merged], [1, 2, [], [{ keep: lib1, fields: ['description'] }]]);
      assert(result.journal && result.batch);
      assertEquals([await vfs.exists(ADMIN_ACCESS, a1), await vfs.exists(ADMIN_ACCESS, a2)], [false, false]);
      assertEquals((await vfs.get(ADMIN_ACCESS, lib1)).attrs.description, 'Lake at dawn');
      assertEquals((await readMembers(vfs, `${GROUPS}/2019-06-14`)).includes(a1), false);
      const trash = await client.execJson<TrashEntry[]>('trash list');
      assertEquals(trash.find((row) => row.id === result.batch)?.count, 2);
      const journal = await client.execJson<StagingJournalPage>('staging journal inbox --action dedupe');
      assertEquals(journal.entries.map((entry) => [entry.id, entry.files, entry.state]), [[result.journal, 2, 'done']]);
      assert(!(await allPages('inbox', 50)).keys.includes(key1));
      assertEquals((await client.execJson<DuplicateCounts>('staging duplicates inbox --counts')).exact.library, 1);

      const undone = await client.execJson<StagingUndoResult>(`staging undo ${result.journal}`);
      assertEquals([undone.undone, undone.restoredFiles, undone.failed], [[result.journal], 2, []]);
      assertEquals([await idOf(a1), await idOf(a2)], [a1Id, a2Id]);
      assertEquals([(await finding(a1))?.of, (await finding(a2))?.where], [await idOf(lib1), 'library']);
      assert((await readMembers(vfs, `${GROUPS}/2019-06-14`)).includes(a1));
      assert((await allPages('inbox', 50)).keys.includes(key1));
      // What the kept file gained stays: nothing was overwritten to gain it.
      assertEquals((await vfs.get(ADMIN_ACCESS, lib1)).attrs.description, 'Lake at dawn');
    });

    await t.step('a staged file of a set within the inbox can be kept instead of its original', async () => {
      const result = await client.execJson<DuplicateResolveResult>(`staging dedupe inbox ${keyC} --keep ${await idOf(c2)}`);
      assertEquals([result.resolved, result.discarded, result.merged], [1, 2, [{ keep: c2, fields: ['labels'] }]]);
      assertEquals([await vfs.exists(ADMIN_ACCESS, c0), await vfs.exists(ADMIN_ACCESS, c1)], [false, false]);
      assertEquals((await vfs.get(ADMIN_ACCESS, c2)).attrs.labels, ['sailing', 'boat']);
      // The one kept is the original now.
      assertEquals((await finding(c2))?.kind, undefined);
      // It took the original's place in its group.
      assert((await readMembers(vfs, `${GROUPS}/2019-06-14`)).includes(c2));
    });

    await t.step('bulk resolves in bounded calls, each one entry and one batch, reading each set again, and undoes', async () => {
      // A kept file that is other bytes now is left alone.
      const changed = singles[7][0];
      await vfs.update(ADMIN_ACCESS, changed, { attrs: { sha256: hash('zz') } });
      const before = await client.execJson<DuplicateCounts>('staging duplicates inbox --counts');
      const dry = await client.execJson<DuplicateResolveResult>('staging dedupe inbox --apply --dry-run');
      assertEquals([dry.journal, dry.more], [null, false]);
      assertEquals(await client.execJson<DuplicateCounts>('staging duplicates inbox --counts'), before);

      const journals: string[] = [];
      const batches: string[] = [];
      let cursor: string | null = null;
      let discarded = 0;
      let skipped: DuplicateResolveResult['skipped'] = [];
      let calls = 0;
      for (;;) {
        const answer: DuplicateResolveResult = await client.execJson<DuplicateResolveResult>(`staging dedupe inbox --apply --limit 2${cursor ? ` --cursor ${cursor}` : ''}`);
        calls++;
        assert(answer.discarded <= 2);
        if (answer.journal) journals.push(answer.journal);
        if (answer.batch) batches.push(answer.batch);
        discarded += answer.discarded;
        skipped = [...skipped, ...answer.skipped];
        if (!answer.more) {
          assertEquals(answer.remaining, 1);
          break;
        }
        cursor = answer.cursor;
      }
      assertEquals(discarded, before.total - 1);
      assertEquals(skipped, [{ key: `exact:${await idOf(changed)}`, reason: 'keep-gone' }]);
      assert(calls >= 3);
      assertEquals([journals.length, new Set(batches).size], [batches.length, batches.length]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, singles[7][1]), true);

      const undone = await client.execJson<StagingUndoResult>(`staging undo ${journals.join(' ')}`);
      assertEquals([undone.undone.length, undone.restoredFiles, undone.failed], [journals.length, discarded, []]);
      assertEquals(await client.execJson<DuplicateCounts>('staging duplicates inbox --counts'), before);
    });

    await t.step('resolving is the inbox owner’s, in one category', async () => {
      await cmd.shouldSucceed('user-create anna --uid 3500');
      await cmd.shouldSucceed('staging init --user anna');
      const other = await client.exec('staging dedupe --user anna inbox --apply');
      assertEquals(other.success, false);
      assert(other.error?.includes('your own trash'), other.error);
      const whole = await client.exec(`staging dedupe ${FILES} --apply`);
      assertEquals(whole.success, false);
      assert(whole.error?.includes('one category'), whole.error);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
