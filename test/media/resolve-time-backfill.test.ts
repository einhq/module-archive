/**
 * `media-resolve-time`: re-resolving a corpus from what is already stored.
 *
 * The pass applies the rules to an archive that is already indexed, and the thing worth
 * testing is what it refuses to touch as much as what it rewrites.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import type { MediaResolveTimeResult as Result } from '@archive/media/api';

const testCtx = createTestContext({ modules: ['archive'] });

type Times = { takenAt?: string; takenAtUtc?: string; takenAtSource?: string; whenManual?: string };

Deno.test({
  name: 'media-resolve-time',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A file with an exif child carrying a normalized `when`, as `exif-extract` leaves it. */
  const media = async (path: string, when: unknown, fileAttrs: Record<string, unknown> = {}) => {
    await client.exec(`echo bytes > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...fileAttrs } });
    await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.ensure(ADMIN_ACCESS, 'exif', `${path}/metadata`, 'exif');
    await vfs.update(ADMIN_ACCESS, `${path}/metadata/exif`, { attrs: { indexedAt: '2020-01-01T00:00:00Z', when } });
  };

  const parts = (iso: string) => {
    const [date, time] = iso.split('T');
    const [year, month, day] = date.split('-');
    const [hour, minute, second] = time.split(':');
    return { year, month, day, hour, minute, second };
  };

  const attrsOf = (path: string) => client.execJson<Times>(`attrs ${path}`);

  try {
    await client.exec('mkdir -p /shots');

    await t.step('a gps fix supplies the instant and the camera clock the wall clock', async () => {
      await media('/shots/gps.jpg', {
        device: parts('2015-07-25T14:03:11'),
        gps: parts('2015-07-25T12:03:11'),
      });
      await cmd.shouldSucceed('media-resolve-time');

      const attrs = await attrsOf('/shots/gps.jpg');
      // +02:00 recovered from the pair, rounded to the hour.
      assertEquals(attrs.takenAt, '2015-07-25T14:03:11+02:00');
      assertEquals(attrs.takenAtUtc, '2015-07-25T12:03:11Z');
      assertEquals(attrs.takenAtSource, 'gps');
    });

    await t.step('a stale fix is disbelieved and counted', async () => {
      // The corpus shape: a file shot on the 21st carrying the receiver's last lock, from the 19th.
      await media('/shots/stale.jpg', {
        device: parts('2014-11-21T22:53:37'),
        gps: parts('2014-11-19T11:41:01'),
      });
      const res = await client.execJson<Result>('media-resolve-time');

      assertEquals(res.staleGps, 1);
      const attrs = await attrsOf('/shots/stale.jpg');
      assertEquals(attrs.takenAtSource, 'device');
      assertEquals(attrs.takenAt, '2014-11-21T22:53:37');
    });

    await t.step('a hand-typed time wins, and keeps its precision', async () => {
      await media('/shots/manual.jpg', { device: parts('2015-07-25T14:03:11') }, { whenManual: '1975' });
      await cmd.shouldSucceed('media-resolve-time');

      const attrs = await attrsOf('/shots/manual.jpg');
      assertEquals(attrs.takenAt, '1975');
      assertEquals(attrs.takenAtSource, 'manual');
      assertEquals(attrs.takenAtUtc?.length, 20);
    });

    await t.step('an exif node written before `when` existed is left alone', async () => {
      // Not the same as an empty `when`: it says nothing, and clearing would throw away a date
      // this pass has no way to re-derive.
      await client.exec('echo bytes > /shots/legacy.jpg');
      await vfs.update(ADMIN_ACCESS, '/shots/legacy.jpg', {
        attrs: { mimetype: 'image/jpeg', takenAt: '2009-05-01T10:00:00', takenAtUtc: '2009-05-01T08:00:00Z' },
      });
      await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/legacy.jpg', 'metadata');
      await vfs.ensure(ADMIN_ACCESS, 'exif', '/shots/legacy.jpg/metadata', 'exif');
      await vfs.update(ADMIN_ACCESS, '/shots/legacy.jpg/metadata/exif', { attrs: { indexedAt: '2019-01-01T00:00:00Z' } });

      await cmd.shouldSucceed('media-resolve-time');
      const attrs = await attrsOf('/shots/legacy.jpg');
      assertEquals(attrs.takenAt, '2009-05-01T10:00:00');
    });

    await t.step('an empty `when` is a positive statement, and clears', async () => {
      // `{}`, not null: a null attr write removes the key, which is exactly the "says nothing"
      // case above. `exif-extract` writes the empty object for the same reason.
      await media('/shots/undated.jpg', {}, { takenAt: '2009-05-01T10:00:00', takenAtUtc: '2009-05-01T08:00:00Z' });
      await cmd.shouldSucceed('media-resolve-time');

      const attrs = await attrsOf('/shots/undated.jpg');
      assertEquals(attrs.takenAt, undefined);
      assertEquals(attrs.takenAtUtc, undefined);
    });

    await t.step('--dry-run writes nothing and says what it would do', async () => {
      await media('/shots/dry.jpg', { device: parts('2001-02-03T04:05:06') });

      const res = await client.execJson<Result>('media-resolve-time --dry-run');
      assertEquals(res.dryRun, true);
      assertEquals(res.changed >= 1, true);
      assertEquals((await attrsOf('/shots/dry.jpg')).takenAt, undefined);

      await cmd.shouldSucceed('media-resolve-time');
      assertEquals((await attrsOf('/shots/dry.jpg')).takenAt, '2001-02-03T04:05:06');
    });

    await t.step('a second pass over a settled corpus writes nothing', async () => {
      const res = await client.execJson<Result>('media-resolve-time');
      assertEquals(res.changed, 0);
      assertEquals(res.untouched > 0, true);
    });

    await t.step('--under narrows the walk', async () => {
      await client.exec('mkdir -p /other');
      await media('/other/x.jpg', { device: parts('2003-03-03T03:03:03') });

      const res = await client.execJson<Result>('media-resolve-time --under /other');
      assertEquals(res.scanned, 1);
      assertEquals(res.changed, 1);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
