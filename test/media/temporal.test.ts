/**
 * Temporal commands, `dayinhistory`, `onthisday-media` and `latest`: dated originals found through
 * the `takenAtUtc` index, never a rendition, which carries its source's time.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import type { OnThisDayEntry, Provided } from '@ein/api';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';
import type { DatedMedia, DayInHistory } from '@archive/media/api';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'temporal commands', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A photo, dated the way the media pipeline dates one: the wall clock and the instant. */
  const mkmedia = (slug: string, takenAt: string | undefined, extra: Record<string, unknown> = {}) =>
    vfs.create(ADMIN_ACCESS, 'file', ALBUMS_ROOT, slug, {
      props: { mode: 0o644 },
      attrs: {
        mimetype: 'image/jpeg',
        ...(takenAt ? captureTime(takenAt) : {}),
        ...extra,
      },
    });

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);

    await t.step('answers with no years on an empty archive', async () => {
      assertEquals(await client.execJson<DayInHistory>('dayinhistory 09-02'), { monthDay: '09-02', years: [] });
      assertEquals(await client.execJson<DatedMedia[]>('latest'), []);
      assertEquals(await client.execJson<Provided<OnThisDayEntry>[]>('onthisday-media 09-02'), []);
    });

    await t.step('rejects a day that is not one', async () => {
      await cmd.shouldFailWith('dayinhistory 9-2', 'expected the day as MM-DD');
      await cmd.shouldFailWith('dayinhistory 02-30', 'expected the day as MM-DD');
      await cmd.shouldSucceed('dayinhistory 02-29');
      await cmd.shouldFailWith('dayinhistory 09-02 --years=x', '--years must be a non-negative whole number');
      await cmd.shouldFailWith('latest 0', 'expected a count of at least 1');
      await cmd.shouldFailWith('onthisday-media 02-30', 'expected the day as MM-DD');
      await cmd.shouldFailWith('onthisday-media 09-02 --limit=x', '--limit must be a non-negative whole number');
    });

    await t.step('groups this day across the years it happened in', async () => {
      await mkmedia('a.jpg', '2019-09-02T08:00:00');
      await mkmedia('b.jpg', '2019-09-02T19:30:00');
      await mkmedia('c.jpg', '2004-09-02T12:00:00');
      // The right day, the wrong day-of-year, and a derivative of a match.
      await mkmedia('d.jpg', '2019-09-03T08:00:00');
      await mkmedia('thumb.jpg', '2019-09-02T08:00:00', { sourceId: 'source-node-id' });

      const result = await client.execJson<DayInHistory>('dayinhistory 09-02');
      assertEquals(result.monthDay, '09-02');
      assertEquals(result.years.map((year) => year.year), [2019, 2004]);
      assertEquals(result.years[0].items.map((item) => item.path), [`${ALBUMS_ROOT}/a.jpg`, `${ALBUMS_ROOT}/b.jpg`]);
      assertEquals(result.years[1].items.length, 1);

      const capped = await client.execJson<DayInHistory>('dayinhistory 09-02 --years 1 --per-year 1');
      assertEquals(capped.years.length, 1);
      assertEquals(capped.years[0].items.length, 1);
    });

    await t.step('onthisday-media answers a year an entry, newest first, its route a ring round the first picture', async () => {
      const entries = await client.execJson<Provided<OnThisDayEntry>[]>('onthisday-media 09-02');
      assertEquals(entries.map((entry) => [entry.year, entry.title]), [[2019, 'Pictures taken on 2 September 2019'], [2004, 'Pictures taken on 2 September 2004']]);
      assertEquals(entries[0].path, `${ALBUMS_ROOT}/a.jpg`);
      const route = new URL(entries[0].route, 'http://ein');
      assertEquals([route.pathname, route.searchParams.get('day'), route.searchParams.get('year'), route.searchParams.get('cover')], [
        '/onthisday/media',
        '09-02',
        '2019',
        `${ALBUMS_ROOT}/a.jpg`,
      ]);
      assertEquals((await client.execJson<Provided<OnThisDayEntry>[]>('onthisday-media 09-02 --limit 1')).map((entry) => entry.year), [2019]);

      // Core's onthisday gathers them.
      const gathered = await client.execJson<OnThisDayEntry[]>('onthisday 09-02');
      assertEquals(gathered.map((entry) => [entry.source, entry.year]), [['media', 2019], ['media', 2004]]);
    });

    await t.step('lists the newest originals first, without their renditions', async () => {
      await mkmedia('undated.jpg', undefined);
      const newest = await client.execJson<DatedMedia[]>('latest 3');
      assertEquals(newest.map((item) => item.path), [`${ALBUMS_ROOT}/d.jpg`, `${ALBUMS_ROOT}/b.jpg`, `${ALBUMS_ROOT}/a.jpg`]);
      assertEquals(newest[0].takenAt, '2019-09-03T08:00:00');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
