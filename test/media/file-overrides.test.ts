/**
 * file override command tests: file-set-time / -location / -photographer.
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

/** The source attr and the three the resolver derives from it. */
type Times = {
  whenManual?: string;
  takenAt?: string;
  takenAtUtc?: string;
  takenAtSource?: string;
  takenAtNote?: string;
};

Deno.test({
  name: 'file override commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a/files && mkdir -p ${PEOPLE_ROOT}`);
    await client.exec(`mkfile ${ALBUMS_ROOT}/a/files/p.jpg`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna --name Anna`);

    await t.step('file-set-time stores the source and the resolution it produces', async () => {
      await cmd.shouldSucceed(`file-set-time ${ALBUMS_ROOT}/a/files/p.jpg 2003-04-30T10:00:00Z`);
      const attrs = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/p.jpg`);
      // `whenManual` is the input; `takenAt`/`takenAtUtc`/`takenAtSource` are what the resolver
      // made of it, and are what everything else reads.
      assertEquals(attrs.whenManual, '2003-04-30T10:00:00Z');
      assertEquals(attrs.takenAt, '2003-04-30T10:00:00Z');
      assertEquals(attrs.takenAtUtc, '2003-04-30T10:00:00Z');
      assertEquals(attrs.takenAtSource, 'manual');
      await cmd.shouldFail(`file-set-time ${ALBUMS_ROOT}/a/files/p.jpg not-a-date`);
    });

    await t.step('a time may be as vague as it really is', async () => {
      // A time known only to a year or a month is stored exactly as typed — its length is its
      // precision — while the instant it sorts by
      // is the start of that period.
      await client.exec(`mkfile ${ALBUMS_ROOT}/a/files/vague.jpg`);
      for (const value of ['1975', '2004-03', '2003-04-30', '2003-04-30T14:03']) {
        await cmd.shouldSucceed(`file-set-time ${ALBUMS_ROOT}/a/files/vague.jpg ${value}`);
        const attrs = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/vague.jpg`);
        assertEquals(attrs.takenAt, value);
        assertEquals(attrs.takenAtUtc?.length, 20);
      }
    });

    await t.step('what Date.parse would take and this must not', async () => {
      // Written verbatim into an attr every range query compares as bytes, `12/25/2003` would
      // sort among the year 12s forever.
      for (const value of ['12/25/2003', '2003-4-3', '2003-02-30', 'Tue Mar 3 2020']) {
        await cmd.shouldFail(`file-set-time ${ALBUMS_ROOT}/a/files/vague.jpg ${value}`);
      }
    });

    await t.step('--note explains a guess, and --clear takes both back off', async () => {
      await cmd.shouldSucceed(`file-set-time ${ALBUMS_ROOT}/a/files/vague.jpg 1981-04-18 --note 'påsken 1981, 18:e är en gissning'`);
      let attrs = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/vague.jpg`);
      assertEquals(attrs.takenAtNote, 'påsken 1981, 18:e är en gissning');

      await cmd.shouldSucceed(`file-set-time --clear ${ALBUMS_ROOT}/a/files/vague.jpg`);
      attrs = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/vague.jpg`);
      // The whole resolution goes with the source: this file has no exif, so nothing is left
      // to resolve from and the derived attrs are cleared rather than left stale.
      assertEquals(attrs.whenManual, undefined);
      assertEquals(attrs.takenAtNote, undefined);
      assertEquals(attrs.takenAt, undefined);
      assertEquals(attrs.takenAtUtc, undefined);
    });

    await t.step('file-set-time takes a batch of file/date pairs', async () => {
      await client.exec(`mkfile ${ALBUMS_ROOT}/a/files/q.jpg && mkfile ${ALBUMS_ROOT}/a/files/r.jpg`);
      await cmd.shouldSucceed(
        `file-set-time ${ALBUMS_ROOT}/a/files/q.jpg 2011-06-01T09:00:00 ${ALBUMS_ROOT}/a/files/r.jpg 2011-06-01T09:01:00`,
      );
      const q = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/q.jpg`);
      const r = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/r.jpg`);
      assertEquals(q.takenAt, '2011-06-01T09:00:00');
      assertEquals(r.takenAt, '2011-06-01T09:01:00');
    });

    await t.step('an odd argument count is a usage error', async () => {
      await cmd.shouldFail(`file-set-time ${ALBUMS_ROOT}/a/files/q.jpg 2012-01-01T00:00:00 ${ALBUMS_ROOT}/a/files/r.jpg`);
      await cmd.shouldFail('file-set-time');
    });

    await t.step('a batch is all-or-nothing', async () => {
      // The bad date is second, so a naive implementation would already have written the first.
      await cmd.shouldFail(
        `file-set-time ${ALBUMS_ROOT}/a/files/q.jpg 2020-01-01T00:00:00 ${ALBUMS_ROOT}/a/files/r.jpg not-a-date`,
      );
      // Same for a path that does not exist.
      await cmd.shouldFail(
        `file-set-time ${ALBUMS_ROOT}/a/files/q.jpg 2020-01-01T00:00:00 ${ALBUMS_ROOT}/a/files/gone.jpg 2020-01-01T00:01:00`,
      );
      const q = await client.execJson<Times>(`attrs ${ALBUMS_ROOT}/a/files/q.jpg`);
      assertEquals(q.takenAt, '2011-06-01T09:00:00');
    });

    await t.step('file-set-position stores positionManual + child position node', async () => {
      await cmd.shouldSucceed(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg 57.6 11.8`);
      const attrs = await client.execJson<{ positionManual: { lat: number; lng: number } }>(`attrs ${ALBUMS_ROOT}/a/files/p.jpg`);
      assertEquals(attrs.positionManual, { lat: 57.6, lng: 11.8 });
      const loc = await client.execJson<{ lat: number; lng: number }>(`cat ${ALBUMS_ROOT}/a/files/p.jpg/position`);
      assertEquals(loc.lng, 11.8);
    });

    await t.step('a western coordinate needs the flag form, and now has one', async () => {
      // The positional form cannot carry it: parseArgs reads the leading `-` of
      // -122.3493 as the next flag.
      await cmd.shouldFail(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg 47.6205 -122.3493`);

      await cmd.shouldSucceed(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg --lat=47.6205 --lng=-122.3493`);
      const attrs = await client.execJson<{ positionManual: { lat: number; lng: number } }>(`attrs ${ALBUMS_ROOT}/a/files/p.jpg`);
      assertEquals(attrs.positionManual, { lat: 47.6205, lng: -122.3493 });
      const loc = await client.execJson<{ lat: number; lng: number }>(`cat ${ALBUMS_ROOT}/a/files/p.jpg/position`);
      assertEquals(loc.lng, -122.3493);
    });

    await t.step('with the flags, several files take one place in one call', async () => {
      await cmd.shouldSucceed(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg ${ALBUMS_ROOT}/a/files/q.jpg --lat=60.1 --lng=-5.2`);
      for (const name of ['p.jpg', 'q.jpg']) {
        const attrs = await client.execJson<{ positionManual: { lat: number; lng: number } }>(`attrs ${ALBUMS_ROOT}/a/files/${name}`);
        assertEquals(attrs.positionManual, { lat: 60.1, lng: -5.2 }, name);
      }
    });

    await t.step('a file that fails is reported and the rest are still set', async () => {
      await cmd.shouldFail(`file-set-position ${ALBUMS_ROOT}/a/files/gone.jpg ${ALBUMS_ROOT}/a/files/p.jpg --lat=1 --lng=2`);
      const attrs = await client.execJson<{ positionManual: { lat: number; lng: number } }>(`attrs ${ALBUMS_ROOT}/a/files/p.jpg`);
      assertEquals(attrs.positionManual, { lat: 1, lng: 2 });
    });

    await t.step('--clear takes away the point and the location link', async () => {
      await cmd.shouldSucceed(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg --lat=57.6 --lng=11.8`);
      await cmd.shouldSucceed(`ln -s /locations ${ALBUMS_ROOT}/a/files/p.jpg/location`);
      await cmd.shouldSucceed(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg --clear`);
      const attrs = await client.execJson<{ positionManual?: unknown }>(`attrs ${ALBUMS_ROOT}/a/files/p.jpg`);
      assertEquals(attrs.positionManual, undefined);
      await cmd.shouldFail(`cat ${ALBUMS_ROOT}/a/files/p.jpg/position`);
      await cmd.shouldFail(`props -L ${ALBUMS_ROOT}/a/files/p.jpg/location`);
      await cmd.shouldFail(`file-set-position ${ALBUMS_ROOT}/a/files/p.jpg --clear --lat=1 --lng=2`);
    });

    await t.step('file-set-photographer links a person (replaceable)', async () => {
      await cmd.shouldSucceed(`file-set-photographer ${ALBUMS_ROOT}/a/files/p.jpg ${PEOPLE_ROOT}/anna`);
      const link = await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/a/files/p.jpg/photographer`);
      assertEquals(link.softlink, `${PEOPLE_ROOT}/anna`);
      await cmd.shouldFail(`file-set-photographer ${ALBUMS_ROOT}/a/files/p.jpg ${PEOPLE_ROOT}/nobody`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
