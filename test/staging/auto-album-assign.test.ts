/**
 * `auto-album-assign`: media weighed against the library's albums as staging weighs its groups,
 * and nothing written. A subject is each path (`--per group`), each file (`--per file`) or all of
 * it (`--per set`); `--evidence` adds each candidate's evidence; with `--holdout` a member of an
 * album still finds it, weighed against the album as if it were not in it.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumProfile } from '@archive/media/api';
import type { AlbumMatchReport } from '@archive/staging/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const HOLIDAY = `${ALBUMS_ROOT}/holiday`;

Deno.test({ name: 'auto-album-assign', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const photo = async (dir: string, name: string, at: string) => {
    await vfs.create(ADMIN_ACCESS, 'file', dir, name, { attrs: { mimetype: 'image/jpeg', takenAt: at.slice(0, 19), takenAtUtc: at } });
    return `${dir}/${name}`;
  };
  const profileOf = async () => (await vfs.get<{ albumProfile: AlbumProfile }>(ADMIN_ACCESS, `${HOLIDAY}/.profile`)).attrs.albumProfile;
  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} /incoming`);
    await cmd.shouldSucceed(`mknode -t album ${HOLIDAY} --as name=Holiday && mkdir ${HOLIDAY}/files`);
    await cmd.shouldSucceed(`mknode -t album ${ALBUMS_ROOT}/winter --as name=Winter && mkdir ${ALBUMS_ROOT}/winter/files`);
    const members: string[] = [];
    for (let i = 0; i < 4; i++) members.push(await photo(`${HOLIDAY}/files`, `h-${i}.jpg`, `2026-07-01T1${i}:00:00Z`));
    for (const member of members) await cmd.shouldSucceed(`position-set ${member}/position --lat=57.70 --lng=11.97`);
    await photo(`${ALBUMS_ROOT}/winter/files`, 'w-0.jpg', '2026-01-10T10:00:00Z');
    const inside = await photo('/incoming', 'inside.jpg', '2026-07-01T11:30:00Z');
    await cmd.shouldSucceed(`position-set ${inside}/position --lat=57.70 --lng=11.97`);
    const outside = await photo('/incoming', 'outside.jpg', '2026-07-09T11:00:00Z');
    await cmd.shouldSucceed('album-profile --all');
    const stored = await profileOf();

    await t.step('each file is weighed on its own, and one far from every album gets none', async () => {
      const report = await client.execJson<AlbumMatchReport>(`auto-album-assign ${inside} ${outside} --per file`);
      const [near, far] = report.subjects;
      assertEquals([near.path, near.kind, near.items, near.dated], [inside, 'file', 1, 1]);
      assertEquals(near.candidates[0].album.path, HOLIDAY);
      assertEquals(near.candidates[0].album.title, 'Holiday');
      assert(near.candidates[0].score > 0.8, `${near.candidates[0].score}`);
      assert(near.candidates[0].reasons.some((reason) => reason.startsWith('same places')));
      assertEquals(near.candidates[0].evidence, undefined);
      assertEquals([far.candidates, far.newAlbum, far.confidence], [[], 1, 'low']);
      assertEquals(report.model.length > 0, true);
    });

    await t.step('a directory is one subject, and so is everything with --per set', async () => {
      const group = await client.execJson<AlbumMatchReport>('auto-album-assign /incoming --evidence');
      assertEquals(group.subjects.map((subject) => [subject.path, subject.kind, subject.items]), [['/incoming', 'group', 2]]);
      assert(group.subjects[0].candidates[0].evidence?.time !== undefined);
      const set = await client.execJson<AlbumMatchReport>(`auto-album-assign ${inside} ${outside} --per set --top 1`);
      assertEquals(set.subjects.map((subject) => [subject.kind, subject.items, subject.candidates.length]), [['set', 2, 1]]);
    });

    await t.step('with --holdout a member still finds its album, which nothing writes', async () => {
      const report = await client.execJson<AlbumMatchReport>(`auto-album-assign ${members[1]} --per file --holdout --evidence`);
      assertEquals(report.subjects[0].candidates[0].album.path, HOLIDAY);
      assert(report.subjects[0].candidates[0].evidence!.time! > 0.5);
      assertEquals((await profileOf()).computedAt, stored.computedAt);
      assertEquals((await vfs.children(ADMIN_ACCESS, `${HOLIDAY}/files`)).length, 4);
    });

    await t.step('--root keeps the albums outside it out', async () => {
      const report = await client.execJson<AlbumMatchReport>(`auto-album-assign ${inside} --root ${ALBUMS_ROOT}/winter`);
      assertEquals(report.subjects[0].candidates, []);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
