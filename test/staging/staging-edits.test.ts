/**
 * The grouping verbs as the inbox's owner makes them, not an administrator: Anna Andersson splits,
 * regroups, merges, deletes, renames and pins her own organizer-made groups, which stay hers and
 * private. A split and a dismissal last through two organizer runs; undoing the split gives the
 * group back, and the next run does not split it again. A lane is not split, merged or deleted; a
 * group that changed since it was read is refused; an edit made while the organizer runs waits
 * for it; two halves merged back side by side stay one without a pin. An administrator names her
 * groups by slug with --user. The photos are invented.
 */
import type { StagingEditResult, StagingJournalPage, StagingOrganizeReport, StagingUndoResult } from '@archive/staging/api';
import { type AutoAlbumMeta, COVER_LINK_NAME } from '@archive/staging/auto-album';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type NodeVFS, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/anna/staging';
const BATCH = `${STAGING}/files/inbox/upload-2019-06-14`;
const GROUPS = `${STAGING}/albums/inbox`;

type Group = { slug: string; path: string; name?: string; meta: AutoAlbumMeta; members: string[] };

/** Every group of Anna's inbox, with its member link targets, by slug. */
const groups = async (vfs: NodeVFS): Promise<Group[]> => {
  const entries = await vfs.children<{ name?: string; autoAlbum?: AutoAlbumMeta }>(ADMIN_ACCESS, GROUPS);
  const out: Group[] = [];
  for (const entry of entries.filter((each) => each.node.type === 'album')) {
    const links = await vfs.children(ADMIN_ACCESS, `${GROUPS}/${entry.name}`);
    out.push({
      slug: entry.name,
      path: `${GROUPS}/${entry.name}`,
      name: entry.node.attrs.name,
      meta: entry.node.attrs.autoAlbum!,
      members: links.filter((link) => link.name !== COVER_LINK_NAME).map((link) => link.node.props.softlink!).sort(),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
};

/** The group holding `file`. */
const holderOf = async (vfs: NodeVFS, file: string): Promise<Group> => (await groups(vfs)).find((group) => group.members.includes(file))!;

/** Every staged file is in exactly one group. */
const assertPartition = async (vfs: NodeVFS, files: string[]) => {
  const members = (await groups(vfs)).flatMap((group) => group.members);
  assertEquals(members.sort(), [...files].sort());
};

Deno.test({ name: 'the grouping verbs, as the inbox owner', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin: ShellClient = await testCtx.server.createShellClient();
  const clients: ShellClient[] = [admin];
  const cmd = testCommands(admin);
  try {
    await cmd.shouldSucceed('user-create anna --uid 3400');
    await cmd.shouldSucceed('user-passwd anna --new-password secret1');
    await cmd.shouldSucceed('staging init --user anna');
    const anna = await testCtx.server.createShellClient({ username: 'anna', password: 'secret1' });
    clients.push(anna);
    const asAnna = testCommands(anna);
    await asAnna.shouldSucceed(`mkdir -p ${BATCH}`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/anna');
    const owner = { uid: home.props.uid, gid: home.props.gid };
    const edit = (line: string) => anna.execJson<StagingEditResult>(`staging ${line}`);
    /** The organizer, as the service runs it: as the administrator. */
    const organize = async () => {
      const [result] = (await admin.execJson<StagingOrganizeReport>('staging organize --user anna')).results;
      assertEquals(result.error, undefined);
      return result;
    };

    // Ten quiet days of one photo each; two busy Saturdays a week apart, the first in two halves of
    // the day; and a third, smaller, Saturday.
    const at = (day: string, hour: number, minute = 0) => `2019-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    const photos: { name: string; at: string }[] = [
      ...Array.from({ length: 10 }, (_, d) => ({ name: `quiet-${d}.jpg`, at: at(`03-${String(d + 1).padStart(2, '0')}`, 12) })),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `party-${String(i).padStart(2, '0')}.jpg`, at: at('05-11', 8 + Math.floor(i / 6) * 2, (i % 6) * 10) })),
      ...Array.from({ length: 8 }, (_, i) => ({ name: `market-${i}.jpg`, at: at('05-18', 9, i * 10) })),
      ...Array.from({ length: 6 }, (_, i) => ({ name: `walk-${i}.jpg`, at: at('05-25', 14, i * 10) })),
    ];
    await vfs.createTree(
      ADMIN_ACCESS,
      BATCH,
      photos.map((photo) => ({
        type: 'file',
        name: photo.name,
        props: { uid: owner.uid, gid: owner.gid, mode: 0o640 },
        attrs: {
          mimetype: 'image/jpeg',
          size: 1000,
          takenAt: photo.at.replace('Z', ''),
          takenAtUtc: photo.at,
          indexedAt: '2026-10-18T00:00:00Z',
          facesAt: '2026-10-18T00:00:00Z',
        },
      })),
    );
    const files = photos.map((photo) => `${BATCH}/${photo.name}`);
    const party = files.filter((file) => file.includes('/party-'));
    const market = files.filter((file) => file.includes('/market-'));
    const walk = files.filter((file) => file.includes('/walk-'));
    const quiet = files.filter((file) => file.includes('/quiet-'));
    await organize();

    await t.step("the organizer's groups are hers, private, and every photo is in one", async () => {
      await assertPartition(vfs, files);
      for (const group of await groups(vfs)) {
        const node = await vfs.get(ADMIN_ACCESS, group.path);
        assertEquals([node.props.uid, node.props.gid, node.props.mode & 0o777], [owner.uid, owner.gid, 0o700]);
      }
      assertEquals((await holderOf(vfs, party[0])).members, party);
      assertEquals((await holderOf(vfs, quiet[0])).meta.key, 'loose:2019');
    });

    let splitEntry = '';
    await t.step('she splits the party where its afternoon begins, and the split lasts through two runs', async () => {
      const group = await holderOf(vfs, party[0]);
      const result = await edit(`split ${group.slug} --at ${party[6]} --expect ${group.meta.memberKey}`);
      assertEquals([result.groupsCreated.length, result.groupsChanged, result.changed], [1, [group.path], []]);
      splitEntry = result.journal!;
      const created = await vfs.get(ADMIN_ACCESS, result.groupsCreated[0]);
      assertEquals([created.props.uid, created.props.mode & 0o777], [owner.uid, 0o700]);
      for (let run = 0; run < 2; run++) {
        await organize();
        assertEquals((await holderOf(vfs, party[0])).members, party.slice(0, 6));
        assertEquals((await holderOf(vfs, party[6])).members, party.slice(6));
        await assertPartition(vfs, files);
      }
    });

    await t.step('she says the market is not a group: its photos go to Everyday, and stay there through two runs', async () => {
      const group = await holderOf(vfs, market[0]);
      assertEquals(group.meta.kind, 'event');
      const result = await edit(`delete ${group.slug}`);
      assertEquals(result.groupsRemoved, [group.path]);
      assertEquals((await holderOf(vfs, market[0])).meta.key, 'loose:2019');
      for (let run = 0; run < 2; run++) {
        await organize();
        assertEquals((await holderOf(vfs, market[0])).meta.key, 'loose:2019');
        await assertPartition(vfs, files);
      }
    });

    await t.step('undoing the split gives the party back whole, and the next run does not split it again', async () => {
      const undone = await anna.execJson<StagingUndoResult>(`staging undo ${splitEntry}`);
      assertEquals(undone.undone, [splitEntry]);
      assertEquals((await holderOf(vfs, party[0])).members, party);
      await assertPartition(vfs, files);
      await organize();
      assertEquals((await holderOf(vfs, party[0])).members, party);
    });

    await t.step('she moves a quiet day into the walk, and it stays with it', async () => {
      const walkGroup = await holderOf(vfs, walk[0]);
      const result = await edit(`regroup ${walkGroup.slug} ${quiet[9]}`);
      assertEquals(result.groupsChanged.includes(walkGroup.path), true);
      assertEquals((await holderOf(vfs, quiet[9])).slug, walkGroup.slug);
      await organize();
      assertEquals((await holderOf(vfs, quiet[9])).members, [...walk, quiet[9]].sort());
      await assertPartition(vfs, files);
    });

    await t.step('she lifts a quiet day out of Everyday as a group of its own, which lasts', async () => {
      const result = await edit(`regroup --new --name 'First swim' ${quiet[2]}`);
      assertEquals(result.groupsCreated.length, 1);
      const group = await holderOf(vfs, quiet[2]);
      assertEquals([group.name, group.members, group.meta.pinned, group.meta.nameLocked], ['First swim', [quiet[2]], undefined, true]);
      await organize();
      const after = await holderOf(vfs, quiet[2]);
      assertEquals([after.slug, after.name, after.members], [group.slug, 'First swim', [quiet[2]]]);
      await assertPartition(vfs, files);
    });

    await t.step('she merges the party and the walk, two weeks apart: one group, pinned, through a run', async () => {
      const [partyGroup, walkGroup] = [await holderOf(vfs, party[0]), await holderOf(vfs, walk[0])];
      const result = await edit(`merge ${partyGroup.slug} ${walkGroup.slug} --name 'Two Saturdays'`);
      assertEquals(result.groupsRemoved, [walkGroup.path]);
      const merged = await holderOf(vfs, walk[0]);
      assertEquals([merged.slug, merged.name, merged.meta.pinned, merged.members.length], [partyGroup.slug, 'Two Saturdays', true, party.length + walk.length + 1]);
      await organize();
      assertEquals((await holderOf(vfs, party[0])).members.length, party.length + walk.length + 1);
      await assertPartition(vfs, files);
      // Undone, both come back as they were.
      await anna.execJson<StagingUndoResult>(`staging undo ${result.journal}`);
      assertEquals((await holderOf(vfs, party[0])).members, party);
      assertEquals((await holderOf(vfs, walk[0])).members, [...walk, quiet[9]].sort());
    });

    await t.step('a merged group unpinned is the organizer’s again: the next run gives the walk back its own group', async () => {
      const [partyGroup, walkGroup] = [await holderOf(vfs, party[0]), await holderOf(vfs, walk[0])];
      const result = await edit(`merge ${partyGroup.slug} ${walkGroup.slug} --name 'Two Saturdays'`);
      const merged = await holderOf(vfs, walk[0]);
      assertEquals(merged.meta.pinned, true);
      // Its members changed while it was pinned, so its key no longer says what it holds.
      await vfs.update(ADMIN_ACCESS, merged.path, { attrs: { autoAlbum: { ...merged.meta, memberKey: '0000000000000000' } } });
      await edit(`pin ${merged.slug} --off`);
      assertEquals((await organize()).pinned, 0);
      assertEquals((await holderOf(vfs, party[0])).members, party);
      assertEquals((await holderOf(vfs, walk[0])).members, [...walk, quiet[9]].sort());
      await assertPartition(vfs, files);
      assertEquals(result.ok, true);
    });

    await t.step('she renames a group: the name lasts, its members stay the organizer’s; a pin holds both', async () => {
      const group = await holderOf(vfs, party[0]);
      await edit(`rename ${group.slug} 'Garden party'`);
      await organize();
      const renamed = await holderOf(vfs, party[0]);
      assertEquals([renamed.name, renamed.meta.nameLocked, renamed.meta.pinned], ['Garden party', true, undefined]);
      const pinned = await edit(`pin ${group.slug}`);
      assertEquals((await holderOf(vfs, party[0])).meta.pinned, true);
      await anna.execJson<StagingUndoResult>(`staging undo ${pinned.journal}`);
      assertEquals((await holderOf(vfs, party[0])).meta.pinned, undefined);
    });

    await t.step('an administrator names her group by slug with --user; she cannot name another inbox', async () => {
      const group = await holderOf(vfs, party[0]);
      await admin.execJson<StagingEditResult>(`staging pin ${group.slug} --user anna`);
      assertEquals((await holderOf(vfs, party[0])).meta.pinned, true);
      await admin.execJson<StagingEditResult>(`staging pin ${group.slug} --off --user anna`);
      assertEquals((await holderOf(vfs, party[0])).meta.pinned, false);
      await asAnna.shouldFailWith(`staging pin ${group.slug} --user admin`, 'cannot pin this staging album');
    });

    await t.step('a lane is not split, merged or deleted; a changed group is refused', async () => {
      const lane = await holderOf(vfs, quiet[0]);
      await asAnna.shouldFailWith(`staging delete ${lane.slug}`, 'a lane is not deleted');
      await asAnna.shouldFailWith(`staging split ${lane.slug} --at ${quiet[1]}`, 'a lane is not split');
      const party = await holderOf(vfs, `${BATCH}/party-00.jpg`);
      const refused = await edit(`split ${party.slug} --at ${BATCH}/party-06.jpg --expect 0000000000000000`);
      assertEquals([refused.journal, refused.changed], [null, [party.path]]);
    });

    await t.step('her journal lists the edits, and they count as neither filed nor discarded', async () => {
      const page = await anna.execJson<StagingJournalPage>('staging journal inbox --action edit');
      assert(page.entries.length >= 7);
      assertEquals(page.entries.find((entry) => entry.id === splitEntry)?.edit?.op, 'cut');
      assertEquals(page.totals, { filed: 0, discarded: 0 });
    });

    await t.step('an edit made while the organizer runs waits for it', async () => {
      const group = await holderOf(vfs, `${BATCH}/party-00.jpg`);
      const [, split] = await Promise.all([organize(), edit(`split ${group.slug} --at ${BATCH}/party-06.jpg`)]);
      assertEquals(split.groupsCreated.length, 1);
      await assertPartition(vfs, files);
      await organize();
      await assertPartition(vfs, files);
    });

    await t.step('merged back side by side, the halves stay one group without a pin', async () => {
      const [morning, afternoon] = [await holderOf(vfs, `${BATCH}/party-00.jpg`), await holderOf(vfs, `${BATCH}/party-06.jpg`)];
      assert(morning.slug !== afternoon.slug);
      await edit(`merge ${morning.slug} ${afternoon.slug}`);
      for (let run = 0; run < 2; run++) {
        await organize();
        const whole = await holderOf(vfs, `${BATCH}/party-00.jpg`);
        assertEquals([whole.members.length, whole.meta.pinned], [12, undefined]);
      }
      await assertPartition(vfs, files);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
