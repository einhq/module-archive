/**
 * find-within tests, with position-set and find-containing as the setup they need
 *
 * Shape semantics (centroid, containment, bbox) are covered by the position
 * registry conformance suite; here we check the shell command paths end-to-end
 * against the memory registry.
 */

import { assertEquals } from '@std/assert';
import type { PositionData } from '@ein/client';
import { captureTime, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

const SQUARE = [
  { lat: 57.684, lng: 11.942 },
  { lat: 57.684, lng: 11.946 },
  { lat: 57.686, lng: 11.946 },
  { lat: 57.686, lng: 11.942 },
];

type FindResults = {
  results: { id: string; paths: string[]; takenAt?: string; takenAtUtc?: string; width?: number; height?: number; angle?: number }[];
};

type Paged = FindResults & { cursor: string | null; total: number };

type Facets = {
  total: number;
  range: { min: number; max: number } | null;
  days: { key: string; count: number }[];
  months: { key: string; count: number }[];
  years: { year: number; count: number }[];
};

type ClusterResults = FindResults & {
  clusters: {
    key: string;
    lat: number;
    lng: number;
    count: number;
    hit?: { id: string; paths: string[]; takenAt?: string; takenAtUtc?: string; width?: number; height?: number; angle?: number };
    hits?: { id: string; paths: string[]; takenAt?: string; takenAtUtc?: string; width?: number; height?: number; angle?: number }[];
    cover?: { id: string; paths: string[] };
  }[];
  total: number;
  truncated: boolean;
};

Deno.test({
  name: 'find-within',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('position-set writes a point with radius', async () => {
      await cmd.shouldSucceed('mknode -t position /loc-home');
      await cmd.shouldSucceed('position-set /loc-home --lat=57.7 --lng=11.97 --radius 500');

      const data = await client.execJson<PositionData>('cat /loc-home');
      assertEquals(data, { lat: 57.7, lng: 11.97, radius: 500 });
    });

    await t.step('position-set writes a polygon and recenters on the centroid', async () => {
      await cmd.shouldSucceed('mknode -t position /loc-park');
      await cmd.shouldSucceed(`position-set /loc-park --polygon '${JSON.stringify(SQUARE)}'`);

      const data = await client.execJson<PositionData>('cat /loc-park');
      assertEquals(data.polygon, SQUARE);
      assertEquals(data.lat > 57.684 && data.lat < 57.686, true);
      assertEquals(data.lng > 11.942 && data.lng < 11.946, true);
    });

    await t.step('find-containing resolves matches to paths', async () => {
      const inside = await client.execJson<FindResults>('find-containing 57.685 11.944');
      assertEquals(inside.results.some((r) => r.paths.includes('/loc-park')), true);
      // /loc-home is 500m-radius circle far from the polygon
      assertEquals(inside.results.some((r) => r.paths.includes('/loc-home')), false);

      const outside = await client.execJson<FindResults>('find-containing 57.9 11.5');
      assertEquals(outside.results.length, 0);
    });

    await t.step('find-within returns points inside the bounding box', async () => {
      const hits = await client.execJson<FindResults>('find-within --north=57.75 --south=57.65 --east=12.0 --west=11.9');
      const paths = hits.results.flatMap((r) => r.paths);
      assertEquals(paths.includes('/loc-home'), true);
      assertEquals(paths.includes('/loc-park'), true);

      const none = await client.execJson<FindResults>('find-within --north=10 --south=9 --east=10 --west=9');
      assertEquals(none.results.length, 0);
    });

    await t.step('negative bounds survive argument parsing', async () => {
      // Seattle: negative longitude, which is the whole point of this step.
      await cmd.shouldSucceed('mknode -t position /loc-west');
      await cmd.shouldSucceed('position-set /loc-west --lat=47.6205 --lng=-122.3493');

      // The `=` form carries a negative edge through parseArgs intact.
      const world = await client.execJson<FindResults>('find-within --north=90 --south=-90 --east=180 --west=-180 --limit=5000');
      const worldPaths = world.results.flatMap((r) => r.paths);
      assertEquals(worldPaths.includes('/loc-home'), true);
      assertEquals(worldPaths.includes('/loc-west'), true);

      // A box wholly in the western hemisphere finds only what is there.
      const west = await client.execJson<FindResults>('find-within --north=48 --south=47 --east=-122 --west=-123');
      const westPaths = west.results.flatMap((r) => r.paths);
      assertEquals(westPaths.includes('/loc-west'), true);
      assertEquals(westPaths.includes('/loc-home'), false);

      // The space form cannot express a negative edge — parseArgs leaves it
      // empty — so it fails rather than answer for the north-east quadrant.
      await cmd.shouldFailWith('find-within --north 90 --south -90 --east 180 --west -180', 'requires numeric --south');

      // `--lat=`/`--lng=` carries a western longitude to find-containing, which two
      // positionals cannot: `-122.3493` reads as a flag. A circle, because
      // find-containing matches shapes.
      await cmd.shouldSucceed('mknode -t position /loc-west-circle');
      await cmd.shouldSucceed('position-set /loc-west-circle --lat=47.6205 --lng=-122.3493 --radius=1000');

      const containingWest = await client.execJson<FindResults>('find-containing --lat=47.6205 --lng=-122.3493');
      assertEquals(containingWest.results.some((r) => r.paths.includes('/loc-west-circle')), true);

      // The positional form still works where no value carries a leading dash.
      const positional = await client.execJson<FindResults>('find-containing 57.685 11.944');
      assertEquals(positional.results.some((r) => r.paths.includes('/loc-park')), true);

      // ...and still cannot carry a negative one, so it must say so rather than
      // silently answer about somewhere else.
      await cmd.shouldFailWith('find-containing 47.6205 -122.3493', 'requires numeric lat and lng');
    });

    /**
     * Date a fixture photo the way the pipeline does — the wall clock *and* the instant.
     *
     * `attrs -s takenAt=...` alone leaves a file that is invisible to every time-ordered answer,
     * because ordering and cursors are on `takenAtUtc`, and the symptom
     * is an empty page rather than an error.
     */
    const dateFixture = async (path: string, wallClock: string) => {
      const attrs = captureTime(wallClock) as { takenAt: string; takenAtUtc?: string };
      await cmd.shouldSucceed(`attrs ${path} -s takenAt=${attrs.takenAt}`);
      if (attrs.takenAtUtc) await cmd.shouldSucceed(`attrs ${path} -s takenAtUtc=${attrs.takenAtUtc}`);
    };

    await t.step('find-within reports takenAt and filters on it', async () => {
      // A geotagged photo is a file with a `position` child; the date lives on
      // the file, one level above what the registry matches.
      for (const [name, takenAt] of [['old', '2015-06-01T10:00:00'], ['new', '2021-03-04T08:30:00']]) {
        await cmd.shouldSucceed(`mkfile /photo-${name}.jpg`);
        await dateFixture(`/photo-${name}.jpg`, takenAt);
        await cmd.shouldSucceed(`mknode -t position /photo-${name}.jpg/position`);
        await cmd.shouldSucceed(`position-set /photo-${name}.jpg/position --lat=57.7 --lng=11.97`);
      }

      const box = '--north=57.75 --south=57.65 --east=12.0 --west=11.9';
      const all = await client.execJson<FindResults>(`find-within ${box}`);
      const dated = new Map(all.results.flatMap((r) => r.paths.map((p) => [p, r.takenAt])));
      assertEquals(dated.get('/photo-old.jpg/position'), '2015-06-01T10:00:00');
      assertEquals(dated.get('/photo-new.jpg/position'), '2021-03-04T08:30:00');
      // A location has no takenAt, and reports none rather than a wrong one.
      assertEquals(dated.get('/loc-park'), undefined);

      // --to covers the whole year it names.
      const y2015 = await client.execJson<FindResults>(`find-within ${box} --from 2015 --to 2015`);
      const p2015 = y2015.results.flatMap((r) => r.paths);
      assertEquals(p2015.includes('/photo-old.jpg/position'), true);
      assertEquals(p2015.includes('/photo-new.jpg/position'), false);
      // Dateless positions survive a time bound — a year slider is about media.
      assertEquals(p2015.includes('/loc-park'), true);

      const from2020 = await client.execJson<FindResults>(`find-within ${box} --from 2020`);
      const p2020 = from2020.results.flatMap((r) => r.paths);
      assertEquals(p2020.includes('/photo-new.jpg/position'), true);
      assertEquals(p2020.includes('/photo-old.jpg/position'), false);

      // A scan with no EXIF date must not turn up inside every window the slider
      // is dragged to — that reads as a filter that does not work.
      await cmd.shouldSucceed('mkfile /photo-undated.jpg');
      await cmd.shouldSucceed('mknode -t position /photo-undated.jpg/position');
      await cmd.shouldSucceed('position-set /photo-undated.jpg/position --lat=57.7 --lng=11.97');

      const undated = await client.execJson<FindResults>(`find-within ${box}`);
      assertEquals(undated.results.flatMap((r) => r.paths).includes('/photo-undated.jpg/position'), true);
      const bounded = await client.execJson<FindResults>(`find-within ${box} --from 2015 --to 2015`);
      assertEquals(bounded.results.flatMap((r) => r.paths).includes('/photo-undated.jpg/position'), false);

      await cmd.shouldFailWith(`find-within ${box} --from notayear`, `cannot parse --from date 'notayear'`);
    });

    await t.step('the flat answer is newest first and pages by cursor', async () => {
      // Four dated photos on one spot plus one undated, so a page boundary
      // falls inside the run and the undated one has somewhere to sort to.
      for (
        const [name, takenAt] of [
          ['p1', '2011-01-01T00:00:00'],
          ['p2', '2012-01-01T00:00:00'],
          ['p3', '2013-01-01T00:00:00'],
          ['p4', '2014-01-01T00:00:00'],
          ['p5', ''],
        ] as [string, string][]
      ) {
        await cmd.shouldSucceed(`mkfile /pg-${name}.jpg`);
        if (takenAt) await dateFixture(`/pg-${name}.jpg`, takenAt);
        await cmd.shouldSucceed(`mknode -t position /pg-${name}.jpg/position`);
        await cmd.shouldSucceed(`position-set /pg-${name}.jpg/position --lat=30 --lng=30`);
      }

      const box = '--north=31 --south=29 --east=31 --west=29';
      const names = (page: Paged) => page.results.flatMap((r) => r.paths).map((p) => p.split('/')[1]);

      const first = await client.execJson<Paged>(`find-within ${box} --limit=2`);
      assertEquals(names(first), ['pg-p4.jpg', 'pg-p3.jpg']);
      assertEquals(first.cursor !== null, true);
      assertEquals(first.total, 5);

      const second = await client.execJson<Paged>(`find-within ${box} --limit=2 --cursor='${first.cursor}'`);
      assertEquals(names(second), ['pg-p2.jpg', 'pg-p1.jpg']);

      // Undated sorts last, and the page that reaches the end says so.
      const third = await client.execJson<Paged>(`find-within ${box} --limit=2 --cursor='${second.cursor}'`);
      assertEquals(names(third), ['pg-p5.jpg']);
      assertEquals(third.cursor, null);

      // Following the cursor visits every row exactly once.
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const flag: string = cursor === null ? '' : ` --cursor='${cursor}'`;
        const page: Paged = await client.execJson<Paged>(`find-within ${box} --limit=2${flag}`);
        walked.push(...names(page));
        cursor = page.cursor;
        if (cursor === null) break;
      }
      assertEquals(walked, ['pg-p4.jpg', 'pg-p3.jpg', 'pg-p2.jpg', 'pg-p1.jpg', 'pg-p5.jpg']);
      assertEquals(new Set(walked).size, walked.length);
    });

    await t.step('--dir asc walks back towards the newest', async () => {
      // The paging fixtures again: 2011..2014 one apiece, plus one undated.
      const box = '--north=31 --south=29 --east=31 --west=29';
      const names = (page: Paged) => page.results.flatMap((r) => r.paths).map((p) => p.split('/')[1]);

      // Stand where a reader who jumped into 2012 would: the page below them is
      // 2012 and 2011, and everything newer is above and not loaded.
      const down = await client.execJson<Paged>(`find-within ${box} --limit=2 --to=2012`);
      assertEquals(names(down), ['pg-p2.jpg', 'pg-p1.jpg']);

      // The client builds an upward cursor from a row it is holding, so the
      // encoding is the same `<takenAtUtc>,<id>` the answer hands back — the instant, which is
      // what the list is ordered on.
      const cursorOf = (page: Paged, index: number) => {
        const row = page.results[index];
        return `${row.takenAtUtc ?? ''},${row.id}`;
      };

      // Climbing from the top row of that page returns the rows *newer* than it,
      // oldest-first — the order they are walked, which the caller reverses
      // before prepending.
      const climbed = await client.execJson<Paged>(`find-within ${box} --limit=2 --dir=asc --cursor='${cursorOf(down, 0)}'`);
      assertEquals(names(climbed), ['pg-p3.jpg', 'pg-p4.jpg']);

      // And the walk terminates at the newest rather than wrapping.
      const top = await client.execJson<Paged>(`find-within ${box} --limit=2 --dir=asc --cursor='${cursorOf(climbed, 1)}'`);
      assertEquals(names(top), []);
      assertEquals(top.cursor, null);

      // Undated sorts past the oldest going down, so it is where an upward walk
      // starts from — and from there everything dated is above it.
      const whole = await client.execJson<Paged>(`find-within ${box} --limit=5`);
      assertEquals(names(whole)[4], 'pg-p5.jpg');
      const fromUndated = await client.execJson<Paged>(`find-within ${box} --limit=10 --dir=asc --cursor='${cursorOf(whole, 4)}'`);
      assertEquals(names(fromUndated), ['pg-p1.jpg', 'pg-p2.jpg', 'pg-p3.jpg', 'pg-p4.jpg']);

      await cmd.shouldFailWith(`find-within ${box} --dir=asc`, '--dir asc needs a --cursor');
      await cmd.shouldFailWith(`find-within ${box} --dir=sideways --cursor=x,y`, "unknown --dir 'sideways'");
      await cmd.shouldFailWith(`find-within ${box} --dir=asc --cursor=x,y --cell=1`, '--cursor pages the flat answer');
    });

    await t.step('a hit carries the shape the grid needs to lay it out', async () => {
      await cmd.shouldSucceed('mkfile /dim-photo.jpg');
      // -J, so the dimensions are stored as numbers, which is what
      // `exif-extract` promotes and what the grid arithmetic needs.
      await cmd.shouldSucceed(
        'attrs /dim-photo.jpg -J width=4032 -J height=3024 -J angle=90',
      );
      await dateFixture('/dim-photo.jpg', '2018-05-05T12:00:00');
      await cmd.shouldSucceed('mknode -t position /dim-photo.jpg/position');
      await cmd.shouldSucceed('position-set /dim-photo.jpg/position --lat=40 --lng=40');

      const box = '--north=41 --south=39 --east=41 --west=39';
      const flat = await client.execJson<Paged>(`find-within ${box}`);
      assertEquals(flat.results[0].width, 4032);
      assertEquals(flat.results[0].height, 3024);
      assertEquals(flat.results[0].angle, 90);

      // The lone hit inside a cluster is opened in the lightbox, so it needs
      // the same.
      const grid = await client.execJson<ClusterResults>(`find-within ${box} --cell=10`);
      assertEquals(grid.clusters[0].hit?.width, 4032);
      assertEquals(grid.clusters[0].hit?.angle, 90);
    });

    await t.step('--cursor is rejected where it would mean nothing', async () => {
      const box = '--north=41 --south=39 --east=41 --west=39';
      await cmd.shouldFailWith(`find-within ${box} --cell=1 --cursor=x,y`, '--cursor pages the flat answer');
      await cmd.shouldFailWith(`find-within ${box} --cursor=nocomma`, "cannot parse --cursor 'nocomma'");
    });

    await t.step('--cell answers with counts, and paths only for a lone hit', async () => {
      // Away from every other fixture, so the counts below say what they mean.
      // Two photos share a spot, two more sit a degree away — one crowded cell
      // and two lone pictures, which is the distinction the map draws.
      for (
        const [name, lat, lng, takenAt] of [
          ['near-a', 20, 20, '2019-07-01T12:00:00'],
          ['near-b', 20.0001, 20.0001, '2019-07-01T12:00:00'],
          ['far', 21, 20, '2015-06-01T10:00:00'],
          ['nodate', 21, 20.5, ''],
        ] as [string, number, number, string][]
      ) {
        await cmd.shouldSucceed(`mkfile /cl-${name}.jpg`);
        if (takenAt) await dateFixture(`/cl-${name}.jpg`, takenAt);
        await cmd.shouldSucceed(`mknode -t position /cl-${name}.jpg/position`);
        await cmd.shouldSucceed(`position-set /cl-${name}.jpg/position --lat=${lat} --lng=${lng}`);
      }

      const box = '--north=22 --south=19 --east=21 --west=19';
      const grid = await client.execJson<ClusterResults>(`find-within ${box} --cell=0.5`);

      const crowded = grid.clusters.find((c) => c.count > 1);
      assertEquals(crowded?.count, 2);
      // A cluster is a number on a map: no id, no path, nothing resolved.
      assertEquals(crowded?.hit, undefined);
      assertEquals(crowded?.hits, undefined);
      // The marker sits at the centroid of what it stands for.
      assertEquals(crowded !== undefined && crowded.lat > 20 && crowded.lat < 20.001, true);

      const lone = grid.clusters.find((c) => c.hit?.paths.includes('/cl-far.jpg/position'));
      assertEquals(lone?.count, 1);
      assertEquals(lone?.hit?.takenAt, '2015-06-01T10:00:00');

      // Every geotagged photo in the box is counted, none dropped by a cap.
      assertEquals(grid.total, 4);
      assertEquals(grid.truncated, false);
      assertEquals(grid.clusters.reduce((sum, c) => sum + c.count, 0), 4);

      // A cell large enough to hold the whole box collapses to one marker.
      const single = await client.execJson<ClusterResults>(`find-within ${box} --cell=10`);
      assertEquals(single.clusters.length, 1);
      assertEquals(single.clusters[0].count, single.total);
      assertEquals(single.clusters[0].hit, undefined);

      // A bounded interactive search can pay the path-resolution cost once and
      // hand a small cluster straight to its dialog.
      const reusable = await client.execJson<ClusterResults>(`find-within ${box} --cell=0.5 --include-hits`);
      const reusableCrowd = reusable.clusters.find((c) => c.count > 1);
      assertEquals(reusableCrowd?.hits?.map((hit) => hit.paths[0]).sort(), ['/cl-near-a.jpg/position', '/cl-near-b.jpg/position']);

      // A map that draws piles as pictures asks for one cover a cell; a lone picture stays a hit.
      const covered = await client.execJson<ClusterResults>(`find-within ${box} --cell=0.5 --covers`);
      const coveredCrowd = covered.clusters.find((c) => c.count > 1);
      assertEquals(['/cl-near-a.jpg/position', '/cl-near-b.jpg/position'].includes(coveredCrowd?.cover?.paths[0] ?? ''), true);
      assertEquals(coveredCrowd?.hit, undefined);
      assertEquals(covered.clusters.find((c) => c.count === 1)?.cover, undefined);
    });

    await t.step('--cell keeps locations out of the grid', async () => {
      // A location is a name on a map, not one of a hundred pictures behind a
      // number, so it keeps its own marker however far the view is zoomed out.
      const grid = await client.execJson<ClusterResults>(
        'find-within --north=57.75 --south=57.65 --east=12.0 --west=11.9 --cell=10',
      );

      const locationPaths = grid.results.flatMap((r) => r.paths);
      assertEquals(locationPaths.includes('/loc-park'), true);
      assertEquals(locationPaths.some((p) => p.endsWith('/position')), false);
      // The photos in that box are in the grid instead.
      assertEquals(grid.total > 0, true);
    });

    await t.step('--cell counts respect the year filter', async () => {
      const box = '--north=22 --south=19 --east=21 --west=19';
      const all = await client.execJson<ClusterResults>(`find-within ${box} --cell=10`);
      assertEquals(all.total, 4);

      const y2019 = await client.execJson<ClusterResults>(`find-within ${box} --cell=10 --from=2019 --to=2019`);
      assertEquals(y2019.total, 2);

      // Undated media is dropped here for the same reason as in the flat
      // answer: it would otherwise sit in every window the slider is dragged
      // to. Both of these windows leave it out.
      const y2015 = await client.execJson<ClusterResults>(`find-within ${box} --cell=10 --from=2015 --to=2015`);
      assertEquals(y2015.total, 1);
      assertEquals(y2015.clusters[0].hit?.paths.includes('/cl-far.jpg/position'), true);

      // Locations have no date and are never dropped by it.
      const dated = await client.execJson<ClusterResults>(
        'find-within --north=57.75 --south=57.65 --east=12.0 --west=11.9 --cell=10 --from=2015 --to=2015',
      );
      assertEquals(dated.results.flatMap((r) => r.paths).includes('/loc-park'), true);
    });

    await t.step('--cell dates a position under two files by the earlier one', async () => {
      await cmd.shouldSucceed('mkfile /cl-shared-old.jpg && mkfile /cl-shared-new.jpg');
      await dateFixture('/cl-shared-old.jpg', '2003-04-01T12:00:00');
      await dateFixture('/cl-shared-new.jpg', '2024-04-01T12:00:00');
      await cmd.shouldSucceed('mknode -t position /cl-shared-old.jpg/position');
      await cmd.shouldSucceed('position-set /cl-shared-old.jpg/position --lat=-30 --lng=-30');
      await cmd.shouldSucceed('ln /cl-shared-old.jpg/position /cl-shared-new.jpg/position');

      const box = '--north=-29 --south=-31 --east=-29 --west=-31';
      assertEquals((await client.execJson<ClusterResults>(`find-within ${box} --cell=10 --from=2003 --to=2003`)).total, 1);
      assertEquals((await client.execJson<ClusterResults>(`find-within ${box} --cell=10 --from=2024 --to=2024`)).total, 0);
      const flat = await client.execJson<Paged>(`find-within ${box} --from=2003 --to=2003`);
      assertEquals(flat.results.map((r) => r.takenAt), ['2003-04-01T12:00:00']);
    });

    await t.step('--facets counts the box by day, month and year', async () => {
      // The paging fixtures: 2011..2014 one apiece, plus one undated.
      const box = '--north=31 --south=29 --east=31 --west=29';
      const facets = await client.execJson<Facets>(`find-within ${box} --facets`);

      assertEquals(facets.years, [
        { year: 2011, count: 1 },
        { year: 2012, count: 1 },
        { year: 2013, count: 1 },
        { year: 2014, count: 1 },
      ]);
      assertEquals(facets.months[0], { key: '2011-01', count: 1 });
      assertEquals(facets.days, [
        { key: '2011-01-01', count: 1 },
        { key: '2012-01-01', count: 1 },
        { key: '2013-01-01', count: 1 },
        { key: '2014-01-01', count: 1 },
      ]);
      assertEquals(facets.range, { min: 2011, max: 2014 });

      // Undated media has no year to be counted under, so the rail's total is
      // what the rail can reach — not the five rows the box holds.
      assertEquals(facets.total, 4);

      // The same window the pages are cut with narrows the counts too.
      const windowed = await client.execJson<Facets>(`find-within ${box} --facets --from=2012 --to=2013`);
      assertEquals(windowed.years, [{ year: 2012, count: 1 }, { year: 2013, count: 1 }]);
      assertEquals(windowed.days, [{ key: '2012-01-01', count: 1 }, { key: '2013-01-01', count: 1 }]);
      assertEquals(windowed.total, 2);

      // A location has no date either, so a box with only locations counts nothing.
      const locations = await client.execJson<Facets>('find-within --north=57.6851 --south=57.6849 --east=11.9421 --west=11.9419 --facets');
      assertEquals(locations.total, 0);
      assertEquals(locations.range, null);

      await cmd.shouldFailWith(`find-within ${box} --facets --cell=1`, '--facets counts the flat answer');
    });

    await t.step('--facets counts a year-only date under its year', async () => {
      const box = '--north=33 --south=32 --east=33 --west=32';
      for (const [name, takenAt] of [['year', '1975'], ['month', '1975-06'], ['day', '1975-06-14T12:00:00']]) {
        await cmd.shouldSucceed(`mkfile /partial-${name}.jpg`);
        await dateFixture(`/partial-${name}.jpg`, takenAt);
        await cmd.shouldSucceed(`mknode -t position /partial-${name}.jpg/position`);
        await cmd.shouldSucceed(`position-set /partial-${name}.jpg/position --lat=32.5 --lng=32.5`);
      }

      const facets = await client.execJson<Facets>(`find-within ${box} --facets`);
      assertEquals(facets.days, [{ key: '1975-06-14', count: 1 }]);
      assertEquals(facets.months, [{ key: '1975', count: 1 }, { key: '1975-06', count: 2 }]);
      assertEquals(facets.years, [{ year: 1975, count: 3 }]);
      assertEquals(facets.total, 3);
    });

    await t.step('--cell rejects a nonsense grid', async () => {
      const box = '--north=59 --south=57 --east=12.5 --west=11.5';
      await cmd.shouldFailWith(`find-within ${box} --cell=0`, 'positive --cell');
      await cmd.shouldFailWith(`find-within ${box} --cell=abc`, 'positive --cell');
      await cmd.shouldFailWith(`find-within ${box} --limit=abc`, 'positive --limit');
    });

    await t.step('position-set --clear removes the shape', async () => {
      await cmd.shouldSucceed('position-set /loc-home --clear');

      const hits = await client.execJson<FindResults>('find-within --north=57.75 --south=57.65 --east=12.0 --west=11.9');
      assertEquals(hits.results.flatMap((r) => r.paths).includes('/loc-home'), false);
    });

    await t.step('rejects invalid input', async () => {
      await cmd.shouldSucceed('mkfile /loc-notloc');
      await cmd.shouldFailWith('position-set /loc-notloc --lat=1 --lng=2', 'not position');
      await cmd.shouldFailWith('position-set /loc-home --lat=1', 'requires --lat and --lng');
      await cmd.shouldFailWith(`position-set /loc-home --polygon '[{"lat":1,"lng":2}]'`, 'at least 3');
      await cmd.shouldFailWith('find-within --north=1 --south=0 --east=1', 'requires numeric --west');
      await cmd.shouldFailWith('find-containing 57.7', 'requires numeric lat and lng');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
