/**
 * `album-profile`: a library album's profile, beside it as `.profile`, summarises its members'
 * times, days, places and people, and names up to four of their picture vectors as prototypes.
 *
 * Pinned here: the contents and their caps (at most 24 KB, every active day kept); prototypes are
 * members' own embedding ids; a build with the members as they were writes nothing; staging's
 * suggested groups are passed over; the album's listings leave `.profile` out; a member added
 * rewrites that album's profile alone, with the day it changed; `--all --stale` builds only what is
 * missing.
 */
import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { AlbumListResult, AlbumProfile, AlbumProfileResult } from '@archive/media/api';
import type { ContainerListing } from '@ein/client';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const DIM = 8;
const LAKE = `${ALBUMS_ROOT}/lake-2019`;
const DIARY = `${ALBUMS_ROOT}/diary`;

Deno.test({ name: 'album-profile', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
  const profileOf = async (album: string) => (await vfs.get<{ albumProfile: AlbumProfile }>(ADMIN_ACCESS, `${album}/.profile`)).attrs.albumProfile;

  /** A photo in `album`'s `files/`, taken at `at` (UTC), with a picture vector near `axis`. */
  const photo = async (album: string, name: string, at: string, axis: number) => {
    const path = `${album}/files/${name}`;
    await vfs.create(ADMIN_ACCESS, 'file', `${album}/files`, name, { attrs: { mimetype: 'image/jpeg', takenAt: at.slice(0, 19), takenAtUtc: at } });
    await vfs.create(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.create(ADMIN_ACCESS, 'directory', `${path}/metadata`, 'picture');
    await vfs.create(ADMIN_ACCESS, 'embedding', `${path}/metadata/picture`, 'embedding', { attrs: { embeddingType: 'picture_test', capacity: DIM } });
    const vector = Array.from({ length: DIM }, (_, i) => i === axis ? 1 : 0.05 * ((name.length + i) % 3));
    const handle = await vfs.open(ADMIN_ACCESS, `${path}/metadata/picture/embedding`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
    return path;
  };

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} ${PEOPLE_ROOT}`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna-andersson --name 'Anna Andersson'`);
    const anna = await idOf(`${PEOPLE_ROOT}/anna-andersson`);
    await cmd.shouldSucceed(`mknode -t album ${LAKE} --as name='Lake trip 2019' && mkdir ${LAKE}/files`);
    const lake: string[] = [];
    for (let i = 0; i < 6; i++) lake.push(await photo(LAKE, `lake-${i}.jpg`, `2019-06-${14 + (i >> 1)}T10:0${i}:00Z`, i % 2));
    await cmd.shouldSucceed(`position-set ${lake[0]}/position --lat=59.301 --lng=18.102`);
    await cmd.shouldSucceed(`mkdir ${lake[1]}/regions && mknode -t media-region ${lake[1]}/regions/face-0 --as personId=${anna}`);

    await t.step("a profile summarises the album's members, and names prototypes among their vectors", async () => {
      const result = await client.execJson<AlbumProfileResult>(`album-profile ${LAKE}`);
      assertEquals([result.albums, result.written, result.unchanged, result.skipped, result.failed], [1, 1, 0, 0, []]);
      const profile = await profileOf(LAKE);
      assertEquals([profile.version, profile.members, profile.dated, profile.activeDays, profile.spanDays], [1, 6, 6, 3, 3]);
      assertEquals(profile.days, [['2019-06-14', 2], ['2019-06-15', 2], ['2019-06-16', 2]]);
      assertEquals(profile.times.length, 6);
      assertEquals(profile.times[0], Date.parse('2019-06-14T10:00:00Z') / 60_000);
      assertEquals(profile.cells, [['5930:1810', 1]]);
      assertEquals(profile.people, [[anna, 1]]);
      assertEquals(profile.pictureType, 'picture_test');
      assertEquals(profile.prototypes.length, 1);
      const vectorIds = await Promise.all(lake.map((path) => idOf(`${path}/metadata/picture/embedding`)));
      assert(vectorIds.includes(profile.prototypes[0]), 'a prototype is a member vector');
      assertEquals(profile.changedDays, ['2019-06-14', '2019-06-15', '2019-06-16']);
      const node = await vfs.get(ADMIN_ACCESS, `${LAKE}/.profile`);
      const album = await vfs.get(ADMIN_ACCESS, LAKE);
      assertEquals([node.type, node.props.uid, node.props.mode], ['album-profile', album.props.uid, album.props.mode & 0o666]);
    });

    await t.step('a build with the members as they were writes nothing', async () => {
      const before = await profileOf(LAKE);
      const result = await client.execJson<AlbumProfileResult>(`album-profile ${LAKE}`);
      assertEquals([result.written, result.unchanged], [0, 1]);
      assertEquals((await profileOf(LAKE)).computedAt, before.computedAt);
    });

    await t.step("staging's suggested groups and what is not an album of the library are passed over", async () => {
      await cmd.shouldSucceed('staging init --user admin');
      await cmd.shouldSucceed(`mknode -t album /home/admin/staging/albums/inbox/2019-06-14 --as origin=auto`);
      const result = await client.execJson<AlbumProfileResult>(`album-profile /home/admin/staging/albums/inbox/2019-06-14 ${LAKE}/files`);
      assertEquals([result.albums, result.skipped], [0, 2]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/staging/albums/inbox/2019-06-14/.profile'), false);
    });

    await t.step("the album's listings leave its profile out", async () => {
      const listing = await client.execJson<ContainerListing>(`members-album ${LAKE}`);
      assertEquals(listing.members.length, 6);
      const listed = await client.execJson<AlbumListResult>(`album list ${ALBUMS_ROOT}`);
      assertEquals(listed.items.map((item) => item.name), ['lake-2019']);
    });

    await t.step("a member added rewrites that album's profile alone, with the day it changed", async () => {
      await cmd.shouldSucceed(`mknode -t album ${DIARY} --as name='Diary' && mkdir ${DIARY}/files`);
      await photo(DIARY, 'note.jpg', '2018-01-02T09:00:00Z', 3);
      await cmd.shouldSucceed(`album-profile ${DIARY}`);
      const diaryBefore = await profileOf(DIARY);
      await photo(LAKE, 'lake-6.jpg', '2019-06-17T10:00:00Z', 2);
      const result = await client.execJson<AlbumProfileResult>(`album-profile ${LAKE} ${DIARY}`);
      assertEquals([result.written, result.unchanged], [1, 1]);
      assertEquals((await profileOf(LAKE)).changedDays, ['2019-06-17']);
      assertEquals((await profileOf(DIARY)).computedAt, diaryBefore.computedAt);
    });

    await t.step('--all --stale builds only the profiles that are missing', async () => {
      await cmd.shouldSucceed(`mknode -t album ${ALBUMS_ROOT}/empty --as name=Empty`);
      const result = await client.execJson<AlbumProfileResult>('album-profile --all --stale');
      assertEquals([result.albums, result.written, result.skipped], [1, 1, 2]);
      assertEquals((await profileOf(`${ALBUMS_ROOT}/empty`)).members, 0);
    });

    await t.step('a long album keeps every active day and stays within 24 KB', async () => {
      const long = `${ALBUMS_ROOT}/years`;
      await cmd.shouldSucceed(`mknode -t album ${long} --as name=Years && mkdir ${long}/files`);
      const start = Date.parse('2010-01-01T12:00:00Z');
      await vfs.createTree(
        ADMIN_ACCESS,
        `${long}/files`,
        Array.from({ length: 1500 }, (_, i) => {
          const at = new Date(start + Math.floor(i / 4) * 86_400_000 + (i % 4) * 3_600_000).toISOString().replace('.000', '');
          return { type: 'file', name: `y-${i}.jpg`, attrs: { mimetype: 'image/jpeg', takenAt: at.slice(0, 19), takenAtUtc: at } };
        }),
      );
      await cmd.shouldSucceed(`album-profile ${long}`);
      const profile = await profileOf(long);
      assertEquals([profile.members, profile.activeDays, profile.days.length], [1500, 375, 375]);
      assertEquals(profile.times.length, 1024);
      const firstOfEachDay = new Set(profile.times.map((minute) => new Date(minute * 60_000).toISOString().slice(0, 10)));
      assertEquals(firstOfEachDay.size, 375);
      assert(JSON.stringify(profile).length <= 24 * 1024, `${JSON.stringify(profile).length} bytes`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
