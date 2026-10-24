/**
 * `album-cover`: the random cover an album without one gets. Covers the two
 * album layouts, softlink members, the image-over-video preference, a stack
 * front over its folded members, a dangling link, an explicit cover left
 * alone, and `--all`, which leaves the staging suggestions out.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type CoverResult = {
  scanned: number;
  updated: number;
  skipped: number;
  albums: { path: string; cover: string }[];
};

Deno.test({
  name: 'album cover',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, {
      props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: target },
    });

  const mkmedia = async (path: string, mimetype = 'image/jpeg') => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype } });
  };

  const mkalbum = (name: string) => vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, name, { props: { mode: 0o755 }, attrs: { name } });

  const coverOf = async (album: string): Promise<string | undefined> => {
    try {
      const link = await vfs.get(ADMIN_ACCESS, `${album}/coverPhoto`, { readlink: true });
      return link.props.softlink;
    } catch {
      return undefined;
    }
  };

  /** Run enough times to see every member of a pool of the given size chosen at least once. */
  const drawCovers = async (album: string, draws: number): Promise<Set<string>> => {
    const seen = new Set<string>();
    for (let i = 0; i < draws; i++) {
      await cmd.shouldSucceed(`rm ${album}/coverPhoto`);
      const result = await client.execJson<CoverResult>(`album-cover ${album}`);
      assertEquals(result.updated, 1);
      seen.add(result.albums[0].cover);
    }
    return seen;
  };

  try {
    // Test-mode boot leaves the tree bare; the album root is the primary boot's job.
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);

    await t.step("picks one of a flat album's own pictures, and not always the first", async () => {
      await mkalbum('flat');
      await mkmedia(`${ALBUMS_ROOT}/flat/a.jpg`);
      await mkmedia(`${ALBUMS_ROOT}/flat/b.jpg`);
      await mkmedia(`${ALBUMS_ROOT}/flat/c.jpg`);

      const result = await client.execJson<CoverResult>(`album-cover ${ALBUMS_ROOT}/flat`);
      assertEquals(result.updated, 1);
      assertEquals(result.albums[0].path, `${ALBUMS_ROOT}/flat`);
      assertEquals(result.albums[0].cover, await coverOf(`${ALBUMS_ROOT}/flat`));

      // Three members and forty draws: the odds of never leaving `a.jpg` are (1/3)^40.
      const seen = await drawCovers(`${ALBUMS_ROOT}/flat`, 40);
      assertEquals(seen, new Set([`${ALBUMS_ROOT}/flat/a.jpg`, `${ALBUMS_ROOT}/flat/b.jpg`, `${ALBUMS_ROOT}/flat/c.jpg`]));
    });

    await t.step('an album that has a cover is left alone', async () => {
      const before = await coverOf(`${ALBUMS_ROOT}/flat`);
      const result = await client.execJson<CoverResult>(`album-cover ${ALBUMS_ROOT}/flat`);
      assertEquals(result, { scanned: 1, updated: 0, skipped: 1, albums: [] });
      assertEquals(await coverOf(`${ALBUMS_ROOT}/flat`), before);
    });

    await t.step('the link is owned like the album, not like the caller', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'owned', { props: { uid: 42, gid: 43, mode: 0o755 }, attrs: { name: 'owned' } });
      await mkmedia(`${ALBUMS_ROOT}/owned/a.jpg`);
      await cmd.shouldSucceed(`album-cover ${ALBUMS_ROOT}/owned`);
      const link = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/owned/coverPhoto`, { readlink: true });
      assertEquals([link.props.uid, link.props.gid], [42, 43]);
    });

    await t.step('descends into a lone files/ child', async () => {
      await mkalbum('imported');
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/imported/files`);
      await mkmedia(`${ALBUMS_ROOT}/imported/files/b.jpg`);

      await cmd.shouldSucceed(`album-cover ${ALBUMS_ROOT}/imported`);
      assertEquals(await coverOf(`${ALBUMS_ROOT}/imported`), `${ALBUMS_ROOT}/imported/files/b.jpg`);
    });

    await t.step('a softlink member is chosen by its target, never by the link', async () => {
      await mkalbum('linked');
      await mklink(`${ALBUMS_ROOT}/linked`, 'm0', `${ALBUMS_ROOT}/flat/a.jpg`);

      await cmd.shouldSucceed(`album-cover ${ALBUMS_ROOT}/linked`);
      assertEquals(await coverOf(`${ALBUMS_ROOT}/linked`), `${ALBUMS_ROOT}/flat/a.jpg`);
    });

    await t.step('a picture beats a video, which beats a recording', async () => {
      await mkalbum('mixed');
      await mkmedia(`${ALBUMS_ROOT}/mixed/talk.mp3`, 'audio/mpeg');
      await mkmedia(`${ALBUMS_ROOT}/mixed/clip.mp4`, 'video/mp4');
      await cmd.shouldSucceed(`album-cover ${ALBUMS_ROOT}/mixed`);
      assertEquals(await coverOf(`${ALBUMS_ROOT}/mixed`), `${ALBUMS_ROOT}/mixed/clip.mp4`);

      await mkmedia(`${ALBUMS_ROOT}/mixed/still.jpg`);
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/mixed/coverPhoto`);
      await cmd.shouldSucceed(`album-cover ${ALBUMS_ROOT}/mixed`);
      assertEquals(await coverOf(`${ALBUMS_ROOT}/mixed`), `${ALBUMS_ROOT}/mixed/still.jpg`);
    });

    await t.step('a stack contributes only its front', async () => {
      const a = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat/a.jpg`);
      const b = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat/b.jpg`);
      const c = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat/c.jpg`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat`, {
        attrs: {
          mediaStacks: {
            version: 1,
            threshold: 0.85,
            maxGapSeconds: 10,
            sourceSignature: 'cover-test',
            computedAt: '2026-09-18T00:00:00Z',
            excludedIds: [],
            groups: [{ frontId: b.id, memberIds: [a.id, b.id, c.id] }],
          },
        },
      });
      const seen = await drawCovers(`${ALBUMS_ROOT}/flat`, 10);
      assertEquals(seen, new Set([`${ALBUMS_ROOT}/flat/b.jpg`]));
    });

    await t.step('a dangling cover is replaced', async () => {
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/linked/coverPhoto`);
      await mklink(`${ALBUMS_ROOT}/linked`, 'coverPhoto', `${ALBUMS_ROOT}/flat/gone.jpg`);
      const result = await client.execJson<CoverResult>(`album-cover ${ALBUMS_ROOT}/linked`);
      assertEquals(result.updated, 1);
      assertEquals(await coverOf(`${ALBUMS_ROOT}/linked`), `${ALBUMS_ROOT}/flat/a.jpg`);
    });

    await t.step('an empty album gets nothing', async () => {
      await mkalbum('empty');
      const result = await client.execJson<CoverResult>(`album-cover ${ALBUMS_ROOT}/empty`);
      assertEquals(result, { scanned: 1, updated: 0, skipped: 1, albums: [] });
      assertEquals(await coverOf(`${ALBUMS_ROOT}/empty`), undefined);
    });

    await t.step('--all covers every album that lacks one, but a suggestion', async () => {
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/flat/coverPhoto`);
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/imported/coverPhoto`);
      // A staging suggestion without a cover: the organizer picks a suggestion's, not the sweep.
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'suggested', { props: { mode: 0o755 }, attrs: { name: 'suggested', origin: 'auto' } });
      await mklink(`${ALBUMS_ROOT}/suggested`, 'a.jpg', `${ALBUMS_ROOT}/flat/a.jpg`);
      const result = await client.execJson<CoverResult>(`album-cover --all --stale`);
      assertEquals(result.updated, 2);
      assertEquals(new Set(result.albums.map((album) => album.path)), new Set([`${ALBUMS_ROOT}/flat`, `${ALBUMS_ROOT}/imported`]));
      assert(await coverOf(`${ALBUMS_ROOT}/flat`));
      assert(await coverOf(`${ALBUMS_ROOT}/imported`));
      assertEquals(await coverOf(`${ALBUMS_ROOT}/suggested`), undefined);
    });

    await t.step('refuses to run with neither a path nor --all', async () => {
      await cmd.shouldFail('album-cover');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
