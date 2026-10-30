/**
 * The archive's views of the whole library leave a staging area out once `staging init` has
 * marked it unlisted: `latest`, `dayinhistory` and `onthisday-media`, the timeline and its
 * facets (a suggested group is an auto album there), the map's `find-within`, flat, by
 * cell and as facets, a text provider's hits, and the faces and voices `person-list` counts. Staging still lists what
 * it holds (`search --within`).
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { PersonListEntry } from '@archive/people/api';
import { REGION_TYPE } from '@archive/media/regions';
import type { DatedMedia, DayInHistory } from '@archive/media/api';
import type { OnThisDayEntry, Provided } from '@ein/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

const STAGING = '/home/anna/staging';
const BATCH = `${STAGING}/files/inbox/upload-2026-10-18`;
const BOX = '--north=58 --south=57 --east=12.5 --west=11.5';

type Hits = { results: { paths: string[] }[]; total: number };
type Clusters = { clusters: { count: number }[]; total: number };
type Facets = { total: number; days: { key: string; count: number }[] };
type Page = { entries: { kind: string; path: string }[] };

Deno.test({ name: 'library views leave staging out', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  // The organizer would group the staged file on its own; the group here is a hand-made one.
  await cmd.shouldSucceed('service stop staging-organizer');

  /** A dated picture at `parent/name`, with its GPS position. */
  const mkmedia = async (parent: string, name: string, takenAt: string, point: { lat: number; lng: number }) => {
    await vfs.create(ADMIN_ACCESS, 'file', parent, name, { props: { mode: 0o644 }, attrs: { name, mimetype: 'image/jpeg', ...captureTime(takenAt) } });
    await vfs.create(ADMIN_ACCESS, 'position', `${parent}/${name}`, 'position');
    const handle = await vfs.open(ADMIN_ACCESS, `${parent}/${name}/position`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(point)));
    } finally {
      await handle.close();
    }
  };

  try {
    await cmd.shouldSucceed('user-create anna --uid 3600');
    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed(`mkdir -p ${BATCH}`);
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'harbour-day', {
      props: { mode: 0o755 },
      attrs: { name: 'Harbour day', timeStart: '2019-09-02T08:00:00', timeEnd: '2019-09-02T18:00:00', mediaCount: 1 },
    });
    await mkmedia(`${ALBUMS_ROOT}/harbour-day`, 'harbour.jpg', '2019-09-02T08:00:00', { lat: 57.7, lng: 11.95 });
    await mkmedia(BATCH, 'boat.jpg', '2021-09-02T09:00:00', { lat: 57.71, lng: 11.96 });
    await vfs.create(ADMIN_ACCESS, 'album', `${STAGING}/albums/inbox`, '2021-09-02', {
      props: { mode: 0o700 },
      attrs: { name: '2 September 2021', origin: 'auto', timeStart: '2021-09-02T09:00:00', timeEnd: '2021-09-02T09:00:00', mediaCount: 1 },
    });

    await t.step('latest is the library only', async () => {
      assertEquals((await client.execJson<DatedMedia[]>('latest')).map((item) => item.path), [`${ALBUMS_ROOT}/harbour-day/harbour.jpg`]);
    });

    await t.step('on this day is the library only, and its years too', async () => {
      const day = await client.execJson<DayInHistory>('dayinhistory 09-02');
      assertEquals(day.years.map((year) => [year.year, year.items.map((item) => item.path)]), [[2019, [`${ALBUMS_ROOT}/harbour-day/harbour.jpg`]]]);
      assertEquals((await client.execJson<Provided<OnThisDayEntry>[]>('onthisday-media 09-02')).map((entry) => entry.year), [2019]);
    });

    await t.step('the timeline and its facets hold no suggested group', async () => {
      const page = await client.execJson<Page>('timeline --kind album,auto-album');
      assertEquals(page.entries.map((entry) => entry.path), [`${ALBUMS_ROOT}/harbour-day`]);
      const facets = await client.execJson<Facets>('timeline-facets --kind album,auto-album');
      assertEquals([facets.total, facets.days.map((day) => day.key)], [1, ['2019-09-02']]);
    });

    await t.step('the map is the library only, flat, by cell and counted', async () => {
      const flat = await client.execJson<Hits>(`find-within ${BOX}`);
      assertEquals([flat.total, flat.results.flatMap((hit) => hit.paths)], [1, [`${ALBUMS_ROOT}/harbour-day/harbour.jpg/position`]]);
      const cells = await client.execJson<Clusters>(`find-within ${BOX} --cell=10`);
      assertEquals([cells.total, cells.clusters.map((cell) => cell.count)], [1, [1]]);
      assertEquals((await client.execJson<Facets>(`find-within ${BOX} --facets`)).total, 1);
    });

    await t.step('a text provider told the unlisted trees spends no hits on them', async () => {
      type Provided = { results: { path: string; channel: string }[] };
      const names = async (args: string) =>
        (await client.execJson<Provided>(`search-media boat -l 5${args}`)).results.filter((hit) => hit.channel === 'name').map((hit) => hit.path);
      assertEquals(await names(''), [`${BATCH}/boat.jpg`]);
      assertEquals(await names(` --not-within ${STAGING}`), []);
      assertEquals((await client.execJson<{ results: unknown[] }>('search boat')).results, []);
    });

    await t.step('person-list counts the files of the library only', async () => {
      const person = await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, 'anna-andersson', { props: { mode: 0o755 }, attrs: { name: 'Anna Andersson' } });
      const holder = async (path: string, type: string, name: string, attrs: Record<string, unknown>) => {
        const file = await vfs.get(ADMIN_ACCESS, path);
        await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'regions');
        await vfs.create(ADMIN_ACCESS, type, `${path}/regions`, name, { attrs: { personId: person.id, fileId: file.id, ...attrs } });
      };
      await holder(`${ALBUMS_ROOT}/harbour-day/harbour.jpg`, REGION_TYPE, 'face-0', {});
      await holder(`${BATCH}/boat.jpg`, REGION_TYPE, 'face-0', {});
      await holder(`${BATCH}/boat.jpg`, 'embedding', 's0', { embeddingType: 'voice', capacity: 2 });
      await vfs.create(ADMIN_ACCESS, REGION_TYPE, `${ALBUMS_ROOT}/harbour-day/harbour.jpg/regions`, 'manual-0', { attrs: { personId: person.id } });

      const listed = await client.execJson<PersonListEntry[]>('person-list');
      assertEquals(listed.map((entry) => [entry.id, entry.pictures]), [['anna-andersson', 1]]);
    });

    await t.step('staging still lists what it holds', async () => {
      const staged = await client.execJson<{ results: { path: string }[] }>(`search --within ${STAGING}/files`);
      assertEquals(staged.results.map((hit) => hit.path), [`${BATCH}/boat.jpg`]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
