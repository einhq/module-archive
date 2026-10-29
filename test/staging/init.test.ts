/**
 * `staging init` on a staging area from before categories: loose files in `files/`, a folder
 * there, groups loose in `albums/` linking to the loose files, a relation from a library file to a
 * staged one, a link from the home, and GPX files waiting for a device. Afterwards the files are
 * in the default category's loose batch, the folder is a category, the groups are the default
 * category's, the waiting GPX files are in `routes/`, every link still resolves, and `staging/` is
 * unlisted. A dry run changes nothing; a second run finds nothing to do; a lost mark is reported
 * by `staging check` and put back by the layout alone; `--idle-minutes` leaves a file changed
 * within them where it is.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { StagingCheckAnswer, StagingInitAnswer } from '@archive/staging/api';
import { type AutoAlbumMeta, isUserEdited, memberKeyOf } from '@archive/staging/auto-album';
import type { RelationAttrs } from '@ein/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { UNLISTED_ATTR } from '@ein/client';
import { readMembers } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/anna/staging';
const FILES = `${STAGING}/files`;
const ALBUMS = `${STAGING}/albums`;
const BATCH = `${FILES}/inbox/old-scans`;

Deno.test({ name: 'staging init', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
  const targetOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path, { follow: false })).props.softlink;
  /** Every event under the staging area while `run` runs. */
  const eventsDuring = async (run: () => Promise<unknown>): Promise<string[]> => {
    const seen: string[] = [];
    const subscription = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
      if (event.path.startsWith(STAGING)) seen.push(`${event.type} ${event.path}`);
    });
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await subscription.unsubscribe();
    }
    return seen;
  };
  try {
    await cmd.shouldSucceed('user-create anna --uid 3500');
    const home = await vfs.get(ADMIN_ACCESS, '/home/anna');
    await cmd.shouldSucceed(`mkdir -p ${FILES}/legacy/deep ${ALBUMS} ${ALBUMS_ROOT}/library`);
    for (const name of ['beach.jpg', 'dune.jpg', 'legacy/old.jpg']) await cmd.shouldSucceed(`mknode -t file ${FILES}/${name} --as mimetype=image/jpeg`);
    for (const name of ['hike.gpx', 'legacy/deep/walk.gpx']) {
      await cmd.shouldSucceed(`mknode -t file ${FILES}/${name} --as mimetype=application/gpx+xml`);
      await vfs.update(ADMIN_ACCESS, `${FILES}/${name}`, { attrs: { trackDevicePending: true } });
    }
    // A group from before categories, as the clusterer made it.
    await cmd.shouldSucceed(`mknode -t album ${ALBUMS}/day`);
    for (const name of ['beach.jpg', 'dune.jpg']) await cmd.shouldSucceed(`ln -s ${FILES}/${name} ${ALBUMS}/day/${name}`);
    await cmd.shouldSucceed(`ln -s ${FILES}/beach.jpg ${ALBUMS}/day/coverPhoto`);
    const day: AutoAlbumMeta = {
      timeStart: '2026-03-01T10:00:00Z',
      timeEnd: '2026-03-01T12:00:00Z',
      memberKey: memberKeyOf([await idOf(`${FILES}/beach.jpg`), await idOf(`${FILES}/dune.jpg`)]),
      memberCount: 2,
      generatedName: 'day',
      generatedAt: '2026-03-02T00:00:00Z',
      generatedBy: 'auto-album-cluster',
    };
    await vfs.update(ADMIN_ACCESS, `${ALBUMS}/day`, { attrs: { origin: 'auto', name: 'day', autoAlbum: day } });
    // A library file related to a staged one, and the home linking to it.
    await cmd.shouldSucceed(`mknode -t file ${ALBUMS_ROOT}/library/sail.jpg --as mimetype=image/jpeg`);
    await cmd.shouldSucceed(`relate ${ALBUMS_ROOT}/library/sail.jpg ${FILES}/beach.jpg near`);
    await cmd.shouldSucceed(`ln -s ${FILES}/beach.jpg /home/anna/favourite.jpg`);
    const linksBefore = (await vfs.findLinks(ADMIN_ACCESS, `${FILES}/beach.jpg`)).length;

    const expected = (dryRun: boolean): Partial<StagingInitAnswer['users'][number]> => ({
      user: 'anna',
      adopted: [`${FILES}/legacy`],
      moved: 2,
      movedTo: BATCH,
      groups: 1,
      routes: 2,
      ...(dryRun ? { relinked: 0 } : {}),
      failed: [],
    });

    await t.step('a dry run says what it would do, and writes nothing', async () => {
      let answer: StagingInitAnswer | undefined;
      const events = await eventsDuring(async () => answer = await client.execJson<StagingInitAnswer>('staging init --user anna --loose-batch old-scans --dry-run'));
      assertEquals(events, []);
      assertEquals(answer!.dryRun, true);
      const [user] = answer!.users;
      assertEquals({ ...user, created: undefined, repaired: undefined }, { ...user, ...expected(true), created: undefined, repaired: undefined });
      for (const path of [`${FILES}/inbox`, BATCH, `${STAGING}/journal`, `${STAGING}/routes`, `${ALBUMS}/inbox`, `${ALBUMS}/legacy`]) {
        assert(user.created.includes(path), path);
      }
      assert(user.repaired.includes(STAGING), 'staging/ is to be marked unlisted');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${FILES}/inbox`), false);
      assertEquals((await vfs.get(ADMIN_ACCESS, STAGING)).attrs[UNLISTED_ATTR], undefined);
    });

    await t.step('loose entries move into the default category, with every link to them', async () => {
      const answer = await client.execJson<StagingInitAnswer>('staging init --user anna --loose-batch old-scans');
      const [user] = answer.users;
      assertEquals({ ...user, created: undefined, repaired: undefined, relinked: undefined }, {
        ...user,
        ...expected(false),
        created: undefined,
        repaired: undefined,
        relinked: undefined,
      });
      assertEquals(answer.ok, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${BATCH}/beach.jpg`), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${FILES}/legacy/old.jpg`), true);
      assertEquals((await client.execJson<string[]>(`ls ${FILES}`)).sort(), ['inbox', 'legacy']);
      assertEquals((await client.execJson<string[]>(`ls ${ALBUMS}`)).sort(), ['inbox', 'legacy']);
      assertEquals((await client.execJson<string[]>(`ls ${STAGING}/routes`)).sort(), ['hike.gpx', 'walk.gpx']);
    });

    await t.step('the groups link to the files where they now are, and still read as generated', async () => {
      const group = `${ALBUMS}/inbox/day`;
      assertEquals((await readMembers(vfs, group)).sort(), [`${BATCH}/beach.jpg`, `${BATCH}/dune.jpg`]);
      assertEquals(await targetOf(`${group}/coverPhoto`), `${BATCH}/beach.jpg`);
      const node = await vfs.get<{ name?: string; autoAlbum?: AutoAlbumMeta }>(ADMIN_ACCESS, group);
      const ids = await Promise.all((await readMembers(vfs, group)).map(async (path) => (await vfs.get(ADMIN_ACCESS, path)).id));
      assertEquals(isUserEdited(node.attrs, ids), false);
    });

    await t.step('links from outside follow too, a relation’s peer link among them', async () => {
      assertEquals(await targetOf('/home/anna/favourite.jpg'), `${BATCH}/beach.jpg`);
      const links = await vfs.findLinks(ADMIN_ACCESS, `${BATCH}/beach.jpg`);
      assertEquals(links.length, linksBefore);
      assertEquals(await vfs.findLinks(ADMIN_ACCESS, `${FILES}/beach.jpg`), []);
      const relation = links.find((link) => link.absPath.startsWith(`${ALBUMS_ROOT}/library/sail.jpg/`));
      assert(relation, 'the library file still relates to the staged one');
      const peer = (relation.node.attrs as RelationAttrs).relation?.peerLink;
      assert(peer?.startsWith(`${BATCH}/beach.jpg/`), peer);
      assertEquals(await vfs.exists(ADMIN_ACCESS, peer!, { follow: false }), true);
    });

    await t.step('every directory is the home owner’s and private, and the default category is the inbox', async () => {
      for (const path of [STAGING, FILES, ALBUMS, `${STAGING}/journal`, `${STAGING}/routes`, `${FILES}/inbox`, `${FILES}/legacy`, BATCH, `${ALBUMS}/inbox`]) {
        const props = (await vfs.get(ADMIN_ACCESS, path)).props;
        assertEquals([props.uid, props.gid, props.mode & 0o7777], [home.props.uid, home.props.gid, 0o700], path);
      }
      assertEquals((await vfs.get(ADMIN_ACCESS, STAGING)).attrs[UNLISTED_ATTR], true);
      const inbox = await vfs.get<{ stagingCategory?: unknown }>(ADMIN_ACCESS, `${FILES}/inbox`);
      assertEquals(inbox.attrs.stagingCategory, {
        kind: 'inbox',
        label: 'Inbox',
        group: { strategy: 'events', significance: 'normal' },
        time: { digitized: false, filenameDates: true },
        lane: 'normal',
        sidecars: 'pair',
      });
      const legacy = await vfs.get<{ stagingCategory?: unknown }>(ADMIN_ACCESS, `${FILES}/legacy`);
      assertEquals(legacy.attrs.stagingCategory, {
        kind: 'generic',
        label: 'legacy',
        group: { strategy: 'events', significance: 'normal' },
        time: { digitized: false, filenameDates: false },
        lane: 'normal',
        sidecars: 'pair',
      });
      assertEquals((await client.execJson<StagingCheckAnswer>('staging check --user anna')).problems, []);
    });

    await t.step('a second run finds nothing to do, and writes nothing', async () => {
      let answer: StagingInitAnswer | undefined;
      const events = await eventsDuring(async () => answer = await client.execJson<StagingInitAnswer>('staging init --user anna'));
      assertEquals(events, []);
      assertEquals(answer!.users, [{
        user: 'anna',
        created: [],
        repaired: [],
        adopted: [],
        moved: 0,
        movedTo: null,
        recent: 0,
        groups: 0,
        routes: 0,
        relinked: 0,
        failed: [],
      }]);
    });

    await t.step('a lost mark is reported, and the layout alone puts it back', async () => {
      await vfs.update(ADMIN_ACCESS, STAGING, { attrs: { [UNLISTED_ATTR]: null } });
      const check = await client.execJson<StagingCheckAnswer>('staging check --user anna');
      assertEquals(check.problems.map((problem) => [problem.code, problem.path]), [['not-unlisted', STAGING]]);
      const answer = await client.execJson<StagingInitAnswer>('staging init --user anna --layout-only');
      assertEquals(answer.users[0].repaired, [STAGING]);
      assertEquals((await vfs.get(ADMIN_ACCESS, STAGING)).attrs[UNLISTED_ATTR], true);
      assertEquals((await client.execJson<StagingCheckAnswer>('staging check --user anna')).problems, []);
    });

    await t.step('a file dropped loose later goes to the default batch, under a free name', async () => {
      await cmd.shouldSucceed(`mknode -t file ${FILES}/beach.jpg --as mimetype=image/jpeg`);
      await cmd.shouldSucceed(`mkdir -p ${FILES}/inbox/unsorted && mknode -t file ${FILES}/inbox/unsorted/beach.jpg --as mimetype=image/jpeg`);
      let answer: StagingInitAnswer | undefined;
      const events = await eventsDuring(async () => answer = await client.execJson<StagingInitAnswer>('staging init --user anna'));
      assert(events.includes(`moved ${FILES}/inbox/unsorted/beach-2.jpg`), events.join('\n'));
      const [user] = answer!.users;
      assertEquals([user.moved, user.movedTo], [1, `${FILES}/inbox/unsorted`]);
      assertEquals((await client.execJson<string[]>(`ls ${FILES}/inbox/unsorted`)).sort(), ['beach-2.jpg', 'beach.jpg']);
    });

    await t.step('with --idle-minutes, a loose file changed within them stays, and one left alone moves', async () => {
      await cmd.shouldSucceed(`mknode -t file ${FILES}/dune.jpg --as mimetype=image/jpeg`);
      const kept = await client.execJson<StagingInitAnswer>('staging init --user anna --idle-minutes 60');
      assertEquals([kept.users[0].moved, kept.users[0].recent], [0, 1]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${FILES}/dune.jpg`), true);
      const moved = await client.execJson<StagingInitAnswer>('staging init --user anna --idle-minutes 0');
      assertEquals([moved.users[0].moved, moved.users[0].recent], [1, 0]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${FILES}/inbox/unsorted/dune.jpg`), true);
      await cmd.shouldFailWith('staging init --user anna --idle-minutes soon', '--idle-minutes is a number of minutes');
    });

    await t.step('another user may set up only their own staging area', async () => {
      await cmd.shouldSucceed('user-passwd anna --new-password secret1');
      await cmd.shouldSucceed('user-create bertil --uid 3501 && user-passwd bertil --new-password secret1');
      const bertil = await testCtx.server.createShellClient({ username: 'bertil', password: 'secret1' });
      try {
        const asBertil = testCommands(bertil);
        await asBertil.shouldSucceed('staging init');
        await asBertil.shouldFailWith('staging init --user anna', "cannot access staging for 'anna'");
        await asBertil.shouldFailWith('staging init --all', 'administrator');
        assertEquals((await vfs.get(ADMIN_ACCESS, '/home/bertil/staging/files/inbox')).props.uid, 3501);
        assertEquals((await vfs.get(ADMIN_ACCESS, '/home/bertil/staging')).attrs[UNLISTED_ATTR], true);
      } finally {
        bertil.close();
      }
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
