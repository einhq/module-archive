/**
 * Search filter tests: --tag candidates, tag intersection, --from/--to windows
 * (and their --after/--before aliases), --subject device:… matching.
 *
 * Faceted behaviour (kind, region, standalone filters, paging, starvation) is
 * covered separately in search-faceted.test.ts.
 */

import { DEVICES_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Results = { results: { path: string }[] };
const paths = (r: Results) => r.results.map((e) => e.path).sort();

Deno.test({
  name: 'search filters',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();

  // The text-query steps below fan out to `search-*` providers, which are module
  // bins and so absent from a core-only boot; without one on PATH `search` stops
  // before it reports the filters those steps assert on. A provider that
  // declares a kind and finds nothing is all they need — the fixture in
  // search-text-paging.test.ts is the one that exercises real hits.
  const setup = await testCtx.server.createShellClient();
  await setup.exec('mkdir -p /opt/bin && mkfile /opt/bin/search-fake && chmod 755 /opt/bin/search-fake');
  const provider = await vfs.open(ADMIN_ACCESS, '/opt/bin/search-fake', { mode: 'w' });
  try {
    await provider.write(
      new TextEncoder().encode(
        `[ "$1" = --kinds ] && echo '{"kinds":["photo"]}' && exit 0\n` +
          `echo '{"results":[]}'\n`,
      ),
    );
  } finally {
    await provider.close();
  }
  await setup.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
  setup.close();

  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p /media ${DEVICES_ROOT}`);
    // `subject-device` answers for a device that exists; the files only carry its path.
    for (const device of ['iphone-6', 'pixel-7', 'scanjet']) await vfs.create(ADMIN_ACCESS, 'device', DEVICES_ROOT, device);
    await client.exec('echo a > /media/old.jpg && echo b > /media/new.jpg && echo c > /media/other.jpg && echo d > /media/scan.jpg');

    await vfs.update(ADMIN_ACCESS, '/media/old.jpg', {
      attrs: { ...captureTime('2015-06-01T12:00:00'), devicePath: `${DEVICES_ROOT}/iphone-6` },
    });
    await vfs.update(ADMIN_ACCESS, '/media/new.jpg', {
      attrs: { ...captureTime('2022-08-15T09:30:00'), devicePath: `${DEVICES_ROOT}/pixel-7` },
    });
    await vfs.update(ADMIN_ACCESS, '/media/other.jpg', {
      attrs: { devicePath: `${DEVICES_ROOT}/iphone-6` },
    });
    await vfs.update(ADMIN_ACCESS, '/media/scan.jpg', {
      attrs: { devicePath: `${DEVICES_ROOT}/scanjet` },
    });

    await cmd.shouldSucceed('label add /media/old.jpg vacation');
    await cmd.shouldSucceed('label add /media/new.jpg vacation beach');
    await cmd.shouldSucceed('label add /media/other.jpg beach');

    await t.step('tag-only search lists tagged nodes', async () => {
      const res = await client.execJson<Results>('search --tag vacation');
      assertEquals(paths(res), ['/media/new.jpg', '/media/old.jpg']);
    });

    await t.step('multiple tags intersect', async () => {
      const res = await client.execJson<Results>('search --tag vacation --tag beach');
      assertEquals(paths(res), ['/media/new.jpg']);
    });

    await t.step('tag paging advances instead of re-serving the first page', async () => {
      const first = await client.execJson<Results & { cursor: string | null }>('search --tag beach -l 1');
      assertEquals(first.results.length, 1);

      const second = await client.execJson<Results & { cursor: string | null }>(
        `search --tag beach -l 1 --cursor '${first.cursor}'`,
      );
      assertEquals(second.results.length, 1);
      assertEquals(second.results[0].path === first.results[0].path, false);
    });

    await t.step('from/to filter on takenAt', async () => {
      const res = await client.execJson<Results>('search --tag vacation --from 2020');
      assertEquals(paths(res), ['/media/new.jpg']);

      const res2 = await client.execJson<Results>('search --tag vacation --to 2020');
      assertEquals(paths(res2), ['/media/old.jpg']);

      // --to is exclusive on the *bucket*: 2015 means all of 2015.
      const res3 = await client.execJson<Results>('search --tag vacation --from 2015 --to 2015');
      assertEquals(paths(res3), ['/media/old.jpg']);
    });

    await t.step('after/before remain as aliases', async () => {
      const res = await client.execJson<Results>('search --tag vacation --after 2020');
      assertEquals(paths(res), ['/media/new.jpg']);

      const res2 = await client.execJson<Results>('search --tag vacation --before 2020');
      assertEquals(paths(res2), ['/media/old.jpg']);
    });

    await t.step('device filter matches path or name', async () => {
      const res = await client.execJson<Results>('search --tag vacation --subject device:pixel-7');
      assertEquals(paths(res), ['/media/new.jpg']);

      const res2 = await client.execJson<Results>(`search --tag vacation --subject device:${DEVICES_ROOT}/iphone-6`);
      assertEquals(paths(res2), ['/media/old.jpg']);
    });

    await t.step('a device filter on its own is not limited by the scan window', async () => {
      // With no other filter the timeline drives. --subject device:… is pushed into the
      // store query, so the driver only ever produces that device's rows and the
      // --max-scan window of the newest rows cannot hide a camera's older media.
      const res = await client.execJson<Results>(`search --subject device:${DEVICES_ROOT}/iphone-6 --max-scan 1`);
      assertEquals(paths(res), ['/media/old.jpg']);

      const res2 = await client.execJson<Results>(`search --subject device:${DEVICES_ROOT}/pixel-7 --max-scan 1`);
      assertEquals(paths(res2), ['/media/new.jpg']);
    });

    await t.step('a device filter pages dated media before undated media', async () => {
      const first = await client.execJson<Results & { cursor: string | null }>(`search --subject device:${DEVICES_ROOT}/iphone-6 -l 1`);
      assertEquals(first.results.map((hit) => hit.path), ['/media/old.jpg']);

      const second = await client.execJson<Results & { cursor: string | null }>(
        `search --subject device:${DEVICES_ROOT}/iphone-6 -l 1 --cursor '${first.cursor}'`,
      );
      assertEquals(second.results.map((hit) => hit.path), ['/media/other.jpg']);

      const done = await client.execJson<Results & { cursor: string | null }>(
        `search --subject device:${DEVICES_ROOT}/iphone-6 -l 1 --cursor '${second.cursor}'`,
      );
      assertEquals(done.results, []);
      assertEquals(done.cursor, null);

      // A name sort must not make the undated member disappear.
      const byName = await client.execJson<Results>(`search --subject device:${DEVICES_ROOT}/iphone-6 --sort name`);
      assertEquals(paths(byName), ['/media/old.jpg', '/media/other.jpg']);

      // Undated stays at the tail in the opposite time direction too.
      const oldestFirst = await client.execJson<Results>(`search --subject device:${DEVICES_ROOT}/iphone-6 --sort time`);
      assertEquals(oldestFirst.results.map((hit) => hit.path), ['/media/old.jpg', '/media/other.jpg']);
    });

    await t.step('an entirely undated device still has media', async () => {
      const results = await client.execJson<Results>(`search --subject device:${DEVICES_ROOT}/scanjet`);
      assertEquals(results.results.map((hit) => hit.path), ['/media/scan.jpg']);

      const facets = await client.execJson<{ total: number; years: { year: number; count: number }[] }>(
        `search --subject device:${DEVICES_ROOT}/scanjet --facets`,
      );
      assertEquals(facets.total, 1);
      assertEquals(facets.years, []);
    });

    await t.step('a device filter counts undated members without adding date buckets', async () => {
      const facets = await client.execJson<{ total: number; years: { year: number; count: number }[] }>(
        `search --subject device:${DEVICES_ROOT}/iphone-6 --facets`,
      );
      assertEquals(facets.total, 2);
      assertEquals(facets.years, [{ year: 2015, count: 1 }]);
    });

    await t.step('a store-counted facet total is exact, whatever --max-scan says', async () => {
      // Otherwise a floor reads as a total: a camera with 20k photos would
      // claim to have exactly --max-scan of them. Time, kind and a device are
      // all pushed into the store, so the store counts them.
      type Facets = { total: number; years: { year: number; count: number }[]; truncated: boolean };
      const all = await client.execJson<Facets>('search --facets --max-scan 1');
      assertEquals(all.truncated, false);
      assertEquals(all.total, 2);
      assertEquals(all.years, [{ year: 2015, count: 1 }, { year: 2022, count: 1 }]);

      const windowed = await client.execJson<Facets>('search --facets --from 2020 --max-scan 1');
      assertEquals(windowed.total, 1);
      assertEquals(windowed.years, [{ year: 2022, count: 1 }]);

      // The undated member is in the total but has no year, exactly as the walk reports it.
      const device = await client.execJson<Facets>(`search --subject device:${DEVICES_ROOT}/iphone-6 --facets --max-scan 1`);
      assertEquals(device.truncated, false);
      assertEquals(device.total, 2);
      assertEquals(device.years, [{ year: 2015, count: 1 }]);
    });

    await t.step('a materialized source is counted whole', async () => {
      // The tag set is already in memory; stopping the count at --max-scan
      // would make it wrong for nothing.
      const whole = await client.execJson<{ total: number; truncated: boolean }>('search --tag beach --facets --max-scan 1');
      assertEquals(whole.truncated, false);
      // One of the two `beach` files has no takenAt, but total counts matches.
      assertEquals(whole.total, 2);
    });

    await t.step('a facet count that walked to the scan limit says so', async () => {
      // A document is no mimetype prefix, so this pair is told apart in JavaScript and the store
      // cannot count it.
      const capped = await client.execJson<{ total: number; truncated: boolean }>('search --kind photo,document --facets --max-scan 1');
      assertEquals(capped.truncated, true);

      const whole = await client.execJson<{ total: number; truncated: boolean }>('search --kind photo,document --facets');
      assertEquals(whole.truncated, false);

      // Media kinds are each a named count in the store, which no scan limit cuts.
      const media = await client.execJson<{ total: number; truncated: boolean }>('search --kind photo,video --facets --max-scan 1');
      assertEquals(media.truncated, false);
      assertEquals(media.total, (await client.execJson<{ total: number }>('search --kind photo,video --facets')).total);

      // A device by its bare name is resolved by its module to the same store condition.
      const byName = await client.execJson<{ total: number; truncated: boolean }>('search --subject device:iphone-6 --facets --max-scan 1');
      assertEquals([byName.total, byName.truncated], [2, false]);
    });

    await t.step('nodes without takenAt are excluded by time filters', async () => {
      const res = await client.execJson<Results>('search --tag beach --from 2000');
      assertEquals(paths(res), ['/media/new.jpg']);

      const device = await client.execJson<Results>(`search --subject device:${DEVICES_ROOT}/iphone-6 --from 2000`);
      assertEquals(paths(device), ['/media/old.jpg']);
    });

    await t.step('an unparseable date is rejected', async () => {
      await cmd.shouldFail('search --tag vacation --from notadate');
    });

    await t.step('a year typed into the query is a time filter, not text to match', async () => {
      // "sailing 2011" means sailing, in 2011. Treating the digits as text to
      // match is the one reading nobody means, and it is what a pure text search
      // does with them.
      const res = await client.execJson<Results & { filters: { from: string | null; dateFromQuery: string | null } }>(
        'search vacation 2015 --kind photo',
      );
      assertEquals(res.filters.dateFromQuery, '2015');
      assertEquals(res.filters.from, '2015');
    });

    await t.step('an explicit window beats a date in the text', async () => {
      // The flag is the more specific statement, so the text keeps its digits.
      const res = await client.execJson<Results & { filters: { from: string | null; dateFromQuery: string | null } }>(
        'search vacation 2015 --from 2020',
      );
      assertEquals(res.filters.dateFromQuery, null);
      assertEquals(res.filters.from, '2020');
    });

    await t.step('a number that is not a plausible capture year stays text', async () => {
      // Model numbers, house numbers and the year 3000 are not time filters.
      const res = await client.execJson<Results & { filters: { dateFromQuery: string | null } }>('search kodak 1200');
      assertEquals(res.filters.dateFromQuery, null);
    });

    await t.step('--at seeks the timeline driver, which pages by keyset', async () => {
      // No subject, no container, no text: the store-ordered timeline drives, and
      // it has no index to take a position in — so the seek is a bound on takenAt
      // in the direction the list runs.
      // The seek lands *at* 2020 — the row at `anchorIndex` — and carries the
      // rows above it in the same answer, so a reader can scroll either way at once.
      type Seeked = Results & { anchorIndex: number };
      const newestFirst = await client.execJson<Seeked>('search --at 2020');
      assertEquals(newestFirst.results.map((e) => e.path), ['/media/new.jpg', '/media/old.jpg']);
      assertEquals(newestFirst.anchorIndex, 1);

      // Read the other way, the same date means the start of that bucket rather
      // than the end of it.
      const oldestFirst = await client.execJson<Seeked>('search --sort time --at 2020');
      assertEquals(oldestFirst.results.map((e) => e.path), ['/media/old.jpg', '/media/new.jpg']);
      assertEquals(oldestFirst.anchorIndex, 1);
    });

    await t.step('--at seeks a materialized source too', async () => {
      // The tag source is a list, so a date is a position in it — but only once
      // the list is in time order, which is what --sort asks for.
      const seeked = await client.execJson<Results>('search --tag vacation --sort -time --at 2020');
      assertEquals(paths(seeked), ['/media/old.jpg']);
    });

    await t.step('a time sort orders the whole tag answer, not just the page', async () => {
      // Both tagged files, newest first. Sorted at the source rather than after
      // paging, so page 2 continues where page 1 stopped instead of restarting
      // the order.
      const first = await client.execJson<Results & { cursor: string | null }>('search --tag vacation --sort -time -l 1');
      assertEquals(paths(first), ['/media/new.jpg']);
      const second = await client.execJson<Results>(`search --tag vacation --sort -time -l 1 --cursor ${first.cursor}`);
      assertEquals(paths(second), ['/media/old.jpg']);
    });

    await t.step('a name sort orders the whole timeless answer, nameless nodes last', async () => {
      // Created out of name order, so id order — what the store pages on without a sort — is not it.
      await client.exec(`mkdir -p ${LOCATIONS_ROOT}`);
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'place-c', { attrs: { name: 'Place C' } });
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'place-a', { attrs: { name: 'Place A' } });
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'unnamed', {});
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'place-b', { attrs: { name: 'Place B' } });

      const pages: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const answer: Results & { cursor: string | null } = await client.execJson(
          `search --kind location --sort name -l 1${cursor ? ` --cursor '${cursor}'` : ''}`,
        );
        pages.push(...answer.results.map((hit) => hit.path.slice(LOCATIONS_ROOT.length + 1)));
        cursor = answer.cursor;
        if (!cursor) break;
      }
      assertEquals(pages, ['place-a', 'place-b', 'place-c', 'unnamed']);

      // Name is the default order for a timeless kind.
      const whole = await client.execJson<Results>('search --kind location');
      assertEquals(whole.results.map((hit) => hit.path.slice(LOCATIONS_ROOT.length + 1)), ['place-a', 'place-b', 'place-c', 'unnamed']);
    });

    await t.step('a name sort is in the archive language, read when the search runs', async () => {
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'zeta', { attrs: { name: 'Zeta' } });
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'aerla', { attrs: { name: 'Ärla' } });
      const order = async () => (await client.execJson<Results>('search --kind location')).results.map((hit) => hit.path.slice(LOCATIONS_ROOT.length + 1));

      assertEquals(await order(), ['aerla', 'place-a', 'place-b', 'place-c', 'zeta', 'unnamed']);
      await client.exec(`echo "export CFG_LANGUAGE='sv'" >> /etc/config`);
      assertEquals(await order(), ['place-a', 'place-b', 'place-c', 'zeta', 'aerla', 'unnamed']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
