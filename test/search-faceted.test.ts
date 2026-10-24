/**
 * Faceted search: every filter usable on its own, the refill loop that stops
 * narrow filters from starving a page, cursor paging, and facets.
 */

import { assert, assertEquals } from '@std/assert';
import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Hit = {
  path: string;
  kind?: string;
  type: string;
  name: string;
  mimetype?: string;
  takenAt?: string;
  score: number;
};
type Results = { results: Hit[]; truncated: boolean; cursor: string | null };

const names = (r: Results) => r.results.map((e) => e.path.split('/').pop()).sort();

Deno.test({
  name: 'faceted search',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec('mkdir -p /media');

    const fixtures: [name: string, mimetype: string, takenAt: string][] = [
      ['p1995.jpg', 'image/jpeg', '1995-06-01T10:00:00'],
      ['p1998.jpg', 'image/jpeg', '1998-03-12T08:30:00'],
      ['p2001.jpg', 'image/jpeg', '2001-01-01T00:00:00'],
      ['v1998.mp4', 'video/mp4', '1998-11-20T22:00:00'],
      ['v2010.mp4', 'video/mp4', '2010-05-05T12:00:00'],
      ['a2005.mp3', 'audio/mpeg', '2005-02-02T02:00:00'],
    ];

    for (const [name, mimetype, takenAt] of fixtures) {
      await client.exec(`echo x > /media/${name}`);
      // `captureTime` writes the pair a real writer would — the wall clock *and* the instant
      // that orders it. A fixture that sets `takenAt` alone is invisible to every time-ordered
      // query, and shows up as an empty result rather than as an error.
      await vfs.update(ADMIN_ACCESS, `/media/${name}`, { attrs: { mimetype, ...captureTime(takenAt) } });
    }

    // A rendition: must never surface as a result of its own (marked by a
    // sourceId pointing at the original it derives from).
    await client.exec('echo t > /media/thumb.webp');
    await vfs.update(ADMIN_ACCESS, '/media/thumb.webp', {
      attrs: { mimetype: 'image/webp', ...captureTime('1998-03-12T08:30:00'), sourceId: 'p1998-original' },
    });

    await t.step('time filter works with no query at all', async () => {
      const res = await client.execJson<Results>('search --from 1995 --to 1999');
      assertEquals(names(res), ['p1995.jpg', 'p1998.jpg', 'v1998.mp4']);
    });

    await t.step('kind filter works on its own', async () => {
      const res = await client.execJson<Results>('search --kind video');
      assertEquals(names(res), ['v1998.mp4', 'v2010.mp4']);
    });

    await t.step('time and kind combine', async () => {
      const res = await client.execJson<Results>('search --kind photo --from 1995 --to 1999');
      assertEquals(names(res), ['p1995.jpg', 'p1998.jpg']);
    });

    await t.step('multiple kinds are OR-ed via post-filtering', async () => {
      const res = await client.execJson<Results>('search --kind video,audio');
      assertEquals(names(res), ['a2005.mp3', 'v1998.mp4', 'v2010.mp4']);
    });

    await t.step('renditions never appear', async () => {
      const res = await client.execJson<Results>('search --from 1998 --to 1998');
      assertEquals(names(res), ['p1998.jpg', 'v1998.mp4']);
    });

    await t.step('kind is reported on every hit', async () => {
      const res = await client.execJson<Results>('search --kind photo --from 2001 --to 2001');
      assertEquals(res.results.length, 1);
      assertEquals(res.results[0].kind, 'photo');
      assertEquals(res.results[0].mimetype, 'image/jpeg');
      assertEquals(res.results[0].takenAt, '2001-01-01T00:00:00');
    });

    await t.step('default sort is newest first', async () => {
      const res = await client.execJson<Results>('search --kind photo');
      assertEquals(res.results.map((r) => r.path.split('/').pop()), ['p2001.jpg', 'p1998.jpg', 'p1995.jpg']);
    });

    await t.step('--sort time reverses it', async () => {
      const res = await client.execJson<Results>('search --kind photo --sort time');
      assertEquals(res.results.map((r) => r.path.split('/').pop()), ['p1995.jpg', 'p1998.jpg', 'p2001.jpg']);
    });

    await t.step('a narrow filter still fills the page (no starvation)', async () => {
      // 50 decoys sharing the year, only 3 of which are audio. With -l 5 the
      // old provider-then-filter shape would have returned at most 1-2.
      await client.exec('mkdir -p /decoys');
      for (let i = 0; i < 50; i++) {
        await client.exec(`echo d > /decoys/d${i}.jpg`);
        await vfs.update(ADMIN_ACCESS, `/decoys/d${i}.jpg`, {
          attrs: { mimetype: 'image/jpeg', ...captureTime(`1977-01-01T00:00:${String(i % 60).padStart(2, '0')}`) },
        });
      }
      for (let i = 0; i < 3; i++) {
        await client.exec(`echo n > /decoys/n${i}.mp3`);
        await vfs.update(ADMIN_ACCESS, `/decoys/n${i}.mp3`, {
          attrs: { mimetype: 'audio/mpeg', ...captureTime(`1977-06-01T00:0${i}:00`) },
        });
      }

      const res = await client.execJson<Results>('search --kind audio --from 1977 --to 1978 -l 5');
      assertEquals(names(res), ['n0.mp3', 'n1.mp3', 'n2.mp3']);
    });

    await t.step('cursor paging covers every row exactly once', async () => {
      const all = await client.execJson<Results>('search --kind photo --from 1977 --to 1978 -l 200');
      assertEquals(all.results.length, 50);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const flag: string = cursor ? ` --cursor '${cursor}'` : '';
        const page: Results = await client.execJson<Results>(
          `search --kind photo --from 1977 --to 1978 -l 10${flag}`,
        );
        if (page.results.length === 0) break;
        seen.push(...page.results.map((r) => r.path));
        cursor = page.cursor;
        if (!cursor) break;
      }

      assertEquals(seen.length, 50);
      assertEquals(new Set(seen).size, 50);
    });

    await t.step('a seeked list pages upward with --above until the top', async () => {
      // The 50 decoys of 1977 are one second apart. Seek into their middle,
      // then walk back up to the newest one: every row above the seek must be
      // reached exactly once, in list order, and the walk must know when to stop.
      type Paged = Results & { above: string | null; anchorIndex: number };
      const all = await client.execJson<Results>('search --kind photo --from 1977 --to 1978 -l 200');
      const newestFirst = all.results.map((r) => r.path);

      // A seeked page carries a page's worth of rows above the seek as well, so
      // the reader lands with somewhere to scroll up into; `anchorIndex` says
      // where the seek itself begins.
      const seeked = await client.execJson<Paged>('search --kind photo --from 1977 --to 1978 -l 10 --at 1977-01-01T00:00:25');
      assertEquals(seeked.results.length, 20);
      assertEquals(seeked.anchorIndex, 10);
      const seekIndex = newestFirst.indexOf(seeked.results[seeked.anchorIndex].path);
      assertEquals(seekIndex > 10, true);
      assertEquals(seeked.results.map((r) => r.path), newestFirst.slice(seekIndex - 10, seekIndex + 10));
      assertEquals(typeof seeked.above, 'string');

      const climbed: string[] = seeked.results.slice(0, seeked.anchorIndex).map((r) => r.path);
      let above = seeked.above;
      for (let guard = 0; guard < 20 && above; guard++) {
        const page: Paged = await client.execJson<Paged>(`search --kind photo --from 1977 --to 1978 -l 7 --above '${above}'`);
        // Each page arrives in list order and sits directly above what came before it.
        climbed.unshift(...page.results.map((r) => r.path));
        assertEquals(page.cursor, null);
        above = page.above;
      }

      assertEquals(climbed, newestFirst.slice(0, seekIndex));
      assertEquals(above, null);

      // A page that starts at the top has nothing above it, and says so.
      const top = await client.execJson<Paged>('search --kind photo --from 1977 --to 1978 -l 10');
      assertEquals(top.above, null);
      assertEquals(top.anchorIndex, 0);

      // A seek near the top has a short lead and knows it is the top.
      const near = await client.execJson<Paged>('search --kind photo --from 1977 --to 1978 -l 10 --at 1977-01-01T00:00:57');
      assertEquals(near.anchorIndex, newestFirst.indexOf(near.results[near.anchorIndex].path));
      assertEquals(near.above, null);
    });

    await t.step('field discipline: no attrs/children leak into results', async () => {
      const res = await client.execJson<Results>('search --kind photo -l 200');
      const allowed = new Set([
        'path',
        'kind',
        'type',
        'name',
        'mimetype',
        'takenAt',
        // The instant, beside the wall clock. Both travel because a hit is also a *provider*
        // result — `providerSource` feeds these back in as candidates, and one arriving without
        // the ordering key would have to be re-read from the store before it could be sorted.
        'takenAtUtc',
        'score',
        'lat',
        'lng',
        'width',
        'height',
        'angle',
        'description',
        // Who may change the file, so a page offers only what the reader may do to it.
        'ownership',
      ]);
      for (const hit of res.results) {
        for (const key of Object.keys(hit)) {
          assert(allowed.has(key), `unexpected field '${key}' in search result`);
        }
      }
    });

    await t.step('region filters by bbox, circle and polygon', async () => {
      // Gothenburg-ish and Stockholm-ish, far enough apart that a tight
      // region around one never catches the other.
      const geo = [
        { name: 'gbg.jpg', lat: 57.7089, lng: 11.9746 },
        { name: 'sthlm.jpg', lat: 59.3293, lng: 18.0686 },
      ];
      await client.exec('mkdir -p /geo');
      for (const point of geo) {
        await client.exec(`echo g > /geo/${point.name}`);
        await vfs.update(ADMIN_ACCESS, `/geo/${point.name}`, {
          attrs: { mimetype: 'image/jpeg', ...captureTime('2003-04-05T06:07:08') },
        });
        await vfs.create(ADMIN_ACCESS, 'position', `/geo/${point.name}`, 'position');
        const handle = await vfs.open(ADMIN_ACCESS, `/geo/${point.name}/position`, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify({ lat: point.lat, lng: point.lng })));
        } finally {
          await handle.close();
        }
      }

      const bbox = await client.execJson<Results>('search --bbox=57.8,57.6,12.1,11.8');
      assertEquals(names(bbox), ['gbg.jpg']);

      // A southern/western coordinate starts with a dash, which @std/cli reads
      // as the next flag unless the value is joined to it. Deliberately the
      // *space* form: `search` joins it itself in `joinValueFlags`, and this is
      // what pins that. Everywhere else the `=` form is the caller's job.
      const southern = await client.execJson<Results>('search --circle -33.9249,18.4241,5000');
      assertEquals(names(southern), []);
      // ...and the `=` form, which every caller outside `search` must write.
      const southernJoined = await client.execJson<Results>('search --circle=-33.9249,18.4241,5000');
      assertEquals(names(southernJoined), []);
      assertEquals((southern as unknown as { filters: { region: string } }).filters.region, 'circle');

      // 5km around Gothenburg: includes it, excludes Stockholm.
      const circle = await client.execJson<Results>('search --circle=57.7089,11.9746,5000');
      assertEquals(names(circle), ['gbg.jpg']);

      // A bbox wide enough for both, but a circle that only reaches one, is
      // the case that proves the JS refinement actually runs.
      const wide = await client.execJson<Results>('search --bbox=60,57,19,11');
      assertEquals(names(wide), ['gbg.jpg', 'sthlm.jpg']);

      const poly = await client.execJson<Results>(
        'search --polygon "57.6,11.8;57.6,12.1;57.8,12.1;57.8,11.8"',
      );
      assertEquals(names(poly), ['gbg.jpg']);
    });

    await t.step('region combines with time and kind', async () => {
      const res = await client.execJson<Results>(
        'search --bbox=60,57,19,11 --kind photo --from 2003 --to 2003',
      );
      assertEquals(names(res), ['gbg.jpg', 'sthlm.jpg']);

      const none = await client.execJson<Results>(
        'search --bbox=60,57,19,11 --kind photo --from 1990 --to 1991',
      );
      assertEquals(none.results.length, 0);
    });

    await t.step('geo hits carry coordinates', async () => {
      const res = await client.execJson<Results & { results: { lat?: number; lng?: number }[] }>(
        'search --circle=57.7089,11.9746,5000',
      );
      assertEquals(res.results.length, 1);
      assertEquals(res.results[0].lat, 57.7089);
      assertEquals(res.results[0].lng, 11.9746);
    });

    await t.step('a person or an album with a region intersects two sets, and the hits keep their points', async () => {
      // Tagged in both geo pictures; only the region decides. The region is applied to the
      // person's list as membership, so no node is loaded to be rejected.
      await client.exec('mkdir -p /archive/people');
      await vfs.create(ADMIN_ACCESS, 'person', '/archive/people', 'geo-anna', { attrs: { name: 'Geo Anna' } });
      for (const name of ['gbg.jpg', 'sthlm.jpg']) {
        await vfs.ensure(ADMIN_ACCESS, 'directory', `/geo/${name}`, 'people', { props: { mode: 0o775 } });
        await vfs.create(ADMIN_ACCESS, 'softlink', `/geo/${name}/people`, 'geo-anna', {
          props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: '/archive/people/geo-anna' },
        });
      }
      const person = await client.execJson<Results & { results: { lat?: number; lng?: number }[] }>(
        'search --subject person:geo-anna --bbox=57.8,57.6,12.1,11.8',
      );
      assertEquals(names(person), ['gbg.jpg']);
      assertEquals(person.results[0].lat, 57.7089);
      assertEquals(names(await client.execJson<Results>('search --subject person:geo-anna --bbox=60,57,19,11')), ['gbg.jpg', 'sthlm.jpg']);
      assertEquals(names(await client.execJson<Results>('search --subject person:geo-anna --bbox=1,0,1,0')), []);

      // The same for a container driving.
      assertEquals(names(await client.execJson<Results>('search --under /geo --bbox=59.4,59.2,18.1,18.0')), ['sthlm.jpg']);
      // And for the counts, which walk the same driver.
      assertEquals((await client.execJson<{ total: number }>('search --subject person:geo-anna --bbox=57.8,57.6,12.1,11.8 --facets')).total, 1);
    });

    await t.step('a kind is a file kind or a node type: one nothing is finds nothing, a non-word is rejected', async () => {
      assertEquals((await client.execJson<{ results: unknown[] }>('search --kind sculpture')).results, []);
      await cmd.shouldFail("search --kind 'Sculpture!'");
    });

    await t.step('region flags are mutually exclusive', async () => {
      await cmd.shouldFail('search --bbox=1,0,1,0 --circle=0,0,100');
    });

    await t.step('a malformed region is rejected', async () => {
      await cmd.shouldFail('search --bbox nonsense');
      await cmd.shouldFail('search --polygon "1,2;3,4"');
    });

    await t.step('facets buckets by year and sums to total', async () => {
      const facets = await client.execJson<{
        total: number;
        range: { min: number; max: number } | null;
        years: { year: number; count: number }[];
        kinds: { kind: string; count: number }[];
      }>('facets');

      const summed = facets.years.reduce((sum, y) => sum + y.count, 0);
      assertEquals(summed, facets.total);
      assertEquals(facets.range?.min, 1977);
      assertEquals(facets.range?.max, 2010);

      const y1998 = facets.years.find((y) => y.year === 1998);
      // p1998 + v1998, and NOT the derived thumb sharing that timestamp.
      assertEquals(y1998?.count, 2);

      const photos = facets.kinds.find((k) => k.kind === 'photo');
      assert(photos && photos.count > 0, 'expected a photo bucket');
    });

    await t.step('facets honours a kind filter', async () => {
      const facets = await client.execJson<{ total: number; years: { year: number; count: number }[] }>(
        'facets --kind video',
      );
      assertEquals(facets.years.map((y) => y.year), [1998, 2010]);
      assertEquals(facets.total, 2);
    });

    await t.step('--facets counts a year-only date under its year, counted or walked', async () => {
      await client.exec('mkdir -p /partial && echo x > /partial/y1998.jpg && echo x > /partial/m1998.jpg && echo x > /partial/d1998.jpg');
      await vfs.update(ADMIN_ACCESS, '/partial/y1998.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('1998') } });
      await vfs.update(ADMIN_ACCESS, '/partial/m1998.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('1998-07') } });
      await vfs.update(ADMIN_ACCESS, '/partial/d1998.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('1998-07-04T09:00:00') } });

      type Facets = { total: number; days: { key: string; count: number }[]; months: { key: string; count: number }[]; years: { year: number; count: number }[] };
      // The store counts the first; `--under` is walked.
      for (const command of ['search --from 1998 --to 1998 --kind photo --facets', 'search --under /partial --facets']) {
        const facets = await client.execJson<Facets>(command);
        const own = command.includes('--under') ? 0 : 1; // p1998.jpg, outside /partial
        assertEquals(facets.days.find((d) => d.key === '1998-07-04')?.count, 1, command);
        assertEquals(facets.months.find((m) => m.key === '1998-07')?.count, 2, command);
        assertEquals(facets.months.find((m) => m.key === '1998')?.count, 1, command);
        assertEquals(facets.years, [{ year: 1998, count: 3 + own }], command);
        assertEquals(facets.total, 3 + own, command);
      }
    });

    await t.step('--facets counts the labels the answer carries, counted or walked', async () => {
      await client.exec('label add /media/p1995.jpg sea boat && label add /media/p1998.jpg sea');

      type Facets = { labels: { label: string; count: number }[] };
      // The store counts the first; `--under` and `--tag` are walked.
      for (const command of ['search --from 1990 --to 2000 --kind photo --facets', 'search --under /media --facets', 'search --tag sea --facets']) {
        const facets = await client.execJson<Facets>(command);
        assertEquals(facets.labels, [{ label: 'sea', count: 2 }, { label: 'boat', count: 1 }], command);
      }
      assertEquals((await client.execJson<Facets>('search --from 1997 --to 2000 --kind photo --facets')).labels, [{ label: 'sea', count: 1 }]);
    });

    // Last, because it adds a picture: the facet steps above count every one.
    await t.step('a location is in a region by its own position, an album by the pictures it holds', async () => {
      const place = async (path: string, point: { lat: number; lng: number }) => {
        await vfs.create(ADMIN_ACCESS, 'position', path, 'position');
        const handle = await vfs.open(ADMIN_ACCESS, `${path}/position`, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify(point)));
        } finally {
          await handle.close();
        }
      };
      await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT} ${ALBUMS_ROOT}`);
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'harbour', { attrs: { name: 'The Harbour' } });
      await place(`${LOCATIONS_ROOT}/harbour`, { lat: 57.7072, lng: 11.9668 });
      await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'palace', { attrs: { name: 'The Palace' } });
      await place(`${LOCATIONS_ROOT}/palace`, { lat: 59.3268, lng: 18.0717 });
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'walk', { attrs: { name: 'The Walk' } });
      await cmd.shouldSucceed(`echo w > ${ALBUMS_ROOT}/walk/w1.jpg`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/walk/w1.jpg`, { attrs: { mimetype: 'image/jpeg', ...captureTime('2003-04-05T07:00:00') } });
      await place(`${ALBUMS_ROOT}/walk/w1.jpg`, { lat: 57.7080, lng: 11.9700 });

      const gbg = '--circle=57.7089,11.9746,5000';
      const locations = await client.execJson<Results & { results: { lat?: number; lng?: number }[] }>(`search ${gbg} --kind location`);
      assertEquals(names(locations), ['harbour']);
      assertEquals([locations.results[0].lat, locations.results[0].lng], [57.7072, 11.9668]);
      assertEquals(names(await client.execJson<Results>(`search ${gbg} --kind album`)), ['walk']);
      assertEquals(names(await client.execJson<Results>(`search ${gbg} --kind album,location`)), ['harbour', 'walk']);
      // A text query ranks the entities and the region still narrows them.
      assertEquals(names(await client.execJson<Results>(`search harbour ${gbg} --kind location`)), ['harbour']);
      assertEquals(names(await client.execJson<Results>(`search palace ${gbg} --kind location`)), []);
      // A location has no capture time of its own, so a date leaves only what pictures answer.
      assertEquals(names(await client.execJson<Results>(`search ${gbg} --kind album,location --from 2003 --to 2003`)), ['walk']);
    });

    await t.step('an album matches a label it carries itself, or one a picture it holds carries', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'regatta', { attrs: { name: 'The Regatta' } });
      await client.exec(`label add ${ALBUMS_ROOT}/regatta sea && label add ${ALBUMS_ROOT}/walk sea && label add ${ALBUMS_ROOT}/walk/w1.jpg sea`);

      // `walk` both carries it and holds a picture that does: listed once.
      assertEquals(names(await client.execJson<Results>('search --tag sea --kind album')), ['regatta', 'walk']);
      // A date is met only through pictures, so the album's own label does not answer it.
      assertEquals(names(await client.execJson<Results>('search --tag sea --kind album --from 2003 --to 2003')), ['walk']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
