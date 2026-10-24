/** `events-anniversaries`: birthdays, memorials and wedding anniversaries around a date, as events entries. */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext, testCommands } from '@ein/testing';
import type { EventEntry, Provided } from '@ein/api';

const testCtx = createTestContext({ modules: ['archive'] });

/** Pinned so nothing here depends on the day the suite happens to run. */
const TODAY = '2026-09-02';

Deno.test({
  name: 'events-anniversaries command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const upcoming = (args = '') => client.execJson<Provided<EventEntry>[]>(`events-anniversaries --today ${TODAY} ${args}`);
  const titles = (result: Provided<EventEntry>[]) => result.map((entry) => entry.title);
  /** What the route that draws an entry is given. */
  const query = (entry: Provided<EventEntry>) => new URL(entry.route, 'http://ein').searchParams;

  const mkperson = (slug: string, attrs: Record<string, unknown>) => vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { props: { mode: 0o755 }, attrs });

  /**
   * Both halves of a partnership, as `person-set-partner` and the importer write
   * one: the same `relation` on each, each pointing at the other.
   */
  const mkpartners = async (a: string, b: string, relation: { kind?: string; from: string; to?: string }) => {
    for (const [owner, other] of [[a, b], [b, a]]) {
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/${owner}`, 'partners', { props: { mode: 0o775 } });
      await vfs.create(ADMIN_ACCESS, 'softlink', `${PEOPLE_ROOT}/${owner}/partners`, other, {
        props: { mode: 0o777, softlink: `${PEOPLE_ROOT}/${other}` },
        attrs: { relation: { peerLink: `${PEOPLE_ROOT}/${other}/partners/${owner}`, ...relation } },
      });
    }
  };

  try {
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}`);

    await t.step('answers honestly on an empty archive', async () => {
      assertEquals(await upcoming(), []);
    });

    await t.step('rejects a malformed clock override', async () => {
      await cmd.shouldFailWith('events-anniversaries --today 2026-9-2', '--today must be YYYY-MM-DD');
      await cmd.shouldFailWith('events-anniversaries --days-ahead=abc', '--days-ahead must be a non-negative whole number');
      // `--flag -3` arrives as an empty value, which is refused rather than read as 0.
      await cmd.shouldFailWith('events-anniversaries --days-ahead -3', 'unknown flag');
      await cmd.shouldFailWith('events-anniversaries --days-ahead=', '--days-ahead must be a non-negative whole number');
    });

    await t.step('finds birthdays on both sides of today, and not outside the window', async () => {
      await mkperson('today', { name: 'Tora', born: '1986-09-02' });
      await mkperson('soon', { name: 'Sonja', born: '1991-09-20' });
      await mkperson('recent', { name: 'Rikard', born: '1974-08-27' });
      // Just outside the default 30-day reach, and reachable when it is widened.
      await mkperson('later', { name: 'Lova', born: '2000-10-10' });
      // Comfortably outside the window in both directions.
      await mkperson('far', { name: 'Frida', born: '1988-03-14' });

      const result = await upcoming();
      assertEquals(titles(result), [
        'Rikard turns 52',
        'Tora turns 40',
        'Sonja turns 35',
      ]);
      assertEquals(result.map((entry) => entry.date), ['2026-08-27', '2026-09-02', '2026-09-20']);
      assertEquals(result.map((entry) => entry.milestone), [false, true, false]);
      assertEquals(new URL(result[1].route, 'http://ein').pathname, '/events/anniversary');
      assertEquals([query(result[1]).get('kind'), query(result[1]).get('path'), query(result[1]).get('title')], ['birthday', `${PEOPLE_ROOT}/today`, 'Tora turns 40']);
      assertEquals(query(result[1]).getAll('people'), [`${PEOPLE_ROOT}/today`]);
      assertEquals(result[1].path, `${PEOPLE_ROOT}/today`);
      assertEquals([query(result[0]).has('milestone'), query(result[1]).has('milestone')], [false, true]);

      const narrow = await upcoming('--days-ahead 20 --days-past 2');
      assertEquals(titles(narrow), ['Tora turns 40', 'Sonja turns 35']);

      const wide = await upcoming('--days-ahead 60');
      assertEquals(titles(wide).includes('Lova turns 26'), true);

      // People are read by listing the people root, so a person filed
      // elsewhere is seen only when `--people` names that directory.
      await cmd.shouldSucceed('mkdir -p /archive');
      await vfs.create(ADMIN_ACCESS, 'person', '/archive', 'elsewhere', { props: { mode: 0o755 }, attrs: { name: 'Elna', born: '1990-09-04' } });
      assertEquals(titles(await upcoming()).some((title) => title.startsWith('Elna')), false);
      assertEquals(titles(await upcoming('--people /archive')).includes('Elna turns 36'), true);
    });

    await t.step('says "would have turned" for the departed, and stops at a plausible lifespan', async () => {
      await mkperson('gone', { name: 'Gustav', born: '1950-09-05', died: '2011-04-02' });
      // Born 1815: any birthday now is past ASSUMED_LIFESPAN and is not one.
      await mkperson('ancient', { name: 'Augusta', born: '1815-09-04', died: '1890-02-02' });

      const result = await upcoming();
      assertEquals(titles(result).includes('Gustav would have turned 76'), true);
      assertEquals(titles(result).some((title) => title.startsWith('Augusta')), false);
    });

    await t.step('marks only milestone memorials', async () => {
      // 50 years since — a round number a family marks.
      await mkperson('milestone-death', { name: 'Märta', born: '1900-01-01', died: '1976-09-08' });
      // 47 years since — real, but not something to put on a landing page.
      await mkperson('ordinary-death', { name: 'Olle', born: '1900-01-01', died: '1979-09-08' });

      const result = await upcoming();
      assertEquals(titles(result).includes('50 years since Märta died'), true);
      assertEquals(titles(result).some((title) => title.includes('Olle')), false);
    });

    await t.step('names both halves of a wedding anniversary, once', async () => {
      await mkperson('ada', { name: 'Ada', born: '1950-01-01' });
      await mkperson('bo', { name: 'Bo', born: '1950-01-01' });
      await mkpartners('ada', 'bo', { kind: 'married', from: '1976-09-11' });
      // Year only: no day for it to come round on.
      await mkperson('cilla', { name: 'Cilla', born: '1950-01-01' });
      await mkperson('dan', { name: 'Dan', born: '1950-01-01' });
      await mkpartners('cilla', 'dan', { kind: 'engaged', from: '1975' });

      const result = await upcoming();
      // Both halves carry the same relation; the couple is counted once.
      const wedding = result.filter((entry) => entry.title === 'Ada and Bo — 50 years married');
      assertEquals(wedding.length, 1);
      // Its route shows both of them.
      assertEquals(query(wedding[0]).getAll('people').toSorted(), [`${PEOPLE_ROOT}/ada`, `${PEOPLE_ROOT}/bo`]);
      assertEquals(titles(result).some((title) => title.includes('engaged')), false);
    });

    await t.step('an undeclared partnership is together, not married', async () => {
      await mkperson('gun', { name: 'Gun', born: '1950-01-01' });
      await mkperson('hans', { name: 'Hans', born: '1950-01-01' });
      await mkpartners('gun', 'hans', { from: '1976-09-11' });

      const result = await upcoming();
      assertEquals(titles(result).includes('Gun and Hans — 50 years together'), true);
    });

    await t.step('a partnership that ended, or that one of the two did not outlive, stops', async () => {
      // Parted: the relation says so, and the wedding stops coming round.
      await mkperson('eva', { name: 'Eva', born: '1950-01-01' });
      await mkperson('folke', { name: 'Folke', born: '1950-01-01' });
      await mkpartners('eva', 'folke', { kind: 'married', from: '1976-09-11', to: '1990-01-01' });

      // Widowed: "50 years married" would be a false sentence about a marriage
      // that ended in 1990, so it is not one the page makes.
      await mkperson('inga', { name: 'Inga', born: '1950-01-01' });
      await mkperson('jonas', { name: 'Jonas', born: '1950-01-01', died: '1990-06-01' });
      await mkpartners('inga', 'jonas', { kind: 'married', from: '1976-09-11' });

      const result = await upcoming();
      assertEquals(titles(result).some((title) => title.includes('Eva')), false);
      assertEquals(titles(result).some((title) => title.includes('Inga')), false);
    });

    await t.step('has no occurrence for 29 February in a common year', async () => {
      await mkperson('leap', { name: 'Leif', born: '1996-02-29' });

      // 2026 is not a leap year: a window straddling the date finds nothing.
      const common = await upcoming('--today 2026-02-28 --days-ahead 5 --days-past 5');
      assertEquals(titles(common).some((title) => title.includes('Leif')), false);

      // 2028 is, and he turns 32 on it.
      const leap = await client.execJson<Provided<EventEntry>[]>('events-anniversaries --today 2028-02-28 --days-ahead 5 --days-past 5');
      assertEquals(titles(leap).includes('Leif turns 32'), true);
    });

    await t.step('milestones survive the limit, and the answer stays in date order', async () => {
      const result = await upcoming('--limit 2');
      assertEquals(result.length, 2);
      assertEquals(result.every((entry) => entry.milestone), true);
      assertEquals(result[0].date <= result[1].date, true);
    });

    await t.step('of two as near, the one still to come survives the limit', async () => {
      // Listed first, a day behind; the other a day ahead. Neither is a round number.
      await mkperson('aa-past', { name: 'Petra', born: '1990-06-14' });
      await mkperson('zz-future', { name: 'Frans', born: '1991-06-16' });
      const result = await upcoming('--today 2026-06-15 --days-ahead 1 --days-past 1 --limit 1');
      assertEquals(titles(result), ['Frans turns 35']);
    });

    await t.step("core's events gathers them, keeping the provider's milestones over the nearest", async () => {
      const events = await client.execJson<EventEntry[]>(`events --today ${TODAY} --limit 2`);
      assertEquals(events.map((entry) => [entry.source, entry.milestone]), [['anniversaries', true], ['anniversaries', true]]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
