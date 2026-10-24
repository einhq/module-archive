/**
 * `timeline`: the merged global feed. The things worth pinning down are the ones
 * that only show up where two sources meet — ordering across them, ties on an
 * identical date, a source running dry mid-feed, and paging producing exactly
 * the sequence one big page would.
 */

import { ALBUMS_ROOT, DEVICES_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Entry = {
  kind: string;
  key: string;
  date: string;
  exactDate?: string;
  endDate?: string;
  path: string;
  title: string;
  ownerPath?: string;
  description?: string;
  location?: string;
  people?: string[];
  count?: number;
  age?: number;
  years?: number;
  eventType?: string;
};
type Page = { cursor: string | null; entries: Entry[] };

/** Pinned so milestone birthdays are not a function of when the suite runs. */
const TODAY = '2026-08-12';

Deno.test({
  name: 'timeline',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  // Staging's organizer re-clusters auto albums on its own: the fixtures here are hand-made ones.
  await cmd.shouldSucceed('service stop staging-organizer');

  const titles = (page: Page) => page.entries.map((e) => e.title);
  const kinds = (page: Page) => page.entries.map((e) => e.kind);

  const feed = (args = '') => client.execJson<Page>(`timeline --today ${TODAY} ${args}`);

  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, {
      props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: target },
    });

  const mkperson = (slug: string, attrs: Record<string, unknown>) => vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { props: { mode: 0o755 }, attrs });

  /** Both halves of a partnership, as `person-set-partner` and the importer write one. */
  const mkpartners = async (a: string, b: string, relation: { kind?: string; from: string; to?: string }) => {
    for (const [owner, other] of [[a, b], [b, a]]) {
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/${owner}`, 'partners', { props: { mode: 0o775 } });
      await vfs.create(ADMIN_ACCESS, 'softlink', `${PEOPLE_ROOT}/${owner}/partners`, other, {
        props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: `${PEOPLE_ROOT}/${other}` },
        attrs: { relation: { peerLink: `${PEOPLE_ROOT}/${other}/partners/${owner}`, ...relation } },
      });
    }
  };

  const mkevent = async (owner: string, slug: string, attrs: Record<string, unknown>, body?: string) => {
    await vfs.ensure(ADMIN_ACCESS, 'directory', owner, 'events', { props: { mode: 0o775 } });
    const path = `${owner}/events/${slug}`;
    await cmd.shouldSucceed(`echo -n ${JSON.stringify(body ?? '')} > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, {
      attrs: { mimetype: 'text/markdown', size: (body ?? '').length, ...attrs },
    });
    return path;
  };

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}`);
    await cmd.shouldSucceed(`mkdir -p ${DEVICES_ROOT}`);

    // Albums carry the span album-span denormalizes; the timeline never lists them.
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'sommaren', {
      props: { mode: 0o755 },
      attrs: { name: 'Sommaren 1998', timeStart: '1998-06-12T14:03:00', timeEnd: '1998-06-14T21:00:00', mediaCount: 214 },
    });
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'amsterdam', {
      props: { mode: 0o755 },
      attrs: {
        name: 'Amsterdam',
        origin: 'auto',
        timeStart: '2019-06-02T09:00:00',
        timeEnd: '2019-06-09T18:00:00',
        mediaCount: 84,
      },
    });
    // No span at all: nothing dated inside it.
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'undated', { props: { mode: 0o755 }, attrs: { name: 'Undated', mediaCount: 3 } });

    await mkperson('anna', { name: 'Anna Strand', born: '1966-03-04' });
    await mkperson('abraham', { name: 'Abraham Lindqvist', born: '1815', died: '1902' });
    await mkperson('bjorn', { name: 'Björn Almqvist', born: '1984-06-24' });
    await mkperson('hanna', { name: 'Hanna Fjällström', born: '1979-03-13' });
    await mkperson('jonas', { name: 'Jonas Fjällström', born: '1977-01-09' });

    // A track is named by the device that recorded it.
    await vfs.create(ADMIN_ACCESS, 'device', DEVICES_ROOT, 'kebnekaise', { props: { mode: 0o755 }, attrs: { name: 'Kebnekaise' } });
    // Its span is what the track registry knows of its fixes.
    await vfs.create(ADMIN_ACCESS, 'track', `${DEVICES_ROOT}/kebnekaise`, 'track', { props: { mode: 0o755 } });
    const track = await vfs.open(ADMIN_ACCESS, `${DEVICES_ROOT}/kebnekaise/track`, { mode: 'a' });
    try {
      await track.write(new TextEncoder().encode(
        '{"lat":67.9,"lng":18.5,"ts":"2015-08-16T06:00:00Z"}\n{"lat":67.91,"lng":18.6,"ts":"2015-08-23T17:00:00Z"}\n',
      ));
    } finally {
      await track.close();
    }

    await t.step('merges every source into one descending feed', async () => {
      const page = await feed('--birthdays none --anniversaries none');
      assertEquals(kinds(page), ['auto-album', 'track', 'album', 'birth', 'birth', 'birth', 'birth', 'death', 'birth']);
      assertEquals(titles(page), [
        'Amsterdam',
        'Kebnekaise',
        'Sommaren 1998',
        'Björn Almqvist was born',
        'Hanna Fjällström was born',
        'Jonas Fjällström was born',
        'Anna Strand was born',
        'Abraham Lindqvist died, aged 87',
        'Abraham Lindqvist was born',
      ]);
    });

    await t.step('an album with no span is absent, not undated at the end', async () => {
      const page = await feed('--kind album,auto-album');
      assertEquals(titles(page), ['Amsterdam', 'Sommaren 1998']);
    });

    await t.step('carries the album span and count', async () => {
      const page = await feed('--kind auto-album');
      assertEquals(page.entries[0].endDate, '2019-06-09T18:00:00');
      assertEquals(page.entries[0].count, 84);
    });

    await t.step('a death names the age when both years are known', async () => {
      const page = await feed('--kind death');
      assertEquals(titles(page), ['Abraham Lindqvist died, aged 87']);
      assertEquals(page.entries[0].age, 87);
    });

    await t.step("milestone birthdays only, inside the person's lifetime", async () => {
      const page = await feed('--kind birthday -l 200');
      const forAbraham = page.entries.filter((e) => e.path === `${PEOPLE_ROOT}/abraham`);
      // Year-only birth date: no day to put an anniversary on.
      assertEquals(forAbraham.length, 0);

      const forBjorn = page.entries.filter((e) => e.path === `${PEOPLE_ROOT}/bjorn`).map((e) => e.title);
      assertEquals(forBjorn, [
        'Björn Almqvist turns 40',
        'Björn Almqvist turns 30',
        'Björn Almqvist turns 20',
        'Björn Almqvist turns 15',
        'Björn Almqvist turns 10',
        'Björn Almqvist turns 5',
      ]);
      // Every entry is on the birth day-of-year and never in the future.
      assert(page.entries.every((e) => e.date <= TODAY));
    });

    await t.step('someone with no death date stops celebrating at a plausible age', async () => {
      // Without a death date, someone born in 1846 is not still turning a year older.
      await mkperson('agda', { name: 'Agda Andersson', born: '1846-06-07' });

      const page = await feed('--kind birthday -l 200');
      const ages = page.entries.filter((e) => e.path === `${PEOPLE_ROOT}/agda`).map((e) => e.age ?? 0);
      assertEquals(Math.max(...ages), 110);
    });

    await t.step('--birthdays all fills in the years between', async () => {
      const page = await feed('--kind birthday --birthdays all -l 200');
      const forBjorn = page.entries.filter((e) => e.path === `${PEOPLE_ROOT}/bjorn`);
      assertEquals(forBjorn.length, 42);
      assertEquals(forBjorn[0].title, 'Björn Almqvist turns 42');
      assertEquals(forBjorn[0].date, '2026-06-24');
    });

    await t.step("a birth keeps its composed title but takes the event's body and location", async () => {
      const path = await mkevent(`${PEOPLE_ROOT}/bjorn`, 'birth', { name: 'Björn Almqvists Födelsedag', eventType: 'birth', date: '1984-06-24' }, 'Wee!');
      await vfs.ensure(ADMIN_ACCESS, 'position', path, 'position', { props: { mode: 0o755 } });

      const page = await feed('--kind birth');
      const entry = page.entries.find((e) => e.path === `${PEOPLE_ROOT}/bjorn`);
      assert(entry, 'expected the birth entry');
      // The stored name is formulaic and is deliberately not used.
      assertEquals(entry.title, 'Björn Almqvist was born');
      assertEquals(entry.description, 'Wee!');
      assertEquals(entry.location, `${PEOPLE_ROOT}/bjorn/events/birth/position`);
    });

    await t.step('a birth event with no body still renders, and refines a coarse date', async () => {
      await mkevent(`${PEOPLE_ROOT}/abraham`, 'birth', { name: 'Födelse', eventType: 'birth', date: '1815-03-04' });

      const page = await feed('--kind birth');
      const entry = page.entries.find((e) => e.path === `${PEOPLE_ROOT}/abraham`);
      assert(entry, 'expected the birth entry');
      assertEquals(entry.description, undefined);
      // Ordering stays on the indexed value; only the display gains precision.
      assertEquals(entry.date, '1815');
      assertEquals(entry.exactDate, '1815-03-04');
    });

    await t.step('birth and death events never double the person entries', async () => {
      await mkevent(`${PEOPLE_ROOT}/abraham`, 'death', { name: 'Död', eventType: 'death', date: '1902' });

      const page = await feed('--birthdays none --anniversaries none -l 200');
      assertEquals(page.entries.filter((e) => e.path === `${PEOPLE_ROOT}/abraham` && e.kind === 'birth').length, 1);
      assertEquals(page.entries.filter((e) => e.kind === 'event').length, 0);
    });

    await t.step('a marriage names both partners', async () => {
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/jonas`, 'partners', { props: { mode: 0o775 } });
      await mklink(`${PEOPLE_ROOT}/jonas/partners`, 'hanna', `${PEOPLE_ROOT}/hanna`);
      await mkevent(`${PEOPLE_ROOT}/jonas`, 'Giftermål', { name: 'Giftermål', eventType: 'marriage', date: '2004-06-19' }, 'Gifta i kyrkan kl 14:00.');

      const page = await feed('--kind event');
      assertEquals(titles(page), ['Jonas Fjällström and Hanna Fjällström married']);
      assertEquals(page.entries[0].description, 'Gifta i kyrkan kl 14:00.');
      assertEquals(page.entries[0].people, [`${PEOPLE_ROOT}/jonas`, `${PEOPLE_ROOT}/hanna`]);
    });

    await t.step('two partners and no date to choose between them names only the owner', async () => {
      await mkperson('mia', { name: 'Sigrid Falk', born: '1980-01-01' });
      await mklink(`${PEOPLE_ROOT}/jonas/partners`, 'mia', `${PEOPLE_ROOT}/mia`);

      const page = await feed('--kind event');
      assertEquals(titles(page), ['Jonas Fjällström married']);
      assertEquals(page.entries[0].people, [`${PEOPLE_ROOT}/jonas`]);
    });

    await t.step('a dated partnership comes round, once per couple, naming both', async () => {
      await mkperson('sten', { name: 'Sten Aldrin', born: '1946-02-02' });
      await mkperson('rut', { name: 'Rut Aldrin', born: '1948-04-04' });
      await mkpartners('sten', 'rut', { kind: 'married', from: '1976-05-08' });

      const page = await feed('--kind anniversary -l 200');
      assertEquals(titles(page), [
        'Rut Aldrin and Sten Aldrin — 50 years married',
        'Rut Aldrin and Sten Aldrin — 40 years married',
        'Rut Aldrin and Sten Aldrin — 30 years married',
        'Rut Aldrin and Sten Aldrin — 20 years married',
        'Rut Aldrin and Sten Aldrin — 15 years married',
        'Rut Aldrin and Sten Aldrin — 10 years married',
        'Rut Aldrin and Sten Aldrin — 5 years married',
      ]);
      // Both halves of the pair carry the same date; one couple, one series.
      // Which half of the pair survives is decided by the link path, so the
      // couple is named the same way on every page.
      assertEquals(page.entries[0].people, [`${PEOPLE_ROOT}/rut`, `${PEOPLE_ROOT}/sten`]);
      assertEquals(page.entries[0].date, '2026-05-08');
      assertEquals(page.entries[0].years, 50);
      // The wedding day itself belongs to the event source, not to this one.
      assert(page.entries.every((entry) => entry.date > '1976-05-08'));
    });

    await t.step('--anniversaries all fills in the years between, none turns them off', async () => {
      const all = await feed('--kind anniversary --anniversaries all -l 200');
      assertEquals(all.entries.length, 50);
      assertEquals(all.entries[0].title, 'Rut Aldrin and Sten Aldrin — 50 years married');

      const off = await feed('--kind anniversary --anniversaries none -l 200');
      assertEquals(off.entries, []);
    });

    await t.step('a partnership that has ended, or that one of the two has not, stops there', async () => {
      await mkperson('vera', { name: 'Vera Ek', born: '1946-02-02' });
      await mkperson('ove', { name: 'Ove Ek', born: '1946-02-02', died: '1998-01-01' });
      await mkpartners('vera', 'ove', { kind: 'married', from: '1976-05-08' });

      await mkperson('signe', { name: 'Signe Roos', born: '1946-02-02' });
      await mkperson('tage', { name: 'Tage Roos', born: '1946-02-02' });
      await mkpartners('signe', 'tage', { kind: 'married', from: '1976-05-08', to: '1999-01-01' });

      const page = await feed('--kind anniversary --anniversaries all -l 300');
      const ek = page.entries.filter((entry) => entry.title.includes('Ek')).map((entry) => entry.years ?? 0);
      const roos = page.entries.filter((entry) => entry.title.includes('Roos')).map((entry) => entry.years ?? 0);
      // 1998 is the last year Ove was alive; 1999 is the last the Roos marriage lasted.
      assertEquals(Math.max(...ek), 22);
      assertEquals(Math.max(...roos), 23);
    });

    await t.step('an undated partnership contributes nothing', async () => {
      await mkperson('nils', { name: 'Nils Berg', born: '1946-02-02' });
      await mkperson('elsa', { name: 'Elsa Berg', born: '1946-02-02' });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/nils`, 'partners', { props: { mode: 0o775 } });
      await mklink(`${PEOPLE_ROOT}/nils/partners`, 'elsa', `${PEOPLE_ROOT}/elsa`);

      const page = await feed('--kind anniversary --anniversaries all -l 300');
      assert(page.entries.every((entry) => !entry.title.includes('Berg')));
    });

    await t.step('a generic event keeps its own name', async () => {
      await mkevent(`${PEOPLE_ROOT}/anna`, 'ordforande', { name: 'Ordförande i föreningen', eventType: 'generic', date: '2005-01-01' });

      const page = await feed('--kind event');
      assertEquals(titles(page), ['Ordförande i föreningen', 'Jonas Fjällström married']);
    });

    await t.step('an event added without a name is titled by its first line, and the card says it once', async () => {
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna --date 2006-03-01 --body "Flyttade till Lund
Med hela familjen."`);
      try {
        const page = await feed('--kind event');
        const entry = page.entries.find((e) => e.title === 'Flyttade till Lund');
        assert(entry, 'expected the unnamed event');
        assertEquals(entry.path, `${PEOPLE_ROOT}/anna/events/event-2006-03-01`);
        assertEquals(entry.description, 'Med hela familjen.');
      } finally {
        await cmd.shouldSucceed(`rm ${PEOPLE_ROOT}/anna/events/event-2006-03-01`);
      }
    });

    await t.step('a Markdown first line titles the event as plain text, and the card still says it once', async () => {
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna --date 2006-04-01 --body "## **Flyttade** till _Lund_ i [maj](https://example.com)
Med hela familjen."`);
      try {
        const page = await feed('--kind event');
        const entry = page.entries.find((e) => e.path === `${PEOPLE_ROOT}/anna/events/event-2006-04-01`);
        assert(entry, 'expected the unnamed event');
        assertEquals(entry.title, 'Flyttade till Lund i maj');
        assertEquals(entry.description, 'Med hela familjen.');
      } finally {
        await cmd.shouldSucceed(`rm ${PEOPLE_ROOT}/anna/events/event-2006-04-01`);
      }
    });

    await t.step('an album-owned event is picked up too, linked to its album', async () => {
      await mkevent(`${ALBUMS_ROOT}/sommaren`, 'invigning', { name: 'Invigning', eventType: 'generic', date: '1998-06-13' });

      const page = await feed('--kind event');
      const entry = page.entries.find((e) => e.title === 'Invigning');
      assert(entry, 'expected the album event');
      assertEquals(entry.ownerPath, `${ALBUMS_ROOT}/sommaren`);
    });

    await t.step('--at lands in the named period, not before it', async () => {
      // Dragging a scrubber to 2015 should show 2015, so the whole year counts.
      const inside = await feed('--birthdays none --anniversaries none --at 2015');
      assertEquals(titles(inside)[0], 'Kebnekaise');

      const earlier = await feed('--birthdays none --anniversaries none --at 2014');
      assert(!titles(earlier).includes('Kebnekaise'));
      assertEquals(titles(earlier).slice(0, 2), ['Ordförande i föreningen', 'Jonas Fjällström married']);

      // A month bound is a month, not a year.
      const month = await feed('--birthdays none --anniversaries none --at 2015-07');
      assert(!titles(month).includes('Kebnekaise'));
    });

    await t.step('--year keeps the feed inside the year, and an album in every year it holds media from', async () => {
      /** An album whose span is what its dated members say it is. */
      const mkalbum = async (slug: string, name: string, taken: string[]) => {
        await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, slug, {
          props: { mode: 0o755 },
          attrs: { name, timeStart: taken[0], timeEnd: taken.at(-1), mediaCount: taken.length },
        });
        for (const [index, takenAt] of taken.entries()) {
          await client.exec(`echo x > ${ALBUMS_ROOT}/${slug}/${index}.jpg`);
          await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/${slug}/${index}.jpg`, { attrs: { mimetype: 'image/jpeg', ...captureTime(takenAt) } });
        }
      };
      // Runs over New Year, with pictures on both sides of it.
      await mkalbum('nyar', 'Nyår', ['1997-12-31T18:00:00', '1998-01-01T00:30:00']);
      // Spans a decade and a half, but holds only its two ends.
      await mkalbum('negativ', 'Negativ', ['1990-05-01T12:00:00', '2005-08-01T12:00:00']);

      const albums = (year: string, extra = '') => feed(`--kind album,auto-album --year ${year} ${extra}`);

      assertEquals(titles(await albums('1998')), ['Sommaren 1998', 'Nyår']);
      assertEquals(titles(await albums('1997')), ['Nyår']);
      assertEquals(titles(await albums('1999')), []);
      assertEquals(titles(await albums('1990')), ['Negativ']);
      assertEquals(titles(await albums('2005')), ['Negativ']);

      // Pages end at the year's floor rather than running on into 1997.
      const first = await albums('1998', '-l 1');
      assertEquals(titles(first), ['Sommaren 1998']);
      const second = await albums('1998', `-l 1 --cursor '${first.cursor}'`);
      assertEquals(titles(second), ['Nyår']);
      const third = await albums('1998', `-l 1 --cursor '${second.cursor}'`);
      assertEquals(titles(third), []);

      // A recurring walk stops at the floor too.
      const birthdays = await feed('--kind birthday --birthdays all --year 2000 -l 200');
      assert(birthdays.entries.length > 0);
      assert(birthdays.entries.every((e) => e.date.startsWith('2000-')));
      assert(titles(birthdays).includes('Björn Almqvist turns 16'));
    });

    await t.step('--year takes a plain year, alone, walking down', async () => {
      assertEquals((await client.exec('timeline --year 98')).success, false);
      assertEquals((await client.exec('timeline --year 1998 --at 1998')).success, false);
      assertEquals((await client.exec('timeline --year 1998 --dir asc --cursor 1998,x')).success, false);
    });

    await t.step('paging reproduces one big page exactly', async () => {
      const whole = await feed('-l 200');
      assert(whole.entries.length > 12, 'expected a feed worth paging');

      // Paged until it has as many as the one big page did — which is where the
      // comparison ends, since `-l 200` is itself a page and the feed may run on
      // past it.
      const paged: Entry[] = [];
      let cursor: string | null = null;
      while (paged.length < whole.entries.length) {
        const page: Page = await feed(`-l 3 ${cursor ? `--cursor ${JSON.stringify(cursor)}` : ''}`);
        if (page.entries.length === 0) break;
        paged.push(...page.entries);
        cursor = page.cursor;
        if (!cursor) break;
      }

      assertEquals(paged.slice(0, whole.entries.length).map((e) => e.key), whole.entries.map((e) => e.key));
      // No key twice: a boundary shared by two sources must not repeat one.
      assertEquals(new Set(paged.map((e) => e.key)).size, paged.length);
    });

    await t.step('entries sharing one date keep a stable order across pages', async () => {
      // Three albums with the identical timeStart: the tie-break is the key, and
      // it has to hold when the page boundary lands in the middle of them.
      for (const slug of ['tie-a', 'tie-b', 'tie-c']) {
        await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, slug, {
          props: { mode: 0o755 },
          attrs: { name: slug, timeStart: '2001-01-01T00:00:00', mediaCount: 1 },
        });
      }

      const whole = await feed('--kind album -l 200');
      const first = await feed('--kind album -l 2');
      const second = await feed(`--kind album -l 2 --cursor ${JSON.stringify(first.cursor)}`);
      assertEquals([...first.entries, ...second.entries].map((e) => e.key), whole.entries.slice(0, 4).map((e) => e.key));
    });

    await t.step('--dir asc walks back up to where it started', async () => {
      const whole = await feed('-l 200');

      // Page down four entries at a time, then climb back from the bottom.
      const down = await feed('-l 4');
      const next = await feed(`-l 4 --cursor ${JSON.stringify(down.cursor)}`);
      assertEquals([...down.entries, ...next.entries].map((e) => e.key), whole.entries.slice(0, 8).map((e) => e.key));

      // From the last entry of page two, upward is page two's earlier entries
      // and then page one — the same list, read backwards.
      const from = next.entries[next.entries.length - 1];
      const up = await feed(`-l 4 --dir asc --cursor ${JSON.stringify(`${from.date},${from.key}`)}`);
      assertEquals(up.entries.map((e) => e.key).reverse(), whole.entries.slice(3, 7).map((e) => e.key));

      const upMore = await feed(`-l 4 --dir asc --cursor ${JSON.stringify(up.cursor)}`);
      assertEquals(upMore.entries.map((e) => e.key).reverse(), whole.entries.slice(0, 3).map((e) => e.key));
      // Reaching the top means a short page, so there is nothing above it.
      assertEquals(upMore.cursor, null);
    });

    await t.step('--dir asc needs a cursor', async () => {
      assertEquals((await client.exec('timeline --dir asc')).success, false);
      assertEquals((await client.exec('timeline --dir sideways --cursor a,b')).success, false);
    });

    await t.step('facets bucket the same feed by day, month and year', async () => {
      type Facets = {
        total: number;
        range: { min: number; max: number } | null;
        days: { key: string; count: number }[];
        months: { key: string; count: number }[];
        years: { year: number; count: number }[];
        kinds: { kind: string; count: number }[];
      };

      const facets = await client.execJson<Facets>(`timeline-facets --today ${TODAY} --birthdays none --anniversaries none`);
      assertEquals(facets.range, { min: 1815, max: 2019 });

      const byMonth = new Map(facets.months.map((m) => [m.key, m.count]));
      assertEquals(byMonth.get('2019-06'), 1); // Amsterdam
      assertEquals(byMonth.get('2015-08'), 1); // the track
      // A year-only date has no month, so it buckets under its bare year.
      assertEquals(byMonth.get('1815'), 1);

      const byDay = new Map(facets.days.map((d) => [d.key, d.count]));
      assertEquals(byDay.get('2019-06-02'), 1);
      assertEquals(byDay.get('2015-08-16'), 1);
      // The year-only birth remains year-only; the facet must not invent a day.
      assertEquals([...byDay.keys()].some((key) => key.startsWith('1815-')), false);

      // Years are the rollup of the months, and the total the rollup of those.
      assertEquals(facets.years.reduce((sum, y) => sum + y.count, 0), facets.total);
      assertEquals(facets.months.reduce((sum, m) => sum + m.count, 0), facets.total);

      // Birthdays are counted only when asked for, and then dominate.
      const withBirthdays = await client.execJson<Facets>(`timeline-facets --today ${TODAY}`);
      assert(withBirthdays.total > facets.total);
      assertEquals(withBirthdays.kinds.some((k) => k.kind === 'birthday'), true);
    });

    await t.step('a residence becomes a move in and a move out', async () => {
      // The shape person-set-home writes: the span on `relation`, and its
      // indexable projection on the person-side half only.
      await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
      await cmd.shouldSucceed(`mknode -t position ${LOCATIONS_ROOT}/backen --as name=Backen`);
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/anna`, 'homes', { props: { mode: 0o775 } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${LOCATIONS_ROOT}/backen`, 'residents', { props: { mode: 0o775 } });
      await mklink(`${PEOPLE_ROOT}/anna/homes`, 'backen', `${LOCATIONS_ROOT}/backen`);
      await mklink(`${LOCATIONS_ROOT}/backen/residents`, 'anna', `${PEOPLE_ROOT}/anna`);
      await vfs.update(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/homes/backen`, {
        follow: false,
        attrs: { relation: { peerLink: `${LOCATIONS_ROOT}/backen/residents/anna`, from: '1992-08-01', to: '2003-04-15' }, movedIn: '1992-08-01', movedOut: '2003-04-15' },
      });

      const page = await feed('--kind move');
      assertEquals(titles(page), ['Anna Strand left Backen', 'Anna Strand moved to Backen']);
      // The entry is about the location — that is what a reader opens — while the
      // person it belongs to rides along as the owner.
      assertEquals(page.entries[0].path, `${LOCATIONS_ROOT}/backen`);
      assertEquals(page.entries[0].ownerPath, `${PEOPLE_ROOT}/anna`);
      assertEquals(page.entries[0].eventType, 'moved-out');

      // A residence carries `relation.from` too, so the anniversary source's
      // query sees it; only a `partners/` link is a couple, and Anna is not
      // celebrating an anniversary with a house.
      const anniversaries = await feed('--kind anniversary --anniversaries all -l 300');
      assert(anniversaries.entries.every((entry) => !entry.title.includes('Backen')));
      assertEquals(page.entries[1].eventType, 'moved-in');
      assertEquals(page.entries[0].people, [`${PEOPLE_ROOT}/anna`]);

      // The location-side half carries the same relation and must not be a second
      // copy of the same move.
      assertEquals(page.entries.length, 2);
    });

    await t.step('a move is filtered like any other kind, and counted in the facets', async () => {
      const without = await feed('--kind album,birth,death,event,track --birthdays none --anniversaries none -l 200');
      assertEquals(without.entries.some((e) => e.kind === 'move'), false);

      const facets = await client.execJson<{ kinds: { kind: string; count: number }[] }>(`timeline-facets --today ${TODAY} --kind move`);
      assertEquals(facets.kinds.find((k) => k.kind === 'move')?.count, 2);
    });

    await t.step('a move matches the location it is about', async () => {
      const page = await feed(`--kind move --location backen`);
      assertEquals(titles(page), ['Anna Strand left Backen', 'Anna Strand moved to Backen']);
    });

    await t.step('a residence with no dates is not a move', async () => {
      // A location someone lived, with nothing saying when: there is no moment to put on a feed.
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${PEOPLE_ROOT}/bjorn`, 'homes', { props: { mode: 0o775 } });
      await mklink(`${PEOPLE_ROOT}/bjorn/homes`, 'backen', `${LOCATIONS_ROOT}/backen`);

      const page = await feed('--kind move');
      assertEquals(page.entries.length, 2);
    });

    await t.step('rejects a bad kind, mode or cursor', async () => {
      assertEquals((await client.exec('timeline --kind nope')).success, false);
      assertEquals((await client.exec('timeline --birthdays sometimes')).success, false);
      assertEquals((await client.exec('timeline --cursor nocomma')).success, false);
      assertEquals((await client.exec('timeline --at notadate')).success, false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
