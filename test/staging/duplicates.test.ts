/**
 * Exact duplicate findings on staged media (`@archive/staging/duplicates`): what `exif-extract`
 * records when a file arrives, and that an exact copy is deferred, not indexed, until it stops
 * being one; what staging's filing and discard keep true, what the bridge announces when files
 * cross an inbox's edge, `duplicates --record` and `--checksum`, and `staging duplicates --refresh`
 * and `--repair`.
 *
 * EMS is a stub answering `media.probe`; the files are invented photos.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import type {
  AlbumAddResult,
  ChecksumMatches,
  DuplicateFinding,
  DuplicatePage,
  DuplicateRefreshResult,
  DuplicateRepairResult,
  DuplicateResolveResult,
  DuplicatesRecorded,
} from '@archive/media/api';
import type { StagingDiscardResult, StagingMoveResult, StagingPromoteResult, StagingStatus } from '@archive/staging/api';
import { type ArchiveRuleContext, deriveArchiveEvents } from '@archive/event-rules';
import { MEDIA_EVENTS } from '@archive/media/event-rules';
import { assert, assertEquals } from '@std/assert';
import type { NodeEvent } from '@ein/client';
import type { SearchResponse } from '@ein/api';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';
import { makeGroup } from './decisions-fixture.ts';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-staged-duplicates-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

const ADMIN_INBOX = '/home/admin/staging/files/inbox';
const ANNA_INBOX = '/home/anna/staging/files/inbox';
const LAKE = `${ALBUMS_ROOT}/lake/files`;
const PRIVATE = `${ALBUMS_ROOT}/private/files`;

/** An invented checksum per letter. */
const hash = (letter: string) => letter.repeat(64);

/** A finding without the time it was computed at, for comparing. */
const timeless = (finding: DuplicateFinding | undefined) => {
  if (!finding) return undefined;
  const { at: _at, ...rest } = finding;
  return rest;
};

Deno.test({ name: 'staged duplicate findings', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const cmd = testCommands(admin);
  const stub = startStubEms({
    ops: {
      'media.probe': () => ({
        result: {
          mimetype: 'image/jpeg',
          kind: 'image',
          size: 1,
          captured_at: [],
          decodable: true,
          raw: { exiftool: { MIMEType: 'image/jpeg', ImageWidth: 40, ImageHeight: 30 } },
        },
        producer: 'exiftool/13',
      }),
    },
  });
  const extract = (path: string, client = admin) => client.exec(`CFG_EMS_URL=${stub.url} exif-extract ${path}`);

  const finding = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs.duplicate as DuplicateFinding | undefined;
  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
  let anna = { uid: 0, gid: 0 };
  /** A media file at `path` with checksum `sha256`, owned by `owner`. */
  const put = async (path: string, sha256: string, owner = { uid: 0, gid: 0 }, mode = 0o640) => {
    const slash = path.lastIndexOf('/');
    const parent = path.slice(0, slash);
    if (!(await vfs.exists(ADMIN_ACCESS, parent))) {
      await cmd.shouldSucceed(`mkdir -p ${parent}`);
      await vfs.update(ADMIN_ACCESS, parent, { props: { uid: owner.uid, gid: owner.gid, mode: 0o700 } });
    }
    await vfs.createTree(ADMIN_ACCESS, parent, [{
      type: 'file',
      name: path.slice(slash + 1),
      props: { uid: owner.uid, gid: owner.gid, mode },
      attrs: { mimetype: 'image/jpeg', size: 100, sha256 },
    }]);
    return path;
  };
  /** Byte twins named `names` in `dir`, recorded: the original (the smallest id) first, then its copies. */
  const twins = async (dir: string, sha256: string, names: string[]): Promise<string[]> => {
    const paths: string[] = [];
    for (const name of names) paths.push(await put(`${dir}/${name}`, sha256));
    await cmd.shouldSucceed(`duplicates --record ${dir}`);
    const ids = new Map(await Promise.all(paths.map(async (path) => [path, await idOf(path)] as const)));
    return paths.toSorted((a, b) => (ids.get(a)! < ids.get(b)! ? -1 : 1));
  };
  const write = async (path: string, bytes: Uint8Array) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  };
  /** The context the bridge reads with, over this VFS. */
  const ruleContext: ArchiveRuleContext = {
    getNode: async (path) => {
      const node = await vfs.get(ADMIN_ACCESS, path).catch(() => undefined);
      return node && { id: node.id, type: node.type, attrs: node.attrs as Record<string, unknown> };
    },
    exists: (path) => vfs.exists(ADMIN_ACCESS, path),
    getLink: () => Promise.resolve(undefined),
    hasPoint: () => Promise.resolve(false),
  };
  /** The `media.duplicates.stale` facts the bridge derives from the moves `act` makes, by subject. */
  const staleFrom = async (act: () => Promise<unknown>): Promise<string[]> => {
    const moved: NodeEvent[] = [];
    const subscription = await vfs.subscribe!(() => ADMIN_ACCESS, (event: NodeEvent) => {
      if (event.type === 'moved') moved.push(event);
    });
    try {
      await act();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await subscription.unsubscribe();
    }
    const subjects: string[] = [];
    for (const event of moved) {
      const input = {
        type: event.type,
        path: event.path,
        nodeId: event.node.id,
        nodeType: event.node.type,
        timestamp: event.timestamp,
        ...(event.fromPath ? { fromPath: event.fromPath } : {}),
      };
      for (const fact of await deriveArchiveEvents(input, ruleContext, 1)) if (fact.type === MEDIA_EVENTS.duplicatesStale) subjects.push(fact.subject);
    }
    return subjects.sort();
  };

  try {
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('user-create anna --uid 3400');
    await cmd.shouldSucceed('user-passwd anna --new-password secret1');
    await cmd.shouldSucceed('mkdir -p /dev && ([ -e /dev/events ] || mknode -t router --as routingKey=system.events /dev/events)');
    await cmd.shouldSucceed('staging init');
    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && mknode -t album ${ALBUMS_ROOT}/lake --as name=Lake && mkdir -p ${LAKE} ${PRIVATE}`);
    await cmd.shouldSucceed(`chmod 755 ${ALBUMS_ROOT} ${ALBUMS_ROOT}/lake ${LAKE} && chmod 700 ${ALBUMS_ROOT}/private`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/anna');
    anna = { uid: home.props.uid, gid: home.props.gid };
    const asAnna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });

    await t.step('two byte twins uploaded: the smaller id is the original, the other its exact copy', async () => {
      const upload = `${ADMIN_INBOX}/upload-2026-10-01`;
      await cmd.shouldSucceed(`mkdir -p ${upload}`);
      const bytes = new TextEncoder().encode('an invented photo of a sailboat');
      const paths = [`${upload}/IMG_0001.jpg`, `${upload}/IMG_0002.jpg`];
      for (const path of paths) {
        await cmd.shouldSucceed(`mknode -t file ${path} --as mimetype=image/jpeg`);
        await write(path, bytes);
      }
      const ids = await Promise.all(paths.map(idOf));
      const [original, copy] = ids[0] < ids[1] ? paths : [paths[1], paths[0]];
      const sha256 = (await vfs.get(ADMIN_ACCESS, original)).attrs.sha256 as string;
      assert(typeof sha256 === 'string' && sha256.length === 64, 'the write path hashes the bytes');

      // The original's marker rides on the update the extraction makes anyway.
      const updates: string[] = [];
      const subscription = await vfs.subscribe!(() => ADMIN_ACCESS, (event: NodeEvent) => {
        if (event.type === 'updated' && event.path === original) updates.push(event.path);
      });
      try {
        assertEquals((await extract(original)).success, true);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        await subscription.unsubscribe();
      }
      assertEquals(updates.length, 1);
      assertEquals(timeless(await finding(original)), { inbox: 'admin', sha256 });

      assertEquals((await extract(copy)).success, true);
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256, kind: 'exact', where: 'inbox', of: await idOf(original), deferred: true });
      assertEquals(timeless(await finding(original)), { inbox: 'admin', sha256 });
    });

    /** The facts the bridge derives from an update of the file at `path`. */
    const factsOfUpdate = async (path: string): Promise<string[]> =>
      (await deriveArchiveEvents({ type: 'updated', path, nodeId: await idOf(path), nodeType: 'file', timestamp: 1, changedAttrs: ['duplicate'] }, ruleContext, 1))
        .map((fact) => fact.type);
    const indexed = async (path: string) => await vfs.exists(ADMIN_ACCESS, `${path}/metadata/exif`);
    /** Two byte twins arrived in `dir` and read, as `[original, copy]`. */
    const arrived = async (dir: string, text: string): Promise<[string, string]> => {
      await cmd.shouldSucceed(`mkdir -p ${dir}`);
      const paths = [`${dir}/IMG_0101.jpg`, `${dir}/IMG_0102.jpg`];
      for (const path of paths) {
        await cmd.shouldSucceed(`mknode -t file ${path} --as mimetype=image/jpeg`);
        await write(path, new TextEncoder().encode(text));
      }
      const ids = await Promise.all(paths.map(idOf));
      const [original, copy] = ids[0] < ids[1] ? paths : [paths[1], paths[0]];
      assertEquals((await extract(original)).success, true);
      assertEquals((await extract(copy)).success, true);
      return [original, copy];
    };

    let deferredPair: [string, string] = ['', ''];
    await t.step('an exact copy is deferred: never probed, not indexed, held back by the bridge', async () => {
      await cmd.shouldSucceed('staging category copies --create');
      const dir = '/home/admin/staging/files/copies/upload';
      const probes = () => stub.requests.filter((request) => request.op === 'media.probe').length;
      const before = probes();
      const [original, copy] = deferredPair = await arrived(dir, 'an invented photo of a rowing boat');
      assertEquals(probes() - before, 1, 'only the original is probed');
      const sha256 = (await vfs.get(ADMIN_ACCESS, copy)).attrs.sha256 as string;
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256, kind: 'exact', where: 'inbox', of: await idOf(original), deferred: true });
      assertEquals([await indexed(original), await indexed(copy)], [true, false]);
      assertEquals((await vfs.get(ADMIN_ACCESS, copy)).attrs.indexedAt, undefined);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${copy}/thumbnails`), false);
      assertEquals(await factsOfUpdate(copy), []);

      // Read again, it stays as it is, and nothing is written.
      const updates: string[] = [];
      const subscription = await vfs.subscribe!(() => ADMIN_ACCESS, (event: NodeEvent) => {
        if (event.type === 'updated' && event.path === copy) updates.push(event.path);
      });
      try {
        const again = await admin.execJson<{ deferred: boolean; of: string }>(`CFG_EMS_URL=${stub.url} exif-extract ${copy}`);
        assertEquals(again, { deferred: true, of: await idOf(original) });
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        await subscription.unsubscribe();
      }
      assertEquals([updates.length, probes() - before], [0, 1]);

      // Not waiting to be indexed, still among the category's files and copies.
      const status = await admin.execJson<StagingStatus>('staging status');
      const counts = status.categories.find((category) => category.name === 'copies')!.counts;
      assertEquals([counts.files, counts.indexing, counts.copies.inbox], [2, 0, 1]);

      // The Files tab's media leave it out; the Duplicates tab shows it with its original's picture.
      const listed = async (args: string) => (await admin.execJson<SearchResponse>(`search --within ${dir} ${args}`)).results.map((hit) => hit.path);
      assertEquals((await listed('')).sort(), [original, copy].sort());
      assertEquals(await listed('--missing duplicate.deferred'), [original]);
      await cmd.shouldSucceed(`mkdir -p ${original}/thumbnails`);
      const page = await admin.execJson<DuplicatePage>('staging duplicates /home/admin/staging/files/copies');
      const shown = page.sets[0].staged.find((member) => member.path === copy)!;
      assertEquals([shown.previewPath, shown.thumbnails, shown.width, shown.height], [original, true, 40, 30]);
    });

    await t.step('discarding the original undefers its copy, which the bridge announces and is then indexed', async () => {
      const [original, copy] = deferredPair;
      const sha256 = (await vfs.get(ADMIN_ACCESS, copy)).attrs.sha256 as string;
      await admin.execJson<StagingDiscardResult>(`staging discard ${original}`);
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256 });
      assertEquals(await factsOfUpdate(copy), [MEDIA_EVENTS.fileDiscovered]);
      assertEquals((await extract(copy)).success, true);
      assertEquals(await indexed(copy), true);
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256 });
    });

    await t.step('a deduped set may keep the deferred copy, which is then undeferred', async () => {
      const [original, copy] = await arrived('/home/admin/staging/files/copies/kept', 'an invented photo of a ferry');
      const result = await admin.execJson<DuplicateResolveResult>(`staging dedupe copies exact:${await idOf(original)} --keep ${await idOf(copy)}`);
      assertEquals([result.resolved, result.discarded], [1, 1]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, original), false);
      const sha256 = (await vfs.get(ADMIN_ACCESS, copy)).attrs.sha256 as string;
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256 });
      assertEquals(await factsOfUpdate(copy), [MEDIA_EVENTS.fileDiscovered]);
    });

    await t.step('a copy whose original is lost is undeferred by the repair; -f indexes a copy anyway', async () => {
      const [original, copy] = await arrived('/home/admin/staging/files/copies/lost', 'an invented photo of a canoe');
      assertEquals((await finding(copy))?.deferred, true);
      await cmd.shouldSucceed(`rm -r ${original}`);
      await admin.execJson<DuplicateRepairResult>('staging duplicates --repair');
      const sha256 = (await vfs.get(ADMIN_ACCESS, copy)).attrs.sha256 as string;
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256 });
      assertEquals(await factsOfUpdate(copy), [MEDIA_EVENTS.fileDiscovered]);

      const [kept, forced] = await arrived('/home/admin/staging/files/copies/forced', 'an invented photo of a kayak');
      assertEquals((await finding(forced))?.deferred, true);
      assertEquals((await admin.exec(`CFG_EMS_URL=${stub.url} exif-extract -f ${forced}`)).success, true);
      assertEquals(await indexed(forced), true);
      assertEquals(timeless(await finding(forced)), {
        inbox: 'admin',
        sha256: (await vfs.get(ADMIN_ACCESS, forced)).attrs.sha256 as string,
        kind: 'exact',
        where: 'inbox',
        of: await idOf(kept),
      });
    });

    await t.step('a smaller twin measured later turns the one checked first into its copy', async () => {
      const dir = `${ADMIN_INBOX}/later`;
      await cmd.shouldSucceed(`mkdir -p ${dir}`);
      const bytes = new TextEncoder().encode('an invented photo of a pier');
      const paths = [`${dir}/a.jpg`, `${dir}/b.jpg`];
      for (const path of paths) {
        await cmd.shouldSucceed(`mknode -t file ${path} --as mimetype=image/jpeg`);
        await write(path, bytes);
      }
      const ids = await Promise.all(paths.map(idOf));
      const [small, large] = ids[0] < ids[1] ? paths : [paths[1], paths[0]];
      // The smaller one's bytes have no checksum yet, as a legacy file's have not.
      await vfs.update(ADMIN_ACCESS, small, { attrs: { sha256: null } });
      const sha256 = (await vfs.get(ADMIN_ACCESS, large)).attrs.sha256 as string;
      await extract(large);
      assertEquals(timeless(await finding(large)), { inbox: 'admin', sha256 });
      await extract(small);
      assertEquals(timeless(await finding(small)), { inbox: 'admin', sha256 });
      assertEquals(timeless(await finding(large)), { inbox: 'admin', sha256, kind: 'exact', where: 'inbox', of: await idOf(small) });
    });

    await t.step('two twins without checksums measured at the same moment see each other', async () => {
      const dir = `${ADMIN_INBOX}/legacy`;
      await cmd.shouldSucceed(`mkdir -p ${dir}`);
      const bytes = new TextEncoder().encode('an invented scan of a lighthouse');
      for (const name of ['x.jpg', 'y.jpg']) {
        await cmd.shouldSucceed(`mknode -t file ${dir}/${name} --as mimetype=image/jpeg`);
        await write(`${dir}/${name}`, bytes);
        await vfs.update(ADMIN_ACCESS, `${dir}/${name}`, { attrs: { sha256: null } });
      }
      const other = await testCtx.server.createShellClient();
      const [x, y] = await Promise.all([extract(`${dir}/x.jpg`), extract(`${dir}/y.jpg`, other)]);
      assertEquals([x.success, y.success], [true, true]);
      const findings = [await finding(`${dir}/x.jpg`), await finding(`${dir}/y.jpg`)];
      assertEquals(findings.filter((each) => each?.kind === undefined).length, 1, JSON.stringify(findings));
      const [smaller] = [await idOf(`${dir}/x.jpg`), await idOf(`${dir}/y.jpg`)].sort();
      assertEquals(findings.find((each) => each?.kind === 'exact')?.of, smaller);
    });

    await t.step('a library twin beats a smaller staged one, and a twin in another inbox is ignored', async () => {
      const staged = await put(`${ADMIN_INBOX}/lib/s.jpg`, hash('2'));
      const elsewhere = await put(`${ANNA_INBOX}/lib/s.jpg`, hash('2'), anna);
      await cmd.shouldSucceed(`duplicates --record ${staged}`);
      assertEquals(timeless(await finding(staged)), { inbox: 'admin', sha256: hash('2') });
      const library = await put(`${LAKE}/s.jpg`, hash('2'), { uid: 0, gid: 0 }, 0o644);
      const recorded = await admin.execJson<DuplicatesRecorded>(`duplicates --record ${library}`);
      assertEquals(recorded, { ok: true, recorded: 1, unchanged: 0, skipped: [] });
      const libraryId = await idOf(library);
      assertEquals(timeless(await finding(staged)), { inbox: 'admin', sha256: hash('2'), kind: 'exact', where: 'library', of: libraryId });
      assertEquals(timeless(await finding(elsewhere)), { inbox: 'anna', sha256: hash('2'), kind: 'exact', where: 'library', of: libraryId });
      assertEquals((await vfs.get(ADMIN_ACCESS, library)).attrs.duplicate, undefined);
    });

    await t.step('a library twin the owner cannot read counts for nothing', async () => {
      await put(`${PRIVATE}/p.jpg`, hash('3'));
      const staged = await put(`${ANNA_INBOX}/private/p.jpg`, hash('3'), anna);
      await cmd.shouldSucceed(`duplicates --record ${staged}`);
      assertEquals(timeless(await finding(staged)), { inbox: 'anna', sha256: hash('3') });
    });

    await t.step('--checksum names only what the caller can read in the library or its own inbox', async () => {
      const own = await put(`${ANNA_INBOX}/check/c.jpg`, hash('4'), anna);
      await put(`${ADMIN_INBOX}/check/c.jpg`, hash('4'));
      await put(`${PRIVATE}/c.jpg`, hash('4'));
      const shared = await put(`${LAKE}/c.jpg`, hash('4'), { uid: 0, gid: 0 }, 0o644);
      const answer = await asAnna.execJson<ChecksumMatches>(`duplicates --checksum ${hash('4')} ${hash('9')}`);
      assertEquals(
        answer.matches,
        [{ sha256: hash('4'), where: 'library', path: shared }, { sha256: hash('4'), where: 'inbox', path: own }].sort((a, b) => a.path.localeCompare(b.path)),
      );
      assertEquals((await asAnna.exec('duplicates --checksum not-a-checksum')).success, false);
    });

    await t.step('filing an original makes its copies copies of a library file, and clears its own finding', async () => {
      const [original, copy] = await twins(`${ADMIN_INBOX}/filed`, hash('5'), ['o.jpg', 'c.jpg']);
      assertEquals(timeless(await finding(copy))?.where, 'inbox');
      const added = await admin.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/lake ${original}`);
      const filed = added.moved[0].to;
      assertEquals(await finding(filed), undefined);
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256: hash('5'), kind: 'exact', where: 'library', of: await idOf(filed) });
    });

    await t.step('promoting a group does the same', async () => {
      const [original, copy] = await twins(`${ADMIN_INBOX}/promoted`, hash('6'), ['o.jpg', 'c.jpg']);
      const id = await idOf(original);
      await makeGroup(vfs, '/home/admin/staging/albums/inbox/2019-06-20', 'Pier', [original], { uid: 0, gid: 0 });
      const promoted = await admin.execJson<StagingPromoteResult>(`staging promote 2019-06-20 --name Pier`);
      assertEquals(promoted.moved, 1);
      const filed = (await vfs.resolveIdPaths(ADMIN_ACCESS, [id])).get(id)![0];
      assertEquals(await finding(filed), undefined);
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256: hash('6'), kind: 'exact', where: 'library', of: id });
    });

    let batch = '';
    let restoredOriginal = '';
    await t.step('discarding the original writes the trashed form, and its copy becomes the original', async () => {
      const [original, copy] = await twins(`${ADMIN_INBOX}/discarded`, hash('7'), ['o.jpg', 'c.jpg']);
      assertEquals(timeless(await finding(original)), { inbox: 'admin', sha256: hash('7') });
      const id = await idOf(original);
      const result = await admin.execJson<StagingDiscardResult>(`staging discard ${original}`);
      batch = result.batches[0];
      const trashed = (await vfs.getNodesByIds(ADMIN_ACCESS, [id])).get(id)!.attrs.duplicate as DuplicateFinding;
      assertEquals(timeless(trashed), { sha256: hash('7') });
      assertEquals(timeless(await finding(copy)), { inbox: 'admin', sha256: hash('7') });
      restoredOriginal = original;
    });

    await t.step('a restore is announced, and recording it brings its finding back', async () => {
      const subjects = await staleFrom(() => admin.exec(`trash restore ${batch}`));
      assertEquals(subjects, [restoredOriginal]);
      await cmd.shouldSucceed(`duplicates --record ${restoredOriginal}`);
      assertEquals(timeless(await finding(restoredOriginal)), { inbox: 'admin', sha256: hash('7') });
      const twin = [`${ADMIN_INBOX}/discarded/o.jpg`, `${ADMIN_INBOX}/discarded/c.jpg`].find((path) => path !== restoredOriginal)!;
      const [smaller] = [await idOf(restoredOriginal), await idOf(twin)].sort();
      assertEquals(timeless(await finding(smaller === (await idOf(twin)) ? restoredOriginal : twin))?.of, smaller);
    });

    await t.step('a move between categories announces nothing; a folder moved in from outside is announced', async () => {
      await cmd.shouldSucceed('staging category scans --create --kind scans --label Scans');
      assertEquals(await staleFrom(() => admin.execJson<StagingMoveResult>(`staging move ${ADMIN_INBOX}/discarded /home/admin/staging/files/scans`)), []);
      await cmd.shouldSucceed('mkdir -p /home/admin/elsewhere/box');
      await put('/home/admin/elsewhere/box/b.jpg', hash('8'));
      assertEquals(await staleFrom(() => admin.exec(`mv /home/admin/elsewhere/box ${ADMIN_INBOX}/`)), [`${ADMIN_INBOX}/box`]);
      const recorded = await admin.execJson<DuplicatesRecorded>(`duplicates --record ${ADMIN_INBOX}/box`);
      assertEquals([recorded.recorded, recorded.unchanged], [1, 0]);
      assertEquals(timeless(await finding(`${ADMIN_INBOX}/box/b.jpg`)), { inbox: 'admin', sha256: hash('8') });
    });

    await t.step('refresh announces only the files whose finding does not hold, a limit at a time', async () => {
      const dir = `${ADMIN_INBOX}/unchecked`;
      for (const name of ['u1.jpg', 'u2.jpg', 'u3.jpg']) await put(`${dir}/${name}`, hash('a'));
      const dry = await admin.execJson<DuplicateRefreshResult>(`staging duplicates --refresh ${dir} --dry-run`);
      assertEquals([dry.emitted, dry.complete, dry.dryRun], [3, true, true]);
      const first = await admin.execJson<DuplicateRefreshResult>(`staging duplicates --refresh ${dir} --limit 2`);
      assertEquals([first.emitted, first.complete], [2, false]);
      const rest = await admin.execJson<DuplicateRefreshResult>(`staging duplicates --refresh ${dir} --limit 2 --cursor ${first.cursor}`);
      assertEquals([rest.emitted, rest.complete], [1, true]);
      const forced = await admin.execJson<DuplicateRefreshResult>(`staging duplicates --refresh ${ADMIN_INBOX}/box --force --dry-run`);
      assertEquals(forced.emitted, 1);
      assertEquals((await admin.exec(`staging duplicates --refresh /home/anna/staging/files`)).success, false);
    });

    await t.step('repair: a generic trash put, a move out of staging and a lost original', async () => {
      const [original, trashedCopy, movedCopy, keptCopy] = await twins(`${ADMIN_INBOX}/repair`, hash('b'), ['o.jpg', 't.jpg', 'm.jpg', 'k.jpg']);
      const trashedId = await idOf(trashedCopy);
      const originalId = await idOf(original);
      await cmd.shouldSucceed(`trash put ${trashedCopy}`);
      await cmd.shouldSucceed(`mv ${movedCopy} /home/admin/elsewhere/moved.jpg`);
      await cmd.shouldSucceed(`rm ${original}`);

      const found = (await vfs.aggregate(ADMIN_ACCESS, {
        types: ['file'],
        where: [{ ref: { path: ['duplicate', 'inbox'] }, op: 'eq', value: 'admin' }, { ref: { path: ['duplicate', 'kind'] }, op: 'exists' }],
        group: [{ column: 'id' }],
      })).length;
      const repair = await admin.execJson<DuplicateRepairResult>('staging duplicates --repair');
      assertEquals([repair.users, repair.examined, repair.cleared, repair.trashed], [1, found, 1, 1], JSON.stringify(repair));
      assert(repair.recomputed >= 1);
      assertEquals(timeless((await vfs.getNodesByIds(ADMIN_ACCESS, [trashedId])).get(trashedId)!.attrs.duplicate as DuplicateFinding), { sha256: hash('b'), of: originalId });
      assertEquals(await finding('/home/admin/elsewhere/moved.jpg'), undefined);
      assertEquals(timeless(await finding(keptCopy)), { inbox: 'admin', sha256: hash('b') });
      const again = await admin.execJson<DuplicateRepairResult>('staging duplicates --repair --all');
      assertEquals([again.cleared, again.trashed, again.recomputed], [0, 0, 0]);
    });

    await t.step('the media-duplicates pipeline queues a kind the CPU worker takes', async () => {
      const pipeline = await Deno.readTextFile(new URL('../../pipelines/media-duplicates.yaml', import.meta.url));
      const worker = await Deno.readTextFile(new URL('../../services/cpu/start.sh', import.meta.url));
      assert(pipeline.includes('kind: dedupe') && pipeline.includes('on: media.duplicates.stale'));
      assert(worker.includes('--kind dedupe'));
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
