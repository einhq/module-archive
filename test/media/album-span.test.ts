/**
 * `album-span`: the denormalized time span that lets albums be ordered by time
 * without listing any of them. Covers the two album layouts, softlink members,
 * auto albums, `--all`/`--stale` (which leave the suggestions out), and albums with nothing
 * dated.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type SpanResult = {
  scanned: number;
  updated: number;
  skipped: number;
  albums: { path: string; timeStart?: string; timeEnd?: string; mediaCount: number }[];
};

Deno.test({
  name: 'album span',
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

  const mkmedia = async (path: string, attrs: Record<string, unknown>) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...attrs } });
  };

  const mkalbum = (name: string, attrs: Record<string, unknown> = {}) => vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, name, { props: { mode: 0o755 }, attrs });

  const spanOf = async (path: string) => {
    const attrs = await client.execJson<Record<string, unknown>>(`attrs ${path}`);
    return { timeStart: attrs.timeStart, timeEnd: attrs.timeEnd, mediaCount: attrs.mediaCount };
  };

  try {
    // Test-mode boot leaves the tree bare; the album root is the primary boot's job.
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);

    await t.step('spans a flat album from its earliest and latest dated media', async () => {
      await mkalbum('flat');
      await mkmedia(`${ALBUMS_ROOT}/flat/a1995.jpg`, { ...captureTime('1995-06-01T10:00:00') });
      await mkmedia(`${ALBUMS_ROOT}/flat/c2001.jpg`, { ...captureTime('2001-01-01T00:00:00') });
      await mkmedia(`${ALBUMS_ROOT}/flat/undated.jpg`, {});

      const result = await client.execJson<SpanResult>(`album-span ${ALBUMS_ROOT}/flat`);
      assertEquals(result.updated, 1);
      // Undated media still count as members; they just cannot bound the span.
      assertEquals(await spanOf(`${ALBUMS_ROOT}/flat`), {
        timeStart: '1995-06-01T10:00:00',
        timeEnd: '2001-01-01T00:00:00',
        mediaCount: 3,
      });
    });

    await t.step('descends into a lone files/ child', async () => {
      await mkalbum('imported');
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/imported/files`);
      await mkmedia(`${ALBUMS_ROOT}/imported/files/b1998.jpg`, { ...captureTime('1998-03-12T08:30:00') });
      await mkmedia(`${ALBUMS_ROOT}/imported/files/d2010.jpg`, { ...captureTime('2010-05-05T12:00:00') });

      await cmd.shouldSucceed(`album-span ${ALBUMS_ROOT}/imported`);
      assertEquals(await spanOf(`${ALBUMS_ROOT}/imported`), {
        timeStart: '1998-03-12T08:30:00',
        timeEnd: '2010-05-05T12:00:00',
        mediaCount: 2,
      });
    });

    await t.step('stacked photos still all contribute to the span and mediaCount', async () => {
      const first = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat/a1995.jpg`);
      const second = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat/c2001.jpg`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/flat`, {
        attrs: {
          mediaStacks: {
            version: 1,
            threshold: 0.85,
            maxGapSeconds: 10,
            sourceSignature: 'span-test',
            computedAt: '2026-08-30T00:00:00Z',
            excludedIds: [],
            groups: [{ frontId: first.id, memberIds: [first.id, second.id] }],
          },
        },
      });
      await cmd.shouldSucceed(`album-span ${ALBUMS_ROOT}/flat`);
      assertEquals(await spanOf(`${ALBUMS_ROOT}/flat`), {
        timeStart: '1995-06-01T10:00:00',
        timeEnd: '2001-01-01T00:00:00',
        mediaCount: 3,
      });
    });

    await t.step('follows softlink members and ignores the cover', async () => {
      await mkalbum('linked');
      await mklink(`${ALBUMS_ROOT}/linked`, 'm0', `${ALBUMS_ROOT}/flat/a1995.jpg`);
      await mklink(`${ALBUMS_ROOT}/linked`, 'm1', `${ALBUMS_ROOT}/imported/files/d2010.jpg`);
      await mklink(`${ALBUMS_ROOT}/linked`, 'coverPhoto', `${ALBUMS_ROOT}/flat/c2001.jpg`);

      await cmd.shouldSucceed(`album-span ${ALBUMS_ROOT}/linked`);
      assertEquals(await spanOf(`${ALBUMS_ROOT}/linked`), {
        timeStart: '1995-06-01T10:00:00',
        timeEnd: '2010-05-05T12:00:00',
        mediaCount: 2,
      });
    });

    await t.step('a garbage capture date does not drag the span to the year zero', async () => {
      // A stored capture time of 0000-00-00 is no date at all.
      await mkalbum('zeroed');
      await mkmedia(`${ALBUMS_ROOT}/zeroed/broken.jpg`, { ...captureTime('0000-00-00T00:00:00') });
      await mkmedia(`${ALBUMS_ROOT}/zeroed/good.jpg`, { ...captureTime('2015-07-25T12:00:00') });

      await cmd.shouldSucceed(`album-span ${ALBUMS_ROOT}/zeroed`);
      assertEquals(await spanOf(`${ALBUMS_ROOT}/zeroed`), {
        timeStart: '2015-07-25T12:00:00',
        timeEnd: '2015-07-25T12:00:00',
        // The file is still a member; only the span ignores its date.
        mediaCount: 2,
      });
    });

    await t.step('an album with nothing dated gets no span, only a count', async () => {
      await mkalbum('undated');
      await mkmedia(`${ALBUMS_ROOT}/undated/x.jpg`, {});

      await cmd.shouldSucceed(`album-span ${ALBUMS_ROOT}/undated`);
      // Written as null, which removes the attr — so the album is invisible to
      // any time-ordered query rather than sorting as an empty string.
      assertEquals(await spanOf(`${ALBUMS_ROOT}/undated`), { timeStart: undefined, timeEnd: undefined, mediaCount: 1 });
    });

    await t.step("spans an auto album from its members, not the clusterer's record", async () => {
      // The stored cluster span is the members' times before a retime.
      await mkalbum('autoish', {
        origin: 'auto',
        autoAlbum: { timeStart: '2019-06-02T09:00:00', timeEnd: '2019-06-09T18:00:00', memberCount: 84 },
      });
      await cmd.shouldSucceed('mkdir -p /loose');
      await mkmedia('/loose/r2019.jpg', { ...captureTime('2019-07-04T12:00:00') });
      await mklink(`${ALBUMS_ROOT}/autoish`, 'r2019.jpg', '/loose/r2019.jpg');

      await cmd.shouldSucceed(`album-span ${ALBUMS_ROOT}/autoish`);
      assertEquals(await spanOf(`${ALBUMS_ROOT}/autoish`), {
        timeStart: '2019-07-04T12:00:00',
        timeEnd: '2019-07-04T12:00:00',
        mediaCount: 1,
      });
    });

    await t.step('rewrites a span that has gone stale', async () => {
      await mkmedia(`${ALBUMS_ROOT}/flat/e2020.jpg`, { ...captureTime('2020-02-02T00:00:00') });

      const result = await client.execJson<SpanResult>(`album-span ${ALBUMS_ROOT}/flat`);
      assertEquals(result.updated, 1);
      assertEquals((await spanOf(`${ALBUMS_ROOT}/flat`)).timeEnd, '2020-02-02T00:00:00');
    });

    await t.step('a second run over an unchanged album writes nothing', async () => {
      const result = await client.execJson<SpanResult>(`album-span ${ALBUMS_ROOT}/flat`);
      assertEquals(result.updated, 0);
      assertEquals(result.skipped, 1);
    });

    await t.step('--all walks every album but the suggestions, --stale skips the ones already done', async () => {
      await mkalbum('fresh');
      await mkmedia(`${ALBUMS_ROOT}/fresh/f2022.jpg`, { ...captureTime('2022-07-07T00:00:00') });
      // A staging suggestion without a span yet: `media-album` keeps a suggestion's span, not the sweep.
      await mkalbum('suggested', { origin: 'auto', autoAlbum: { timeStart: '2023-03-03T00:00:00', timeEnd: '2023-03-03T00:00:00', memberCount: 1 } });
      await mkmedia(`${ALBUMS_ROOT}/suggested/s2023.jpg`, { ...captureTime('2023-03-03T00:00:00') });

      const stale = await client.execJson<SpanResult>('album-span --all --stale');
      assertEquals(stale.albums.map((a) => a.path), [`${ALBUMS_ROOT}/fresh`]);
      // Everything else already had a timeStart and was never listed.
      assertEquals(stale.updated, 1);
      assertEquals((await spanOf(`${ALBUMS_ROOT}/suggested`)).timeStart, undefined);

      const all = await client.execJson<SpanResult>('album-span --all');
      // Nothing changed since, so a full pass updates nothing but still scans: the six albums,
      // and neither of the two suggestions.
      assertEquals(all.updated, 0);
      assertEquals(all.scanned, 6);
    });

    const trip = `${ALBUMS_ROOT}/trip`;
    const handSet = async () => {
      const attrs = await client.execJson<Record<string, unknown>>(`attrs ${trip}`);
      return { timeStart: attrs.timeStart, timeEnd: attrs.timeEnd, spanStart: attrs.spanStart, spanEnd: attrs.spanEnd };
    };

    await t.step('a span set by hand widens the media span, and is refused where it would narrow it', async () => {
      await mkalbum('trip');
      await mkmedia(`${trip}/t1.jpg`, { ...captureTime('2024-06-10T12:00:00') });
      await mkmedia(`${trip}/t2.jpg`, { ...captureTime('2024-06-12T18:00:00') });
      await cmd.shouldSucceed(`album-span ${trip}`);

      // A start after the first capture, an end before the last, and something that is not a day.
      for (const set of ['spanStart 2024-06-11', 'spanEnd 2024-06-11', 'spanStart 2024-06']) {
        assertEquals((await client.exec(`album set ${trip} ${set}`)).success, false, set);
      }
      // On the media's own days, it widens nothing.
      await cmd.shouldSucceed(`album set ${trip} spanStart 2024-06-10`);
      assertEquals(await handSet(), { timeStart: '2024-06-10T12:00:00', timeEnd: '2024-06-12T18:00:00', spanStart: undefined, spanEnd: undefined });

      await cmd.shouldSucceed(`album set ${trip} spanStart 2024-06-08`);
      await cmd.shouldSucceed(`album set ${trip} spanEnd 2024-06-14`);
      assertEquals(await handSet(), { timeStart: '2024-06-08', timeEnd: '2024-06-14', spanStart: '2024-06-08', spanEnd: '2024-06-14' });
    });

    await t.step('--dry-run answers the span and the media span, writing nothing', async () => {
      await vfs.update(ADMIN_ACCESS, trip, { attrs: { timeStart: null } });
      const result = await client.execJson<SpanResult & { albums: { mediaStart?: string; mediaEnd?: string; spanStart?: string }[] }>(
        `album-span --dry-run ${trip}`,
      );
      assertEquals(result.updated, 0);
      assertEquals(result.albums[0].timeStart, '2024-06-08');
      assertEquals(result.albums[0].mediaStart, '2024-06-10T12:00:00');
      assertEquals(result.albums[0].mediaEnd, '2024-06-12T18:00:00');
      assertEquals((await handSet()).timeStart, undefined);
      await cmd.shouldSucceed(`album-span ${trip}`);
    });

    await t.step('a capture beyond a hand-set end takes it over', async () => {
      await mkmedia(`${trip}/t0.jpg`, { ...captureTime('2024-06-07T09:00:00') });
      await cmd.shouldSucceed(`album-span ${trip}`);
      assertEquals(await handSet(), { timeStart: '2024-06-07T09:00:00', timeEnd: '2024-06-14', spanStart: undefined, spanEnd: '2024-06-14' });

      // Cleared, the end is the media's again.
      await cmd.shouldSucceed(`album set ${trip} spanEnd ''`);
      assertEquals(await handSet(), { timeStart: '2024-06-07T09:00:00', timeEnd: '2024-06-12T18:00:00', spanStart: undefined, spanEnd: undefined });
    });

    await t.step('needs a path or --all', async () => {
      assertEquals((await client.exec('album-span')).success, false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
