/**
 * Suggested albums the organizer makes for someone are theirs: owned by their uid and gid, 0700,
 * with their links and covers, so they can list them as themselves, and named only after places
 * they can open. A member they file into the library leaves its group with its member key still
 * exact, which the next run reads as its own.
 */
import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import type { AlbumAddResult, AlbumListResult } from '@archive/media/api';
import type { StagingOrganizeReport } from '@archive/staging/api';
import { type AutoAlbumMeta, memberKeyOf } from '@archive/staging/auto-album';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { readMembers } from './decisions-fixture.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const FILES = '/home/anna/staging/files/inbox';
const ALBUMS = '/home/anna/staging/albums/inbox';

Deno.test({ name: 'suggested albums belong to the inbox owner', sanitizeResources: false, sanitizeOps: false }, async (t) => {
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

    // Two outings months apart, uploaded by Anna Andersson into her own inbox.
    for (const [tag, day, count] of [['spring', '2026-03-01', 5], ['summer', '2026-06-01', 4]] as const) {
      for (let i = 0; i < count; i++) {
        const attrs = captureTime(`${day}T1${i}:00:00Z`) as { takenAt: string; takenAtUtc: string };
        await asAnna.shouldSucceed(
          `mknode -t file ${FILES}/${tag}-${i}.jpg --as mimetype=image/jpeg --as takenAt=${attrs.takenAt} --as takenAtUtc=${attrs.takenAtUtc} --as indexedAt=2026-10-18T00:00:00Z`,
        );
      }
    }
    // Where they were, as the photos' location links say: a pier anyone may open, and a cove only
    // the administrator may.
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/the-pier --as name=Pier`);
    await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/the-cove --as name=Cove && chmod 700 ${LOCATIONS_ROOT}/the-cove`);
    for (const i of [0, 2, 3]) {
      await cmd.shouldSucceed(`ln -s ${LOCATIONS_ROOT}/the-pier ${FILES}/spring-${i}.jpg/location && ln -s ${LOCATIONS_ROOT}/the-cove ${FILES}/summer-${i}.jpg/location`);
    }
    // The organizer runs as the administrator. The spring outing was at a place she can open, which
    // makes it a group of its own; the summer one is an ordinary day of hers, in Everyday.
    await cmd.shouldSucceed('staging organize --user anna');
    const slugs = () => anna.execJson<string[]>(`ls ${ALBUMS}`).then((names) => names.sort());
    const [spring, summer] = await slugs();
    assertEquals([spring, summer], ['2026-03-01', '2026-loose']);
    const home = await vfs.get(ADMIN_ACCESS, '/home/anna');

    await t.step("the albums, their links and their covers are the owner's, and the albums private", async () => {
      for (const slug of [spring, summer]) {
        const album = await vfs.get(ADMIN_ACCESS, `${ALBUMS}/${slug}`);
        assertEquals([album.props.uid, album.props.gid, album.props.mode & 0o777], [3400, home.props.gid, 0o700]);
        const links = await vfs.children(ADMIN_ACCESS, `${ALBUMS}/${slug}`);
        assertEquals(links.length, slug === spring ? 6 : 5); // the members and the cover
        for (const link of links) assertEquals([link.node.props.uid, link.node.props.gid], [3400, home.props.gid]);
      }
    });

    await t.step('an album is named after the location its photos link only when its owner can open it', async () => {
      const attrsOf = async (slug: string) => (await vfs.get<{ name: string; autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${ALBUMS}/${slug}`)).attrs;
      const pier = await attrsOf(spring);
      assertEquals([pier.name.startsWith('Pier · '), pier.autoAlbum.locationPath], [true, `${LOCATIONS_ROOT}/the-pier`]);
      const cove = await attrsOf(summer);
      assertEquals([cove.name, cove.autoAlbum.locationPath], ['Everyday · 2026', undefined]);
    });

    await t.step('a member filed into the library leaves its album with the key of what is left', async () => {
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && mknode -t album ${ALBUMS_ROOT}/holiday && chown 3400 ${ALBUMS_ROOT}/holiday`);
      const filed = await anna.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/holiday ${FILES}/spring-1.jpg`);
      assertEquals(filed.moved.length, 1);

      const left = await readMembers(vfs, `${ALBUMS}/${spring}`);
      assertEquals(left.sort(), [`${FILES}/spring-0.jpg`, `${FILES}/spring-2.jpg`, `${FILES}/spring-3.jpg`, `${FILES}/spring-4.jpg`]);
      const ids = await Promise.all(left.map(async (path) => (await vfs.get(ADMIN_ACCESS, path)).id));
      const meta = (await vfs.get<{ autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${ALBUMS}/${spring}`)).attrs.autoAlbum;
      assertEquals(meta.memberKey, memberKeyOf(ids));
      assertEquals(meta.memberCount, 4);

      // So the next organizer run reads it as its own, not as a person's edit.
      const run = await admin.execJson<StagingOrganizeReport>('staging organize --user anna');
      assertEquals(run.results[0].pinned, 0);
      const kept = run.results[0].groups.find((group) => group.path === `${ALBUMS}/${spring}`);
      assertEquals([kept?.action, kept?.members], ['update', 4]);
    });

    await t.step('the owner lists them', async () => {
      const listed = await anna.execJson<AlbumListResult>(`album list ${ALBUMS}`);
      assertEquals(listed.items.map((item) => item.name).sort(), [spring, summer]);
      assertEquals(listed.items.every((item) => item.origin === 'auto'), true);
    });
  } finally {
    for (const client of clients) client.close();
    await testCtx.teardown();
  }
});
