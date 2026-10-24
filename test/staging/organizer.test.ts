/**
 * `staging organize`: a full build of a category's groups, in which every indexed staged medium is
 * in exactly one group — events, a seed, and the Everyday, clutter, period and undated lanes —
 * while one still indexing is in none. A rerun changes nothing; a pinned group, or one edited by
 * hand, keeps its members; a group already there keeps its path; a dry run writes nothing; the
 * checkpoint is the owner's and `staging status` shows its summary. The photos are invented.
 */
import type { StagingOrganizeReport, StagingStatus } from '@archive/staging/api';
import { type AutoAlbumMeta, COVER_LINK_NAME } from '@archive/staging/auto-album';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type NodeVFS, type ShellClient, testCommands } from '@ein/testing';
import { makeGroup } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const FILES = '/home/admin/staging/files/inbox';
const BATCH = `${FILES}/upload-2019-06-14`;
const SEED = `${BATCH}/Lake weekend`;
const GROUPS = '/home/admin/staging/albums/inbox';

type Photo = { name: string; at?: string; wall?: string; mimetype?: string; indexed?: boolean };

/** Staged files in `dir`, as the media pipeline leaves them once indexed; `at` is the instant, `wall` the wall clock when it differs. */
const stage = async (vfs: NodeVFS, dir: string, photos: Photo[], owner: { uid: number; gid: number }) => {
  await vfs.createTree(
    ADMIN_ACCESS,
    dir,
    photos.map((photo) => ({
      type: 'file',
      name: photo.name,
      props: { uid: owner.uid, gid: owner.gid, mode: 0o640 },
      attrs: {
        mimetype: photo.mimetype ?? 'image/jpeg',
        size: 1000,
        ...(photo.at ? { takenAtUtc: photo.at, takenAt: photo.wall ?? photo.at.replace('Z', '') } : {}),
        ...(photo.indexed === false ? {} : { indexedAt: '2026-10-18T00:00:00Z', facesAt: '2026-10-18T00:00:00Z' }),
      },
    })),
  );
  return photos.map((photo) => `${dir}/${photo.name}`);
};

/** Every group of the inbox: its name, kind and member link targets. */
const groups = async (vfs: NodeVFS) => {
  const entries = await vfs.children<{ name?: string; autoAlbum?: AutoAlbumMeta }>(ADMIN_ACCESS, GROUPS);
  const out = [];
  for (const entry of entries.filter((each) => each.node.type === 'album')) {
    const links = await vfs.children(ADMIN_ACCESS, `${GROUPS}/${entry.name}`);
    out.push({
      slug: entry.name,
      name: entry.node.attrs.name,
      meta: entry.node.attrs.autoAlbum!,
      members: links.filter((link) => link.name !== COVER_LINK_NAME).map((link) => link.node.props.softlink!).sort(),
    });
  }
  return out;
};

Deno.test({ name: 'staging organize', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const organize = async (flags = '') => (await client.execJson<StagingOrganizeReport>(`staging organize --user admin ${flags}`)).results[0];
  try {
    await cmd.shouldSucceed('staging init --user admin');
    await cmd.shouldSucceed(`mkdir -p "${SEED}"`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const owner = { uid: home.props.uid, gid: home.props.gid };

    // Six quiet days of one photo each, a busy Saturday, two screenshots, a scan dated to 1975, a
    // file with no date, a seed folder, and an upload still being indexed.
    const quiet = await stage(vfs, BATCH, Array.from({ length: 6 }, (_, d) => ({ name: `quiet-${d}.jpg`, at: `2019-03-0${d + 1}T12:00:00Z` })), owner);
    const busy = await stage(vfs, BATCH, Array.from({ length: 8 }, (_, i) => ({ name: `busy-${i}.jpg`, at: `2019-05-11T1${i}:00:00Z` })), owner);
    const clutter = await stage(vfs, BATCH, [
      { name: 'Screenshot_20190601-101500.png', at: '2019-06-01T10:15:00Z', mimetype: 'image/png' },
      { name: 'Screenshot_20190602-101500.png', at: '2019-06-02T10:15:00Z', mimetype: 'image/png' },
    ], owner);
    const period = await stage(vfs, BATCH, [{ name: 'scan-1975.jpg', at: '1974-12-31T23:00:00Z', wall: '1975' }], owner);
    const undated = await stage(vfs, BATCH, [{ name: 'no-date.jpg' }], owner);
    const seed = await stage(vfs, SEED, Array.from({ length: 3 }, (_, i) => ({ name: `lake-${i}.jpg`, at: `2019-06-15T1${i}:00:00Z` })), owner);
    const pending = await stage(vfs, BATCH, [{ name: 'arriving.jpg', at: '2019-07-01T12:00:00Z', indexed: false }], owner);
    const indexed = [...quiet, ...busy, ...clutter, ...period, ...undated, ...seed];

    await t.step('a full build puts every indexed medium in exactly one group, and one still indexing in none', async () => {
      const result = await organize();
      assertEquals(result.error, undefined);
      assertEquals([result.items, result.covered, result.pending], [indexed.length, indexed.length, 1]);
      assertEquals(result.byKind, { event: 1, seed: 1, loose: 2, clutter: 1, undated: 1 });
      assertEquals(result.created, 6);
      const all = await groups(vfs);
      const members = all.flatMap((group) => group.members);
      assertEquals(members.sort(), indexed.sort());
      assertEquals(new Set(members).size, members.length);
      assertEquals(members.includes(pending[0]), false);

      const byKey = new Map(all.map((group) => [group.meta.key ?? group.meta.kind, group]));
      assertEquals(byKey.get('loose:2019')?.members, quiet.sort());
      assertEquals(byKey.get('loose:2019')?.name, 'Everyday · 2019');
      assertEquals(byKey.get('clutter:2019')?.name, 'Screenshots and saved images · 2019');
      assertEquals(byKey.get('event')?.members, busy.sort());
      assertEquals(byKey.get('event')?.meta.significance?.reason, 'size');
      assertEquals(byKey.get('event')?.slug, '2019-05-11');
      assertEquals(byKey.get('event')?.name, '11 May 2019');
      const lake = all.find((group) => group.meta.kind === 'seed')!;
      assertEquals([lake.name, lake.slug, lake.members], ['Lake weekend · 15 Jun 2019', 'seed-Lake-weekend', seed.sort()]);
      const year = all.find((group) => group.meta.precision === 'year')!;
      assertEquals([year.name, year.meta.kind, year.members], ['1975 · upload-2019-06-14', 'loose', period]);
      assertEquals(all.find((group) => group.meta.kind === 'undated')?.name, 'Undated · upload-2019-06-14');
    });

    await t.step('the groups and the checkpoint are the owner’s, private; status shows the summary', async () => {
      for (const group of await groups(vfs)) {
        const node = await vfs.get(ADMIN_ACCESS, `${GROUPS}/${group.slug}`);
        assertEquals([node.props.uid, node.props.gid, node.props.mode & 0o777], [owner.uid, owner.gid, 0o700]);
      }
      const checkpoint = await vfs.get(ADMIN_ACCESS, `${GROUPS}/.organizer`);
      assertEquals([checkpoint.props.uid, checkpoint.props.mode & 0o777], [owner.uid, 0o600]);
      const status = await client.execJson<StagingStatus>('staging status');
      const summary = status.categories.find((category) => category.name === 'inbox')!.organizer!;
      assertEquals([summary.mode, summary.groups, summary.members, summary.pending, summary.error], ['full', 6, indexed.length, 1, undefined]);
      assertEquals(summary.byKind.loose, 2);
      // `album list` skips the checkpoint, as it does every dot name.
      const listed = await client.execJson<{ items: { name: string; staging?: { kind?: string; precision?: string } }[] }>(`album list ${GROUPS}`);
      assertEquals(listed.items.length, 6);
      assertEquals(listed.items.find((item) => item.staging?.precision === 'year')?.staging?.kind, 'loose');
    });

    await t.step('a rerun changes nothing: it plans nothing, and planned whole nothing differs', async () => {
      const result = await organize();
      assertEquals([result.mode, result.items, result.created, result.updated, result.removed], ['incremental', 0, 0, 0, 0]);
      const full = await organize('--full');
      assertEquals([full.mode, full.why, full.created, full.updated, full.removed, full.unchanged], ['full', 'asked', 0, 0, 0, 6]);
    });

    await t.step('a group left with no members goes whole, pinned or not, with what a pipeline put in it', async () => {
      await vfs.createTree(ADMIN_ACCESS, GROUPS, [{
        type: 'album',
        name: 'auto-2019-04-01',
        props: { ...owner, mode: 0o700 },
        attrs: { origin: 'auto', name: '1 Apr 2019', autoAlbum: { memberKey: 'b1420a063d4bf934', memberCount: 3, pinned: true } },
        children: [{ type: 'directory', name: 'metadata', props: { ...owner, mode: 0o700 }, children: [{ type: 'file', name: 'stacks', props: { ...owner, mode: 0o600 } }] }],
      }]);
      const result = await organize();
      assertEquals([result.removed, result.pinned], [1, 0]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${GROUPS}/auto-2019-04-01`), false);
    });

    await t.step('a file deleted from a pinned group leaves it; one with every member deleted goes', async () => {
      const kept = await stage(vfs, BATCH, [{ name: 'kept-0.jpg', at: '2019-08-01T10:00:00Z' }, { name: 'kept-1.jpg', at: '2019-08-01T11:00:00Z' }], owner);
      const lost = await stage(vfs, BATCH, [{ name: 'lost-0.jpg', at: '2019-09-01T10:00:00Z' }], owner);
      await makeGroup(vfs, `${GROUPS}/hand-kept`, 'Kept by hand', kept, owner);
      await makeGroup(vfs, `${GROUPS}/hand-lost`, 'Lost by hand', lost, owner);
      for (const slug of ['hand-kept', 'hand-lost']) await cmd.shouldSucceed(`staging pin ${slug}`);
      for (const file of [kept[1], lost[0]]) await vfs.unlink(ADMIN_ACCESS, file, BATCH);
      await organize();
      const after = await groups(vfs);
      assertEquals(after.find((group) => group.slug === 'hand-kept')?.members, [kept[0]]);
      assertEquals(after.some((group) => group.slug === 'hand-lost'), false);
      for (const slug of ['hand-kept']) await cmd.shouldSucceed(`staging pin ${slug} --off`);
      await vfs.unlink(ADMIN_ACCESS, kept[0], BATCH);
      await organize();
      assertEquals((await groups(vfs)).some((group) => group.slug === 'hand-kept'), false);
    });

    await t.step('a dry run plans and writes nothing', async () => {
      await vfs.update(ADMIN_ACCESS, pending[0], { attrs: { indexedAt: '2026-10-18T01:00:00Z', facesAt: '2026-10-18T01:00:00Z' } });
      const before = await groups(vfs);
      const result = await organize('--dry-run');
      assertEquals([result.dryRun, result.mode, result.items, result.updated], [true, 'incremental', 1, 1]);
      assertEquals(await groups(vfs), before);
      assertEquals((await organize()).covered, 1);
      const status = await client.execJson<StagingStatus>('staging status');
      assertEquals(status.categories.find((category) => category.name === 'inbox')!.organizer?.members, indexed.length + 1);
    });

    await t.step('a pinned group keeps its members, and a group edited by hand is pinned', async () => {
      const event = (await groups(vfs)).find((group) => group.meta.kind === 'event')!;
      await cmd.shouldSucceed(`staging pin ${event.slug}`);
      // A photo taken during it arrives: the pin keeps it out.
      const late = await stage(vfs, BATCH, [{ name: 'busy-late.jpg', at: '2019-05-11T13:30:00Z' }], owner);
      let result = await organize();
      assertEquals(result.pinned, 1);
      const after = (await groups(vfs)).find((group) => group.slug === event.slug)!;
      assertEquals(after.members, event.members);
      assert((await groups(vfs)).some((group) => group.members.includes(late[0]) && group.slug !== event.slug));

      // A link added by hand: the key no longer fits the members, so the group is a person's.
      const lane = (await groups(vfs)).find((group) => group.meta.key === 'loose:2019')!;
      await cmd.shouldSucceed(`ln -s ${clutter[0]} ${GROUPS}/${lane.slug}/hand-added.png`);
      result = await organize();
      assertEquals(result.pinned, 2);
      assertEquals((await groups(vfs)).find((group) => group.slug === lane.slug)?.meta.pinned, true);
      // The pinned group holds the hand-added file, so its own lane no longer does: each file is in one group.
      const members = (await groups(vfs)).flatMap((group) => group.members);
      assertEquals(members.filter((member) => member === clutter[0]).length, 1);
      // Taken back out, then unpinned: the lane is the organizer's again.
      await vfs.unlink(ADMIN_ACCESS, `${GROUPS}/${lane.slug}/hand-added.png`, `${GROUPS}/${lane.slug}`, { readlink: true });
      await cmd.shouldSucceed(`staging pin ${lane.slug} --off`);
      assertEquals((await organize()).pinned, 1);
      assertEquals((await groups(vfs)).find((group) => group.meta.key === 'clutter:2019')?.members, clutter.sort());
    });

    await t.step('a group already there with most of a planned group’s members keeps its path and gets the rest', async () => {
      const event = (await groups(vfs)).find((group) => group.meta.kind === 'event')!;
      await cmd.shouldSucceed(`staging pin ${event.slug} --off`);
      // It goes, as a group an older organizer made would have been there instead: links first.
      const links = await vfs.children(ADMIN_ACCESS, `${GROUPS}/${event.slug}`);
      await vfs.unlinkMany(ADMIN_ACCESS, links.map((link) => `${GROUPS}/${event.slug}/${link.name}`));
      await vfs.unlinkMany(ADMIN_ACCESS, [`${GROUPS}/${event.slug}`]);
      await makeGroup(vfs, `${GROUPS}/auto-2019-05-11`, '11 May 2019', busy.slice(0, 6), owner);
      const result = await organize();
      const kept = result.groups.find((group) => group.path === `${GROUPS}/auto-2019-05-11`);
      assertEquals([kept?.action, kept?.members], ['update', 9]);
      assertEquals((await groups(vfs)).filter((group) => group.meta.kind === 'event').map((group) => group.slug), ['auto-2019-05-11']);
    });

    await t.step('a member moved within the category keeps its group as it was; one deleted leaves it rewritten, not pinned', async () => {
      const event = (await groups(vfs)).find((group) => group.meta.kind === 'event')!;
      await cmd.shouldSucceed(`mkdir -p ${BATCH}/sorted && mv ${busy[7]} ${BATCH}/sorted/`);
      let result = await organize();
      const moved = (await groups(vfs)).find((group) => group.slug === event.slug)!;
      assertEquals([result.pinned, result.groups.find((group) => group.path === `${GROUPS}/${event.slug}`)?.action], [0, 'unchanged']);
      assert(moved.members.includes(`${BATCH}/sorted/busy-7.jpg`));
      await cmd.shouldSucceed(`rm ${BATCH}/sorted/busy-7.jpg`);
      result = await organize();
      assertEquals([result.pinned, result.groups.find((group) => group.path === `${GROUPS}/${event.slug}`)?.action], [0, 'update']);
      assertEquals((await groups(vfs)).find((group) => group.slug === event.slug)?.members.length, moved.members.length - 1);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
