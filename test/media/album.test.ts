/**
 * Album command tests: create, info (of one album and of several), list (its paging, and what it
 * says of a suggested album), set (its series links too) and add, and the layout of a suggested album's members.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, testCommands } from '@ein/testing';
import type { SearchLayoutResponse } from '@ein/api';
import type { AlbumAddResult, AlbumInfoAnswer, AlbumListResult } from '@archive/media/api';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'album command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT} && mkdir -p /media-src`);
    await client.exec('echo one > /media-src/a.txt && echo two > /media-src/b.txt');

    await t.step('create static album with attrs + cover softlink', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/summer --description "Summer 2020" --cover /media-src/a.txt`);

      const { albums: [info] } = await client.execJson<AlbumInfoAnswer>(`album info ${ALBUMS_ROOT}/summer`);
      assertEquals(info.description, 'Summer 2020');
      assertEquals(info.coverPhoto, '/media-src/a.txt');

      // cover is a coverPhoto softlink child, not an attr
      const cover = await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/summer/coverPhoto`);
      assertEquals(cover.softlink, '/media-src/a.txt');
      const attrs = await client.execJson<{ coverPhoto?: string }>(`attrs ${ALBUMS_ROOT}/summer`);
      assertEquals(attrs.coverPhoto ?? null, null);

      const node = await client.execJson<{ type: string }>(`info ${ALBUMS_ROOT}/summer`);
      assertEquals(node.type, 'album');
    });

    await t.step('album set cover replaces the cover softlink', async () => {
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/summer cover /media-src/b.txt`);
      const { albums: [info] } = await client.execJson<AlbumInfoAnswer>(`album info ${ALBUMS_ROOT}/summer`);
      assertEquals(info.coverPhoto, '/media-src/b.txt');
    });

    await t.step('album holds real children like a directory', async () => {
      await cmd.shouldSucceed(`echo photo > ${ALBUMS_ROOT}/summer/beach.txt`);
      const out = await client.execString(`ls ${ALBUMS_ROOT}/summer`);
      assertEquals(out.includes('beach.txt'), true, out);
    });

    await t.step('list returns compact album-card pages', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/imported --name "Imported Album" --description "Scanned photographs"`);
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/imported/files`);
      await cmd.shouldSucceed(`attrs ${ALBUMS_ROOT}/imported -s timeStart=1998-05-02T18:00:00Z -s timeEnd=1998-05-02T23:00:00Z`);

      type Entry = {
        name: string;
        title: string;
        path: string;
        hasFilesDir: boolean;
        itemCount: number;
        description?: string;
        timeStart?: string;
        timeEnd?: string;
        modtime?: number;
      };
      type Page = { items: Entry[]; nextCursor: string | null };

      const first = await client.execJson<Page>(`album list ${ALBUMS_ROOT} --limit 1`);
      assertEquals(first.items.length, 1);
      assertEquals(first.nextCursor, 'imported');
      assertEquals(first.items[0], {
        name: 'imported',
        title: 'Imported Album',
        path: `${ALBUMS_ROOT}/imported`,
        hasFilesDir: true,
        itemCount: 0,
        modtime: first.items[0].modtime,
        description: 'Scanned photographs',
        timeStart: '1998-05-02T18:00:00Z',
        timeEnd: '1998-05-02T23:00:00Z',
      });
      assert(typeof first.items[0].modtime === 'number');

      const second = await client.execJson<Page>(`album list ${ALBUMS_ROOT} --limit 1 --cursor=${first.nextCursor}`);
      assertEquals(second.items.map((entry) => entry.name), ['summer']);
      assertEquals(second.nextCursor, null);
    });

    await t.step('list carries what the grid shows for a suggested album', async () => {
      // The albums grid shows auto albums beside hand-made ones, so the summary
      // the card needs travels with the listing rather than costing a read per
      // card. The full per-signal `scores` stay off it — only the overall does.
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/cluster --name "A day out"`);
      await cmd.shouldSucceed(`attrs ${ALBUMS_ROOT}/cluster -s origin=auto`);
      await cmd.shouldSucceed(
        `attrs ${ALBUMS_ROOT}/cluster -J autoAlbum='{"timeStart":"2021-07-04T09:00:00Z","timeEnd":"2021-07-04T18:00:00Z",` +
          `"locationPath":"${LOCATIONS_ROOT}/seaside-village","memberCount":42,"provisional":true,"pinned":false,` +
          `"scores":{"overall":0.83,"temporal":0.9},"memberKey":"00000000000000aa","kind":"trip"}'`,
      );

      type AutoEntry = {
        name: string;
        origin?: string;
        timeStart?: string;
        timeEnd?: string;
        locationPath?: string;
        memberCount?: number;
        provisional?: boolean;
        pinned?: boolean;
        overall?: number;
        kind?: string;
        scores?: unknown;
        staging?: unknown;
      };
      const page = await client.execJson<{ items: AutoEntry[] }>(`album list ${ALBUMS_ROOT}`);
      const entry = page.items.find((item) => item.name === 'cluster');
      assert(entry, 'the suggested album is listed alongside the rest');
      assertEquals(entry.origin, 'auto');
      assertEquals(entry.timeStart, '2021-07-04T09:00:00Z');
      assertEquals(entry.timeEnd, '2021-07-04T18:00:00Z');
      assertEquals(entry.locationPath, `${LOCATIONS_ROOT}/seaside-village`);
      assertEquals(entry.memberCount, 42);
      assertEquals(entry.provisional, true);
      assertEquals(entry.pinned, false);
      assertEquals(entry.overall, 0.83);
      // The per-signal breakdown is a per-album read, not part of the page.
      assertEquals(entry.scores ?? null, null);
      assertEquals(entry.kind, 'trip');
      // What staging decides it by: the key its members were written with, and its kind.
      assertEquals(entry.staging, { memberKey: '00000000000000aa', kind: 'trip' });
    });

    await t.step('only a suggested album carries staging info, and a kind the grid does not know stays in it', async () => {
      await cmd.shouldSucceed('mkdir -p /suggested');
      await cmd.shouldSucceed('album create /suggested/lake-weekend --name "Lake weekend"');
      await cmd.shouldSucceed('attrs /suggested/lake-weekend -s origin=auto');
      await cmd.shouldSucceed(`attrs /suggested/lake-weekend -J autoAlbum='{"memberKey":"00000000000000bb","memberCount":12,"kind":"clutter"}'`);
      // Hand-made, though it has the same summary: not a suggestion.
      await cmd.shouldSucceed('album create /suggested/picnic --name "Picnic"');
      await cmd.shouldSucceed(`attrs /suggested/picnic -J autoAlbum='{"memberKey":"00000000000000cc","memberCount":3}'`);

      const page = await client.execJson<AlbumListResult>('album list /suggested');
      const byName = new Map(page.items.map((item) => [item.name, item]));
      assertEquals(byName.get('lake-weekend')?.staging, { memberKey: '00000000000000bb', kind: 'clutter' });
      assertEquals(byName.get('lake-weekend')?.kind, undefined);
      assertEquals(byName.get('lake-weekend')?.memberCount, 12);
      assertEquals(byName.get('picnic')?.staging, undefined);
    });

    await t.step('a suggested album whose name a person gave says so', async () => {
      await cmd.shouldSucceed('album create /suggested/sunday --name "Sunday picnic" && attrs /suggested/sunday -s origin=auto');
      await cmd.shouldSucceed(`attrs /suggested/sunday -J autoAlbum='{"memberKey":"00000000000000dd","memberCount":4,"generatedName":"15 Jun 2019"}'`);
      await cmd.shouldSucceed('album create /suggested/monday --name "16 Jun 2019" && attrs /suggested/monday -s origin=auto');
      await cmd.shouldSucceed(`attrs /suggested/monday -J autoAlbum='{"memberKey":"00000000000000ee","memberCount":4,"generatedName":"16 Jun 2019"}'`);
      const page = await client.execJson<AlbumListResult>('album list /suggested');
      const byName = new Map(page.items.map((item) => [item.name, item]));
      assertEquals(byName.get('sunday')?.staging, { memberKey: '00000000000000dd', named: true });
      assertEquals(byName.get('monday')?.staging, { memberKey: '00000000000000ee' });
      await cmd.shouldSucceed('rm -r /suggested/sunday /suggested/monday');
    });

    await t.step('info reads several albums at once, in the order asked, and names the ones not there', async () => {
      const answer = await client.execJson<AlbumInfoAnswer>(
        `album info /suggested/picnic ${ALBUMS_ROOT}/nowhere /suggested/lake-weekend ${ALBUMS_ROOT}/imported`,
      );
      assertEquals(answer.albums.map((album) => album.path), ['/suggested/picnic', '/suggested/lake-weekend', `${ALBUMS_ROOT}/imported`]);
      assertEquals(answer.missing, [`${ALBUMS_ROOT}/nowhere`]);
      const [picnic, lake, imported] = answer.albums;
      assertEquals(picnic.title, 'Picnic');
      assertEquals(lake.staging, { memberKey: '00000000000000bb', kind: 'clutter' });
      assertEquals(imported.hasFilesDir, true);
      assertEquals(imported.timeStart, '1998-05-02T18:00:00Z');
      assert(lake.id && lake.id !== picnic.id);
      assertEquals(lake.coverPhoto, null);
      // The text form is per album, as for one.
      const text = await client.execString('album info /suggested/picnic /suggested/lake-weekend', { json: false });
      assert(text.includes('path:        /suggested/picnic') && text.includes('name:        Lake weekend'), text);
    });

    await t.step('info refuses more than 50 albums, and what is not an album', async () => {
      const many = Array.from({ length: 51 }, (_, n) => `/suggested/a${n}`).join(' ');
      await cmd.shouldFail(`album info ${many}`);
      await cmd.shouldFail('album info /media-src/a.txt');
    });

    await t.step('list pages in store order, past dot names and files, and an album gone between pages', async () => {
      await cmd.shouldSucceed('mkdir -p /paged/.organizer /paged/b-dir/files');
      for (const name of ['a', 'c', 'd']) await cmd.shouldSucceed(`album create /paged/${name}`);
      await cmd.shouldSucceed('echo note > /paged/notes.txt');

      const first = await client.execJson<AlbumListResult>('album list /paged --limit 2');
      assertEquals(first.items.map((item) => item.name), ['a', 'b-dir']);
      assertEquals(first.items.map((item) => item.hasFilesDir), [false, true]);
      assertEquals(first.nextCursor, 'b-dir');

      // Removed before the next page is read: the page goes on from the name, not from a position.
      await cmd.shouldSucceed('rm -r /paged/c');
      const second = await client.execJson<AlbumListResult>(`album list /paged --limit 2 --cursor=${first.nextCursor}`);
      assertEquals(second.items.map((item) => item.name), ['d']);
      assertEquals(second.nextCursor, null);
    });

    await t.step("list counts each album's members: its own and its files/, links too, not its cover or series links", async () => {
      await cmd.shouldSucceed('mkdir -p /counted/flat /counted/imported/files /counted/empty');
      await cmd.shouldSucceed('attrs /counted/flat -s name=Flat');
      await cmd.shouldSucceed('echo one > /counted/flat/a.jpg && echo two > /counted/flat/b.jpg && ln -s /media-src/a.txt /counted/flat/linked');
      await cmd.shouldSucceed('ln -s /counted/flat/a.jpg /counted/flat/coverPhoto && ln -s /counted/imported /counted/flat/next');
      await cmd.shouldSucceed('echo three > /counted/imported/files/c.jpg && ln -s /counted/flat/a.jpg /counted/imported/coverPhoto');

      const page = await client.execJson<AlbumListResult>('album list /counted');
      assertEquals(page.items.map((item) => [item.name, item.itemCount]), [['empty', 0], ['flat', 3], ['imported', 1]]);
      const { albums } = await client.execJson<AlbumInfoAnswer>('album info /counted/flat /counted/imported');
      assertEquals(albums.map((album) => album.itemCount), [3, 1]);
    });

    await t.step('set updates attrs', async () => {
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/summer description "Summer of 2020"`);
      const { albums: [info] } = await client.execJson<AlbumInfoAnswer>(`album info ${ALBUMS_ROOT}/summer`);
      assertEquals(info.description, 'Summer of 2020');
    });

    await t.step('an empty value clears an attr rather than storing an empty string', async () => {
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/summer description ''`);
      const attrs = await client.execJson<{ description?: string }>(`attrs ${ALBUMS_ROOT}/summer`);
      assertEquals(attrs.description ?? null, null);
    });

    await t.step('add links files into the album, once each', async () => {
      await client.exec('mkdir -p /picks && echo one > /picks/one.txt && echo two > /picks/two.txt');
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/picked --name "Picked"`);
      const first = await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/picked /picks/one.txt /picks/two.txt`);
      assertEquals(first.added.map((entry) => entry.path), ['/picks/one.txt', '/picks/two.txt']);
      assertEquals(first.added[0].link, `${ALBUMS_ROOT}/picked/one.txt`);
      const link = await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/picked/one.txt`);
      assertEquals(link.softlink, '/picks/one.txt');

      const again = await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/picked /picks/one.txt`);
      assertEquals(again.added, []);
      assertEquals(again.already, ['/picks/one.txt']);
    });

    await t.step('add into an imported album links inside its files/', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/scanned --name "Scanned"`);
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/scanned/files && echo held > ${ALBUMS_ROOT}/scanned/files/held.txt`);
      const result = await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/scanned /picks/one.txt`);
      assertEquals(result.added[0].link, `${ALBUMS_ROOT}/scanned/files/one.txt`);
    });

    await t.step('set next links the album to the next in a series, and that one back', async () => {
      for (const year of ['2011', '2012', '2013']) await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/sail-${year} --name "Sailing ${year}"`);
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/sail-2011 next ${ALBUMS_ROOT}/sail-2012`);
      const { albums: [first, second] } = await client.execJson<AlbumInfoAnswer>(`album info ${ALBUMS_ROOT}/sail-2011 ${ALBUMS_ROOT}/sail-2012`);
      assertEquals([first.previous, first.next], [null, `${ALBUMS_ROOT}/sail-2012`]);
      assertEquals([second.previous, second.next], [`${ALBUMS_ROOT}/sail-2011`, null]);
      const link = await client.execJson<{ softlink: string }>(`props -L ${ALBUMS_ROOT}/sail-2011/next`);
      assertEquals(link.softlink, `${ALBUMS_ROOT}/sail-2012`);
    });

    await t.step('a neighbour replaced in a series stops linking back, and so does the one the new neighbour linked to', async () => {
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/sail-2013 previous ${ALBUMS_ROOT}/sail-2012`);
      const { albums: [first, second, third] } = await client.execJson<AlbumInfoAnswer>(
        `album info ${ALBUMS_ROOT}/sail-2011 ${ALBUMS_ROOT}/sail-2012 ${ALBUMS_ROOT}/sail-2013`,
      );
      assertEquals([first.previous, first.next], [null, `${ALBUMS_ROOT}/sail-2012`]);
      assertEquals([second.previous, second.next], [`${ALBUMS_ROOT}/sail-2011`, `${ALBUMS_ROOT}/sail-2013`]);
      assertEquals([third.previous, third.next], [`${ALBUMS_ROOT}/sail-2012`, null]);

      // 2011 now goes straight on to 2013: 2012 loses its link back to 2011, and 2013 its link to 2012.
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/sail-2011 next ${ALBUMS_ROOT}/sail-2013`);
      const after = await client.execJson<AlbumInfoAnswer>(`album info ${ALBUMS_ROOT}/sail-2011 ${ALBUMS_ROOT}/sail-2012 ${ALBUMS_ROOT}/sail-2013`);
      assertEquals(after.albums.map((album) => [album.previous, album.next]), [
        [null, `${ALBUMS_ROOT}/sail-2013`],
        [null, null],
        [`${ALBUMS_ROOT}/sail-2011`, null],
      ]);
    });

    await t.step('an empty neighbour unlinks both ends', async () => {
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/sail-2013 previous ''`);
      const { albums } = await client.execJson<AlbumInfoAnswer>(`album info ${ALBUMS_ROOT}/sail-2011 ${ALBUMS_ROOT}/sail-2013`);
      assertEquals(albums.map((album) => [album.previous, album.next]), [[null, null], [null, null]]);
    });

    await t.step('a series takes library albums only, and not the album itself', async () => {
      await cmd.shouldFailWith(`album set ${ALBUMS_ROOT}/sail-2011 next ${ALBUMS_ROOT}/sail-2011`, 'cannot follow itself');
      await cmd.shouldFailWith(`album set ${ALBUMS_ROOT}/sail-2011 next /picks`, 'not an album');
      await cmd.shouldFailWith(`album set ${ALBUMS_ROOT}/sail-2011 next ${ALBUMS_ROOT}/cluster`, 'suggested album');
      await cmd.shouldFail(`album set ${ALBUMS_ROOT}/sail-2011 next ${ALBUMS_ROOT}/nowhere`);
    });

    await t.step('links to the neighbours in a series are not members, and leave an imported album adding into files/', async () => {
      await cmd.shouldSucceed(`album set ${ALBUMS_ROOT}/scanned previous ${ALBUMS_ROOT}/sail-2011`);
      const result = await client.execJson<AlbumAddResult>(`album add ${ALBUMS_ROOT}/scanned /picks/two.txt`);
      assertEquals(result.added[0].link, `${ALBUMS_ROOT}/scanned/files/two.txt`);
    });

    await t.step('add refuses a missing file and adds nothing', async () => {
      await cmd.shouldFail(`album add ${ALBUMS_ROOT}/picked /picks/two.txt /picks/nope.txt`);
      await cmd.shouldFail(`album add ${ALBUMS_ROOT}/picked`);
    });

    await t.step("a suggested album's layout says which of the files it links have renditions", async () => {
      await client.exec('mkdir -p /lake-files && echo a > /lake-files/early.jpg && echo b > /lake-files/late.jpg');
      await vfs.update(ADMIN_ACCESS, '/lake-files/early.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('2019-06-14T09:00:00') } });
      await vfs.update(ADMIN_ACCESS, '/lake-files/late.jpg', { attrs: { mimetype: 'image/jpeg', ...captureTime('2019-06-15T18:00:00') } });
      await cmd.shouldSucceed('mkdir -p /lake-files/late.jpg/thumbnails');
      await cmd.shouldSucceed('album create /suggested/lake-trip --name "Lake trip"');
      await cmd.shouldSucceed('attrs /suggested/lake-trip -s origin=auto');
      await cmd.shouldSucceed('album add /suggested/lake-trip /lake-files/early.jpg /lake-files/late.jpg');

      const answer = await client.execJson<SearchLayoutResponse>('search --under /suggested/lake-trip --sort time --layout --fields derivatives');
      assertEquals(answer.truncated, false);
      assertEquals(answer.layout.items.map((row, index) => [row[1], answer.layout.derivatives?.[index]]), [['early.jpg', 0], ['late.jpg', 1]]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
