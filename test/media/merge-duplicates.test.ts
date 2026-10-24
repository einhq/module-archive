/**
 * merge-duplicates: the kept file is filled in from the drops, never overwritten — fields, named
 * boxes, people tags, comments, a paired sidecar and the drops' library albums; the drops go to the trash as one
 * batch, leaving their suggested albums with the staged kept file in their place;
 * `trash restore <batch>` undoes it; and what cannot be done is refused before anything changes.
 */

import { ALBUMS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import type { CommentEntry, StarEntry, TrashEntry, TrashRestoreResult } from '@ein/api';
import type { AlbumAddResult, MergeDuplicatesResult } from '@archive/media/api';
import type { RegionAttrs } from '@archive/media/regions';
import { AUTO_ORIGIN, type AutoAlbumMeta, isUserEdited, memberKeyOf } from '@archive/staging/auto-album';
import { suggestionsOf } from '@archive/staging/membership';

const testCtx = createTestContext({ modules: ['archive'] });

const LAKE = `${ALBUMS_ROOT}/lake/files`;
const STAGED = '/home/admin/staging/files/inbox';

type Attrs = {
  description?: string;
  whenManual?: string;
  takenAtNote?: string;
  positionManual?: { lat: number; lng: number };
  labels?: string[];
};

Deno.test({ name: 'merge-duplicates', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const attrs = (path: string) => client.execJson<Attrs>(`attrs ${path}`);
  const file = (path: string) => cmd.shouldSucceed(`mknode -t file ${path} --as mimetype=image/jpeg`);

  try {
    await client.exec(`mkdir -p ${LAKE} ${STAGED}`);

    let batch = '';
    await t.step('the drops fill in what the kept file lacks, the first drop winning', async () => {
      for (const name of ['keep.jpg', 'copy-1.jpg', 'copy-2.jpg']) await file(`${LAKE}/${name}`);
      await cmd.shouldSucceed(`label add ${LAKE}/keep.jpg boat`);
      await cmd.shouldSucceed(`file-set-description ${LAKE}/copy-1.jpg --text 'A sailboat at dawn'`);
      await cmd.shouldSucceed(`file-set-time ${LAKE}/copy-1.jpg 2019-06 --note 'from the album sleeve'`);
      await cmd.shouldSucceed(`file-set-position ${LAKE}/copy-1.jpg --lat=57.5 --lng=11.9`);
      await cmd.shouldSucceed(`label add ${LAKE}/copy-1.jpg boat lake`);
      await cmd.shouldSucceed(`star ${LAKE}/copy-1.jpg`);
      await cmd.shouldSucceed(`file-set-description ${LAKE}/copy-2.jpg --text 'Another text'`);
      await cmd.shouldSucceed(`label add ${LAKE}/copy-2.jpg dawn`);

      const result = await client.execJson<MergeDuplicatesResult>(
        `merge-duplicates ${LAKE}/keep.jpg ${LAKE}/copy-1.jpg ${LAKE}/copy-2.jpg --label 'Copies of a sailboat'`,
      );
      assertEquals(result.merged, ['description', 'time', 'place', 'labels', 'star']);
      assertEquals(result.trashed, 2);
      assert(result.batch);
      batch = result.batch;

      const kept = await attrs(`${LAKE}/keep.jpg`);
      assertEquals(kept.description, 'A sailboat at dawn');
      assertEquals([kept.whenManual, kept.takenAtNote], ['2019-06', 'from the album sleeve']);
      assertEquals(kept.positionManual, { lat: 57.5, lng: 11.9 });
      assertEquals(kept.labels, ['boat', 'lake', 'dawn']);
      const stars = await client.execJson<StarEntry[]>('star list');
      assertEquals(stars.map((star) => star.target), [`${LAKE}/keep.jpg`]);

      assertEquals(await vfs.exists(ADMIN_ACCESS, `${LAKE}/copy-1.jpg`), false);
      const [row] = await client.execJson<TrashEntry[]>('trash list');
      assertEquals([row.id, row.type, row.count, row.label], [batch, 'batch', 2, 'Copies of a sailboat']);
    });

    await t.step('trash restore of the batch undoes the drop', async () => {
      const back = await client.execJson<TrashRestoreResult>(`trash restore ${batch}`);
      assertEquals(back.restored.map((entry) => entry.path).sort(), [`${LAKE}/copy-1.jpg`, `${LAKE}/copy-2.jpg`]);
      assertEquals(back.remaining, 0);
      assertEquals(await client.execJson<TrashEntry[]>('trash list'), []);
    });

    await t.step('the kept file keeps its own values', async () => {
      await file(`${LAKE}/own.jpg`);
      await cmd.shouldSucceed(`file-set-description ${LAKE}/own.jpg --text 'Mine'`);
      await cmd.shouldSucceed(`file-set-time ${LAKE}/own.jpg 2001`);
      await cmd.shouldSucceed(`file-set-position ${LAKE}/own.jpg --lat=60 --lng=15`);
      await cmd.shouldSucceed(`star ${LAKE}/own.jpg`);

      const result = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${LAKE}/own.jpg ${LAKE}/copy-2.jpg`);
      assertEquals(result.merged, ['labels']);
      const own = await attrs(`${LAKE}/own.jpg`);
      assertEquals([own.description, own.whenManual, own.positionManual], ['Mine', '2001', { lat: 60, lng: 15 }]);
      assertEquals(own.labels, ['dawn']);
    });

    await t.step('a dry run says what it would do and changes nothing', async () => {
      await file(`${LAKE}/plain.jpg`);
      const result = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${LAKE}/plain.jpg ${LAKE}/copy-1.jpg --dry-run`);
      assertEquals([result.dryRun, result.trashed, result.batch], [true, 1, null]);
      assertEquals(result.merged, ['description', 'time', 'place', 'labels']);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${LAKE}/copy-1.jpg`), true);
      assertEquals((await attrs(`${LAKE}/plain.jpg`)).description, undefined);
    });

    await t.step('refused: the kept file among the drops, a path in the trash, a directory', async () => {
      await cmd.shouldFail(`merge-duplicates ${LAKE}/plain.jpg ${LAKE}/plain.jpg`);
      const [entry] = (await client.execJson<{ entries: TrashEntry[] }>(`trash put ${LAKE}/copy-1.jpg`)).entries;
      await cmd.shouldFail(`merge-duplicates ${LAKE}/plain.jpg ${entry.path}`);
      await cmd.shouldFail(`merge-duplicates ${LAKE}/plain.jpg ${STAGED}`);
      await cmd.shouldFail(`merge-duplicates ${LAKE}/plain.jpg`);
      await client.execJson<TrashRestoreResult>(`trash restore ${entry.id}`);
      assertEquals((await attrs(`${LAKE}/plain.jpg`)).description, undefined);
    });

    await t.step('a kept file the caller cannot write is refused when it would be filled in', async () => {
      await cmd.shouldSucceed('user-create viewer --uid 3100');
      await cmd.shouldSucceed('user-passwd viewer --new-password secret1');
      await file(`${LAKE}/shared.jpg`);
      await vfs.update(ADMIN_ACCESS, `${LAKE}/shared.jpg`, { props: { mode: 0o644 } });
      const viewer = await testCtx.server.createShellClient({ username: 'viewer', password: 'secret1' });
      try {
        await viewer.exec('mkfile /home/viewer/mine.jpg');
        const asViewer = testCommands(viewer);
        await asViewer.shouldSucceed("file-set-description /home/viewer/mine.jpg --text 'A lake'");
        await asViewer.shouldFailWith(`merge-duplicates ${LAKE}/shared.jpg /home/viewer/mine.jpg`, 'cannot write');
        assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/viewer/mine.jpg'), true);
        assertEquals((await attrs(`${LAKE}/shared.jpg`)).description, undefined);
      } finally {
        viewer.close();
      }
    });

    await t.step('named boxes, people tags and comments move onto the kept file, each person once', async () => {
      for (const name of ['faces.jpg', 'faces-copy.jpg']) await file(`${LAKE}/${name}`);
      for (const slug of ['anna', 'bertil', 'cecilia', 'david']) await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/${slug} --name ${slug}`);
      const person = async (slug: string) => (await vfs.get(ADMIN_ACCESS, `${PEOPLE_ROOT}/${slug}`)).id;
      const region = (image: string, name: string, attrs: Record<string, unknown>) =>
        vfs.create(ADMIN_ACCESS, 'media-region', `${LAKE}/${image}/regions`, name, { attrs: { fileId: 'x', confidence: 0.9, ...attrs } });
      for (const image of ['faces.jpg', 'faces-copy.jpg']) await vfs.ensure(ADMIN_ACCESS, 'directory', `${LAKE}/${image}`, 'regions');

      // The kept file: a detected face nobody named, and Anna already named.
      await region('faces.jpg', 'face-0', { faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, personId: null });
      await region('faces.jpg', 'face-1', { faceBox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }, personId: await person('anna'), personSource: 'manual' });
      // The drop: Bertil on the unnamed face, Cecilia on a box the kept file lacks, Anna again,
      // and a machine's guess that is not carried over.
      const box = (x: number) => ({ x, y: 0.1, width: 0.2, height: 0.2 });
      await region('faces-copy.jpg', 'face-0', { faceBox: { x: 0.11, y: 0.1, width: 0.2, height: 0.2 }, personId: await person('bertil'), personSource: 'manual' });
      await region('faces-copy.jpg', 'manual-0', { faceBox: box(0.4), personId: await person('cecilia'), detectedBy: 'manual', personSource: 'manual' });
      await region('faces-copy.jpg', 'face-1', { faceBox: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }, personId: await person('anna'), personSource: 'manual' });
      await region('faces-copy.jpg', 'face-2', { faceBox: box(0.7), personId: await person('david'), personSource: 'auto' });
      await vfs.ensure(ADMIN_ACCESS, 'directory', `${LAKE}/faces-copy.jpg`, 'people');
      for (const slug of ['cecilia', 'david']) {
        await vfs.create(ADMIN_ACCESS, 'softlink', `${LAKE}/faces-copy.jpg/people`, slug, { props: { mode: 0o777, softlink: `${PEOPLE_ROOT}/${slug}` } });
      }
      await cmd.shouldSucceed(`comment add ${LAKE}/faces-copy.jpg --body 'Taken from the jetty'`);

      const dry = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${LAKE}/faces.jpg ${LAKE}/faces-copy.jpg --dry-run`);
      assertEquals(dry.merged, ['faces', 'people', 'comments']);

      const result = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${LAKE}/faces.jpg ${LAKE}/faces-copy.jpg`);
      assertEquals(result.merged, ['faces', 'people', 'comments']);

      const regions = await vfs.children<RegionAttrs>(ADMIN_ACCESS, `${LAKE}/faces.jpg/regions`);
      const byName = Object.fromEntries(regions.map((entry) => [entry.name, entry.node.attrs]));
      assertEquals(Object.keys(byName).sort(), ['face-0', 'face-1', 'manual-0']);
      assertEquals([byName['face-0'].personId, byName['face-0'].personSource], [await person('bertil'), 'manual']);
      assertEquals(byName['manual-0'].personId, await person('cecilia'));
      assertEquals(byName['manual-0'].faceBox, box(0.4));
      assertEquals(byName['manual-0'].fileId, (await vfs.get(ADMIN_ACCESS, `${LAKE}/faces.jpg`)).id);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${LAKE}/faces.jpg/regions/manual-0/image.avif`), true);

      // Cecilia is in a box now; David's tag is the one that joins.
      const tags = await vfs.children(ADMIN_ACCESS, `${LAKE}/faces.jpg/people`, { follow: false });
      assertEquals(tags.map((entry) => entry.node.props.softlink), [`${PEOPLE_ROOT}/david`]);

      const comments = await client.execJson<CommentEntry[]>(`comment list ${LAKE}/faces.jpg`);
      assertEquals(comments.map((entry) => [entry.body, entry.author]), [['Taken from the jetty', 'admin']]);
    });

    await t.step('the kept file joins the library albums a drop was in, and their covers', async () => {
      const other = `${ALBUMS_ROOT}/other`;
      const linking = `${ALBUMS_ROOT}/linking`;
      await cmd.shouldSucceed(`album create ${other}`);
      await cmd.shouldSucceed(`album create ${linking}`);
      await file(`${other}/twin.jpg`);
      await file(`${LAKE}/main.jpg`);
      await file(`${LAKE}/elsewhere.jpg`);
      await client.execJson<AlbumAddResult>(`album add ${linking} ${other}/twin.jpg ${LAKE}/elsewhere.jpg`);
      await cmd.shouldSucceed(`album set ${linking} cover ${other}/twin.jpg`);

      const result = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${LAKE}/main.jpg ${other}/twin.jpg`);
      assertEquals(result.merged, ['albums']);

      const targets = async (album: string) =>
        Object.fromEntries(
          (await vfs.children(ADMIN_ACCESS, album, { follow: false })).filter((entry) => entry.node.props.softlink).map((entry) => [entry.name, entry.node.props.softlink]),
        );
      assertEquals(await targets(other), { 'main.jpg': `${LAKE}/main.jpg` });
      assertEquals(await targets(linking), { 'coverPhoto': `${LAKE}/main.jpg`, 'elsewhere.jpg': `${LAKE}/elsewhere.jpg`, 'main.jpg': `${LAKE}/main.jpg` });
    });

    await t.step('a suggested album holding a drop gets the staged kept file instead, still unpinned', async () => {
      for (const name of ['keep.jpg', 'drop.jpg', 'other.jpg']) await file(`${STAGED}/${name}`);
      const albums = suggestionsOf(`${STAGED}/drop.jpg`)!;
      await client.exec(`mkdir -p ${albums}`);
      const idOf = async (name: string) => (await vfs.get(ADMIN_ACCESS, `${STAGED}/${name}`)).id;
      const link = (name: string, target: string) => ({ type: 'softlink', name, props: { mode: 0o777, softlink: `${STAGED}/${target}` } });
      const meta: AutoAlbumMeta = {
        timeStart: '2026-03-01T10:00:00Z',
        timeEnd: '2026-03-01T12:00:00Z',
        memberKey: memberKeyOf([await idOf('drop.jpg'), await idOf('other.jpg')]),
        memberCount: 2,
        generatedName: 'A walk',
        generatedAt: '2026-03-02T00:00:00Z',
        generatedBy: 'test',
      };
      await vfs.createTree(ADMIN_ACCESS, albums, [{
        type: 'album',
        name: 'walk',
        attrs: { origin: AUTO_ORIGIN, name: 'A walk', autoAlbum: meta },
        children: [link('drop.jpg', 'drop.jpg'), link('other.jpg', 'other.jpg'), link('coverPhoto', 'drop.jpg')],
      }]);

      const result = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${STAGED}/keep.jpg ${STAGED}/drop.jpg`);
      assertEquals(result.trashed, 1);

      const children = await vfs.children(ADMIN_ACCESS, `${albums}/walk`);
      const targets = Object.fromEntries(children.map((child) => [child.name, child.node.props.softlink]));
      assertEquals(targets, { 'coverPhoto': `${STAGED}/keep.jpg`, 'keep.jpg': `${STAGED}/keep.jpg`, 'other.jpg': `${STAGED}/other.jpg` });
      const album = await vfs.get<{ name: string; autoAlbum: AutoAlbumMeta }>(ADMIN_ACCESS, `${albums}/walk`);
      assertEquals(album.attrs.autoAlbum.memberKey, memberKeyOf([await idOf('keep.jpg'), await idOf('other.jpg')]));
      assertEquals(album.attrs.autoAlbum.memberCount, 2);
      assertEquals(isUserEdited(album.attrs, [await idOf('keep.jpg'), await idOf('other.jpg')]), false);
    });

    await t.step("a drop's paired sidecar goes over to a kept file that has none, which is dated by it again", async () => {
      for (const name of ['sidecar-keep.jpg', 'sidecar-drop.jpg', 'sidecar-edited.jpg']) await file(`${STAGED}/${name}`);
      await vfs.update(ADMIN_ACCESS, `${STAGED}/sidecar-keep.jpg`, { attrs: { indexedAt: '2026-10-18T00:00:00Z' } });
      const drop = await vfs.get(ADMIN_ACCESS, `${STAGED}/sidecar-drop.jpg`);
      await vfs.create(ADMIN_ACCESS, 'file', `${STAGED}/sidecar-drop.jpg`, 'sidecar', {
        attrs: { mimetype: 'application/json', sourceId: drop.id, sidecar: { kind: 'takeout', takenAt: '2019-06-01T12:34:56Z', pairedAt: '2026-10-18T00:00:00Z' } },
      });
      // An edited copy sharing the drop's sidecar follows it.
      await cmd.shouldSucceed(`ln -s ${STAGED}/sidecar-drop.jpg/sidecar ${STAGED}/sidecar-edited.jpg/sidecar`);

      const dry = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${STAGED}/sidecar-keep.jpg ${STAGED}/sidecar-drop.jpg --dry-run`);
      assertEquals(dry.merged, ['sidecar']);
      const result = await client.execJson<MergeDuplicatesResult>(`merge-duplicates ${STAGED}/sidecar-keep.jpg ${STAGED}/sidecar-drop.jpg`);
      assertEquals(result.merged, ['sidecar']);
      const keep = await vfs.get(ADMIN_ACCESS, `${STAGED}/sidecar-keep.jpg`);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${STAGED}/sidecar-keep.jpg/sidecar`)).attrs.sourceId, keep.id);
      assertEquals([keep.attrs.takenAt, keep.attrs.takenAtSource], ['2019-06-01T12:34:56Z', 'sidecar']);
      const shared = await vfs.get(ADMIN_ACCESS, `${STAGED}/sidecar-edited.jpg/sidecar`, { follow: false, readlink: true });
      assertEquals(shared.props.softlink, `${STAGED}/sidecar-keep.jpg/sidecar`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
