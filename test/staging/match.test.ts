/**
 * Matching suggested groups against the library's album profiles (`@archive/staging/match`).
 *
 * The arithmetic, pure: containment of people beats their overlap; the nearest member counts, not
 * an album's span; a trip through two towns scores on its cells, not their centroid; absent
 * evidence neither raises nor lowers the logit; the albums and a new one share one choice; a broad
 * or unsorted album weighs less; votes need a spread of cosines; the tiers, the margin, the
 * new-album likelihood, and that an album with no time, place, people or copies is never first.
 *
 * Through `staging match` and `staging reject`, as the inbox's owner (not an administrator): the
 * matches are stored stamped with the member key; an album the owner cannot read is never offered
 * and one they cannot file into is marked so; `album list` resolves the top match and `album info`
 * the candidates and a lane's matched days; a rejection holds for a successor group made mostly
 * of the same members until it is undone; filing the first day of a trip into a new album makes
 * it the second day's best candidate; pictures that look alike find an album on their own.
 */
import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { AlbumInfoAnswer, AlbumListResult } from '@archive/media/api';
import type { StagingAcceptResult, StagingEditResult, StagingJournalPage, StagingMatches, StagingMatchResult, StagingUndoResult } from '@archive/staging/api';
import { deleteAutoAlbum, groupSpec, memberKeyOf } from '@archive/staging/auto-album';
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { peopleEvidence, placeEvidence, rankCandidates, rejectsFor, timeEvidence, voteOf, withoutAlbum } from '../../lib/staging/match.ts';
import { breadthOf, choiceOf, logitOf, verdictOf } from '../../lib/staging/model.ts';
import { saysUnsorted } from '../../lib/media/name-quality.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const minute = (iso: string) => Date.parse(iso) / 60_000;

Deno.test('the arithmetic of the evidence', async (t) => {
  await t.step('containment beats overlap: two guests of an album of twelve people score high', () => {
    const album = new Set(['anna', 'bo', ...Array.from({ length: 10 }, (_, i) => `p${i}`)]);
    assertEquals(peopleEvidence(new Set(['anna', 'bo']), album, () => 1), 1);
    assertEquals(peopleEvidence(new Set(['anna', 'cid']), album, () => 1), 0.5);
    assertEquals(peopleEvidence(new Set(['anna']), new Set(), () => 1), undefined);
  });

  await t.step("the nearest member counts, not an album's span", () => {
    const item = { minute: minute('2010-06-01T12:00:00Z') };
    const decade = [minute('2005-01-01T12:00:00Z'), minute('2015-12-31T12:00:00Z')];
    const afternoon = [minute('2010-06-01T12:30:00Z')];
    assert(timeEvidence([item], decade, 2)! < 0.01);
    assert(timeEvidence([item], afternoon, 1)! > 0.8);
    // Dated only to the year: half, when the album has an instant in it.
    assertEquals(timeEvidence([{ period: [minute('2010-01-01T00:00:00Z'), minute('2011-01-01T00:00:00Z')] }], afternoon, 1), 0.5);
    assertEquals(timeEvidence([{}], afternoon, 1), undefined);
  });

  await t.step('a trip through two towns scores on its cells, not their centroid', () => {
    const items = [{ cell: '5930:1810' }, { cell: '5930:1810' }, { cell: '5770:1197' }];
    const towns = { cells: new Set(['5930:1810', '5770:1197']), locations: new Set<string>() };
    const between = { cells: new Set(['5850:1500']), locations: new Set<string>() };
    const idf = { cell: () => 1, location: () => 1 };
    assertEquals(placeEvidence(items, towns, idf), 1);
    assertEquals(placeEvidence(items, between, idf), 0);
    // A neighbouring cell counts; a place every album has weighs nothing.
    assertEquals(placeEvidence([{ cell: '5930:1811' }], towns, idf), 1);
    assertEquals(placeEvidence(items, towns, { cell: () => 0, location: () => 1 }), undefined);
  });

  await t.step('the logit over the evidence present; absent evidence neither raises nor lowers it', () => {
    assert(logitOf({ time: 1 }, true) < logitOf({ time: 1, place: 1 }, true));
    assert(logitOf({ time: 1, place: 1 }, true) < logitOf({ time: 1, place: 1, people: 1 }, true));
    assertEquals(logitOf({ time: 1, visual: undefined }, true), logitOf({ time: 1 }, true));
    assertEquals(logitOf({ time: 1, visual: 0 }, true), logitOf({ time: 1 }, true));
    // An album near in time is likely on its own; one with nothing near it is not.
    assert(choiceOf([logitOf({ time: 1 }, false)]).p[0] > 0.8);
    assert(choiceOf([logitOf({ time: 0 }, false)]).p[0] < 0.05);
  });

  await t.step('the albums and a new one are one choice: equals share it', () => {
    const one = choiceOf([2]);
    const two = choiceOf([2, 2]);
    assertAlmostEquals(one.p[0] + one.none, 1, 1e-9);
    assertAlmostEquals(two.p[0], two.p[1], 1e-9);
    assert(two.p[0] < one.p[0]);
    assertAlmostEquals(two.p[0] + two.p[1] + two.none, 1, 1e-9);
    // Large logits do not overflow.
    assert(Number.isFinite(choiceOf([800, 790]).p[0]));
    assertEquals(choiceOf([]).none, 1);
  });

  await t.step('a broad album and one whose name says unsorted weigh less', () => {
    assertEquals(breadthOf(1), 0);
    assertEquals(breadthOf(20_000), 1);
    assert(logitOf({ time: 0.8, breadth: breadthOf(3651) }, true) < logitOf({ time: 0.8, breadth: 0 }, true));
    assert(logitOf({ time: 0.8, unsorted: 1 }, true) < logitOf({ time: 0.8 }, true));
    for (const name of ['Unsorted 2019', 'misc', 'Camera roll', 'Osorterade bilder', 'Övrigt', 'Blandat']) assert(saysUnsorted(name), name);
    for (const name of ['Midsummer at the lake', 'Overview', 'Miscanthus garden', 'Anna Andersson 40']) assert(!saysUnsorted(name), name);
  });

  await t.step('votes need a spread: high cosines with none give no votes', () => {
    assertEquals(voteOf(0.95, 0.95, 0.95), 0);
    assertAlmostEquals(voteOf(0.9, 0.9, 0.4), 1, 0.03);
    assertEquals(voteOf(0.4, 0.9, 0.4), 0);
  });

  await t.step('tiers, margin and how likely a new album is', () => {
    assertEquals(verdictOf(0.92, 0.4), { proposal: 'existing', confidence: 'high' });
    assertEquals(verdictOf(0.92, 0.2), { proposal: 'existing', confidence: 'medium' });
    assertEquals(verdictOf(0.6, 0.15), { proposal: 'existing', confidence: 'medium' });
    assertEquals(verdictOf(0.6, 0.05), { proposal: 'new', confidence: 'low' });
    assertEquals(verdictOf(0.3, 0.3), { proposal: 'new', confidence: 'low' });
    const { candidates, newAlbum } = rankCandidates([
      { albumId: 'b', logit: 1, evidence: { time: 0.5 }, reasons: [] },
      { albumId: 'a', logit: 2, evidence: { time: 1 }, reasons: ['near'] },
      { albumId: 'c', logit: -1, evidence: { time: 0.2 }, reasons: [] },
      { albumId: 'd', logit: -2, evidence: { time: 0.1 }, reasons: [] },
    ], (id) => id !== 'b');
    const { p, none } = choiceOf([2, 1, -1, -2]);
    assertEquals(candidates.map((each) => [each.albumId, each.writable]), [['a', true], ['b', false], ['c', true]]);
    assertEquals(candidates.map((each) => each.score), p.slice(0, 3).map((value) => Math.round(value * 1000) / 1000));
    assertAlmostEquals(candidates[2].margin, p[2] - p[3], 0.002);
    assertAlmostEquals(newAlbum, none, 0.001);
  });

  await t.step('an album with no time, place, people or copies is ranked after those with some, and is not proposed', () => {
    // It looks alike and is likelier on the logit, but nothing of it is near: second.
    const { candidates } = rankCandidates([
      { albumId: 'far', logit: 3, evidence: { time: 0.001, visual: 1 }, reasons: [] },
      { albumId: 'near', logit: 1, evidence: { time: 0.6 }, reasons: [] },
    ], () => true);
    assertEquals(candidates.map((each) => each.albumId), ['near', 'far']);
    assertEquals(candidates.map((each) => each.margin), [0, 0]);
    const alone = rankCandidates([{ albumId: 'far', logit: 3, evidence: { visual: 1 }, reasons: [] }], () => true).candidates;
    assertEquals(alone[0].margin, 0);
    assertEquals(verdictOf(alone[0].score, alone[0].margin).proposal, 'new');
  });

  await t.step('without a rejected album the others share its probability', () => {
    const matches: StagingMatches = {
      computedAt: '2026-01-01T00:00:00Z',
      memberKey: 'k',
      model: 'm',
      proposal: 'existing',
      confidence: 'medium',
      newAlbum: 0.2,
      visual: false,
      candidates: [
        { albumId: 'a', score: 0.6, margin: 0.4, reasons: [], evidence: { time: 1 }, writable: true },
        { albumId: 'b', score: 0.2, margin: 0.2, reasons: [], evidence: { time: 0.5 }, writable: true },
      ],
    };
    const left = withoutAlbum(matches, 'a');
    assertEquals(left.candidates.map((each) => [each.albumId, each.score, each.margin]), [['b', 0.5, 0.5]]);
    assertEquals(left.newAlbum, 0.5);
    assertEquals([left.proposal, left.confidence], ['existing', 'medium']);
  });

  await t.step('a rejection covers a group at least half of whose members it names', () => {
    const reject = { category: 'inbox', members: ['f1', 'f2', 'f3'], album: 'lake' };
    assertEquals([...rejectsFor(['f1', 'f2', 'f9', 'f8'], [reject])], ['lake']);
    assertEquals([...rejectsFor(['f1', 'f7', 'f8', 'f9'], [reject])], []);
  });
});

const STAGING = '/home/anna/staging';
const BATCH = `${STAGING}/files/inbox/upload-2019-06-20`;
const GROUPS = `${STAGING}/albums/inbox`;
const DIM = 8;

Deno.test({ name: 'staging match and reject', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin: ShellClient = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];
  const cmd = testCommands(admin);
  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;

  const writeVector = async (file: string, axis: number) => {
    await vfs.create(ADMIN_ACCESS, 'directory', file, 'metadata');
    await vfs.create(ADMIN_ACCESS, 'directory', `${file}/metadata`, 'picture');
    await vfs.create(ADMIN_ACCESS, 'embedding', `${file}/metadata/picture`, 'embedding', { attrs: { embeddingType: 'picture_test', capacity: DIM } });
    const vector = Array.from({ length: DIM }, (_, i) => i === axis ? 1 : 0.02 * ((file.length + i) % 5));
    const handle = await vfs.open(ADMIN_ACCESS, `${file}/metadata/picture/embedding`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
  };
  /** A library album of photos taken at `times` (UTC), owned and shared as `props` say, each with a vector on `axis`. */
  const libraryAlbum = async (slug: string, title: string, times: string[], props: { uid: number; gid: number; mode: number }, axis: number) => {
    const path = `${ALBUMS_ROOT}/${slug}`;
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, slug, { props, attrs: { name: title } });
    await vfs.create(ADMIN_ACCESS, 'directory', path, 'files', { props });
    const files: string[] = [];
    for (const [i, at] of times.entries()) {
      await vfs.create(ADMIN_ACCESS, 'file', `${path}/files`, `${slug}-${i}.jpg`, { props, attrs: { mimetype: 'image/jpeg', takenAt: at.slice(0, 19), takenAtUtc: at } });
      files.push(`${path}/files/${slug}-${i}.jpg`);
      await writeVector(files[i], axis);
    }
    return { path, files, id: await idOf(path) };
  };
  /** A suggested group of `members` as the organizer writes one, of `kind`. */
  const group = async (slug: string, name: string, members: string[], owner: { uid: number; gid: number }, meta: Record<string, unknown> = {}) => {
    const ids = await Promise.all(members.map(idOf));
    const autoAlbum = { memberKey: memberKeyOf(ids), memberCount: members.length, generatedName: name, generatedAt: '2019-06-21T00:00:00Z', generatedBy: 'test', ...meta };
    await vfs.createTree(ADMIN_ACCESS, GROUPS, [groupSpec(slug, { name, autoAlbum }, members, owner, members[0])]);
    return `${GROUPS}/${slug}`;
  };
  /** `count` staged photos taken a minute apart from `at` (UTC). */
  const stage = async (prefix: string, at: string, count: number, owner: { uid: number; gid: number }) => {
    const start = Date.parse(at);
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const utc = new Date(start + i * 60_000).toISOString().replace('.000', '');
      await vfs.create(ADMIN_ACCESS, 'file', BATCH, `${prefix}-${i}.jpg`, {
        props: { uid: owner.uid, gid: owner.gid, mode: 0o640 },
        attrs: { mimetype: 'image/jpeg', takenAt: utc.slice(0, 19), takenAtUtc: utc, indexedAt: utc },
      });
      paths.push(`${BATCH}/${prefix}-${i}.jpg`);
    }
    return paths;
  };
  const matchesOf = async (path: string) => (await vfs.get<{ stagingMatches?: StagingMatches }>(ADMIN_ACCESS, path)).attrs.stagingMatches;

  try {
    await cmd.shouldSucceed('group-exists users || group-create users --gid 1002');
    await cmd.shouldSucceed('user-create anna --uid 3400');
    await cmd.shouldSucceed('user-passwd anna --new-password secret1');
    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} ${PEOPLE_ROOT} && chmod 777 ${ALBUMS_ROOT}`);
    const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
    clients.push(anna);
    const asAnna = testCommands(anna);
    await asAnna.shouldSucceed(`mkdir -p ${BATCH}`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/anna');
    const owner = { uid: home.props.uid, gid: home.props.gid };
    const users = 1002;

    // Her lake trip, a shared summer album busy with other days, an album she may only look at,
    // and one she may not see at all, all around the same days; an old album of boats.
    const lake = await libraryAlbum('lake', 'Lake trip 2019', ['2019-06-14T09:00:00Z', '2019-06-15T08:30:00Z', '2019-06-16T09:00:00Z'], { ...owner, mode: 0o750 }, 0);
    const summer = await libraryAlbum(
      'summer',
      'Summer 2019',
      Array.from({ length: 30 }, (_, i) => `2019-06-${String(i + 1).padStart(2, '0')}T15:00:00Z`),
      { uid: 0, gid: users, mode: 0o775 },
      1,
    );
    const view = await libraryAlbum('cousins', 'Cousins 2019', ['2019-06-15T08:40:00Z'], { uid: 0, gid: users, mode: 0o750 }, 2);
    const hidden = await libraryAlbum('private', 'Private 2019', ['2019-06-15T08:35:00Z'], { uid: 0, gid: 0, mode: 0o700 }, 3);
    const boats = await libraryAlbum('boats', 'Boats', ['2010-05-01T10:00:00Z', '2010-05-01T10:05:00Z', '2010-05-01T10:10:00Z'], { uid: 0, gid: users, mode: 0o775 }, 5);
    for (const file of lake.files) await cmd.shouldSucceed(`position-set ${file}/position --lat=59.301 --lng=18.102`);
    await admin.execJson('album-profile --all');

    const pier = await stage('pier', '2019-06-15T08:20:00Z', 4, owner);
    for (const file of pier) await cmd.shouldSucceed(`position-set ${file}/position --lat=59.302 --lng=18.103`);
    const pierGroup = await group('2019-06-15', 'Pier', pier, owner, { kind: 'event', timeStart: '2019-06-15T08:20:00Z', timeEnd: '2019-06-15T08:23:00Z' });

    // The organizer matches as an administrator, reading every signal of the owner's files; the
    // albums are judged as the owner sees them.
    await t.step('matches are stored on the group, stamped with its member key', async () => {
      const result = await admin.execJson<StagingMatchResult>(`staging match ${pierGroup}`);
      assertEquals([result.matched, result.skipped], [1, []]);
      const matches = (await matchesOf(pierGroup))!;
      const meta = (await vfs.get<{ autoAlbum: { memberKey: string } }>(ADMIN_ACCESS, pierGroup)).attrs.autoAlbum;
      assertEquals(matches.memberKey, meta.memberKey);
      assertEquals(matches.candidates[0].albumId, lake.id);
      // The same place minutes from the album's photos: sure.
      assertEquals([matches.proposal, matches.confidence], ['existing', 'high']);
      assert(matches.candidates[0].evidence.place === 1 && matches.candidates[0].evidence.time! > 0.9);
      assert(matches.candidates[0].reasons.some((reason) => reason.startsWith('same places')));
      // A new album is what the candidates leave of the choice.
      const shares = matches.candidates.reduce((sum, candidate) => sum + candidate.score, 0);
      assert(matches.newAlbum <= 1 - shares + 0.002);
    });

    await t.step('an album the owner cannot read is never offered; one she cannot file into is marked so', async () => {
      const matches = (await matchesOf(pierGroup))!;
      const ids = matches.candidates.map((candidate) => candidate.albumId);
      assert(!ids.includes(hidden.id));
      assertEquals(matches.candidates.find((candidate) => candidate.albumId === view.id)?.writable, false);
      assertEquals(matches.candidates.find((candidate) => candidate.albumId === lake.id)?.writable, true);
      // An album busy with other days around them is offered below the focused one.
      const busy = matches.candidates.find((candidate) => candidate.albumId === summer.id);
      assert(!busy || busy.score < matches.candidates[0].score);
    });

    await t.step('album list resolves the top match; album info gives the candidates with their reasons', async () => {
      const listed = await anna.execJson<AlbumListResult>(`album list ${GROUPS}`);
      const row = listed.items.find((item) => item.path === pierGroup)!;
      assertEquals([row.staging?.top?.album.path, row.staging?.top?.album.writable, row.staging?.matchConfidence], [lake.path, true, 'high']);
      const info = await anna.execJson<AlbumInfoAnswer>(`album info ${pierGroup}`);
      const detail = info.albums[0].suggested!;
      assertEquals(detail.candidates[0].album.title, 'Lake trip 2019');
      assertEquals(detail.candidates[0].evidence, (await matchesOf(pierGroup))?.candidates[0].evidence);
    });

    await t.step('a rejection holds for a successor group made mostly of the same members, until it is undone', async () => {
      const rejected = await anna.execJson<StagingEditResult>(`staging reject 2019-06-15 ${lake.path}`);
      assert(rejected.journal);
      assert(!(await matchesOf(pierGroup))!.candidates.some((candidate) => candidate.albumId === lake.id));
      const page = await anna.execJson<StagingJournalPage>('staging journal inbox --action reject');
      assertEquals(page.entries[0].reject?.album, lake.id);

      // The organizer rebuilds it with one more photo: still most of the same members.
      const late = await stage('late', '2019-06-15T08:40:00Z', 1, owner);
      await deleteAutoAlbum(vfs, ADMIN_ACCESS, pierGroup, GROUPS);
      const successor = await group('2019-06-15-2', 'Pier', [...pier, ...late], owner, { kind: 'event' });
      await admin.execJson<StagingMatchResult>(`staging match ${successor}`);
      assert(!(await matchesOf(successor))!.candidates.some((candidate) => candidate.albumId === lake.id));

      // Undone, the groups holding its members are matched again, the album among them once more.
      const undone = await anna.execJson<StagingUndoResult>(`staging undo ${rejected.journal}`);
      assertEquals(undone.undone, [rejected.journal]);
      assertEquals(await matchesOf(successor), undefined);
      await admin.execJson<StagingMatchResult>(`staging match ${successor}`);
      assertEquals((await matchesOf(successor))!.candidates[0].albumId, lake.id);
    });

    await t.step('an Everyday lane is matched a day at a time, and proposes its matched days', async () => {
      const near = await stage('dock', '2019-06-16T09:10:00Z', 3, owner);
      for (const file of near) await cmd.shouldSucceed(`position-set ${file}/position --lat=59.301 --lng=18.102`);
      const far = await stage('yard', '2018-03-01T12:00:00Z', 2, owner);
      const lane = await group('2019-loose', 'Everyday · 2019', [...near, ...far], owner, {
        kind: 'loose',
        key: 'loose:2019',
        dayCounts: [['2018-03-01', 2], ['2019-06-16', 3]],
      });
      await admin.execJson<StagingMatchResult>(`staging match ${lane}`);
      const matches = (await matchesOf(lane))!;
      assertEquals(matches.candidates, []);
      assertEquals(matches.days?.map((day) => [day.day, day.albumId, day.files]), [['2019-06-16', lake.id, 3]]);
      const row = (await anna.execJson<AlbumListResult>(`album list ${GROUPS}`)).items.find((item) => item.path === lane)!;
      assertEquals(row.staging?.partsMatched, { parts: 1, files: 3 });
      const info = await anna.execJson<AlbumInfoAnswer>(`album info ${lane}`);
      assertEquals(info.albums[0].suggested?.parts.map((part) => [part.day, part.match?.album.path ?? null]), [['2018-03-01', null], ['2019-06-16', lake.path]]);
      const plan = await anna.execJson<StagingAcceptResult>(`staging accept ${lane} --dry-run`);
      assertEquals(plan.plan[0].proposal, { action: 'parts', parts: 1, files: 3, confidence: 'medium' });
      const accepted = await anna.execJson<StagingAcceptResult>(`staging accept ${lane}`);
      assertEquals(accepted.journal.length, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${lake.path}/files/dock-0.jpg`), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${BATCH}/yard-0.jpg`), true);
    });

    await t.step("filing a trip's first day into a new album makes it its second day's best candidate", async () => {
      const day1 = await stage('coast-a', '2020-07-01T10:00:00Z', 3, owner);
      const day2 = await stage('coast-b', '2020-07-02T11:00:00Z', 3, owner);
      const first = await group('2020-07-01', 'Coast · 1 Jul', day1, owner, { kind: 'event' });
      const second = await group('2020-07-02', 'Coast · 2 Jul', day2, owner, { kind: 'event' });
      await anna.execJson<StagingMatchResult>(`staging match ${first} ${second}`);
      assertEquals((await matchesOf(second))!.candidates, []);
      await asAnna.shouldSucceed(`staging promote ${first} --name 'Coast trip'`);
      const coast = await idOf(`${ALBUMS_ROOT}/Coast trip`);
      assertEquals((await matchesOf(second))!.candidates[0].albumId, coast);
      const row = (await anna.execJson<AlbumListResult>(`album list ${GROUPS}`)).items.find((item) => item.path === second)!;
      assertEquals(row.staging?.top?.album.title, 'Coast trip');
    });

    await t.step('--since matches the groups around the days whose profiles changed; --stale those due a match', async () => {
      const day3 = await stage('coast-c', '2020-07-03T09:00:00Z', 2, owner);
      const third = await group('2020-07-03', 'Coast · 3 Jul', day3, owner, { kind: 'event' });
      const around = await admin.execJson<StagingMatchResult>("staging match --user anna --since '2020-01-01T00:00:00Z'");
      assert(around.matched >= 2, JSON.stringify(around));
      assertEquals((await matchesOf(third))!.candidates[0].albumId, await idOf(`${ALBUMS_ROOT}/Coast trip`));
      await admin.execJson<StagingMatchResult>('staging match --user anna --stale');
      assertEquals((await admin.execJson<StagingMatchResult>('staging match --user anna --stale')).matched, 0);
      // Matches another model made are due again.
      const stored = (await matchesOf(third))!;
      await vfs.update(ADMIN_ACCESS, third, { attrs: { stagingMatches: { ...stored, model: 'an-older-model' } } });
      assertEquals((await admin.execJson<StagingMatchResult>('staging match --user anna --stale')).matched, 1);
    });

    await t.step('--since searches no inbox without groups', async () => {
      await cmd.shouldSucceed('user-create bertil --uid 3401 && staging init --user bertil');
      const query = vfs.query.bind(vfs);
      const within: string[] = [];
      vfs.query = (access, spec) => {
        if (spec.within) within.push(spec.within);
        return query(access, spec);
      };
      try {
        assertEquals((await admin.execJson<StagingMatchResult>("staging match --user bertil --since '2020-01-01T00:00:00Z'")).matched, 0);
      } finally {
        vfs.query = query;
      }
      assertEquals(within.filter((path) => path.startsWith('/home/bertil/')), []);
    });

    await t.step('pictures that look alike find an album on their own', async () => {
      const harbour = await stage('harbour', '2021-08-01T10:00:00Z', 3, owner);
      for (const file of harbour) await writeVector(file, 5);
      const looks = await group('2021-08-01', 'Harbour', harbour, owner, { kind: 'event' });
      await admin.execJson<StagingMatchResult>(`staging match ${looks}`);
      const matches = (await matchesOf(looks))!;
      assertEquals(matches.visual, true);
      const found = matches.candidates.find((candidate) => candidate.albumId === boats.id)!;
      assert(found.evidence.visual! > 0.5, JSON.stringify(found));
      assert(found.reasons.includes('looks alike'));
      assertEquals(found.evidence.time, 0);
    });

    await t.step('a promote keeps the matches it was chosen from', async () => {
      const page = await anna.execJson<StagingJournalPage>('staging journal inbox --action promote');
      assert(page.entries.length > 0);
      const entry = await vfs.get<{ stagingMatchDecision?: { chosen: string; candidates: unknown[] } }>(ADMIN_ACCESS, `${STAGING}/journal/${page.entries[0].id}`);
      assertEquals(entry.attrs.stagingMatchDecision?.chosen, 'new');
    });

    await t.step('without groups, every group of hers is matched, as she can read them', async () => {
      const result = await anna.execJson<StagingMatchResult>('staging match');
      assert(result.matched >= 3, JSON.stringify(result));
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
