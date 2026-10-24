/**
 * `media-sidecars`: the unpaired Takeout JSON and XMP files within a folder are paired with the
 * files beside them by Google's and the editors' naming (both JSON forms, the moved number, a cut
 * name, an edited copy sharing its original's) and moved under them as `<file>/sidecar`; an album's
 * `metadata.json` titles its folder; what a person said carries over (a caption, a favourite as a
 * star for the inbox's owner) and an indexed file is dated and placed again. A dry run writes
 * nothing, a second run finds nothing to do, and a second copy of a paired sidecar is removed.
 *
 * The photos are invented nodes with no picture in them, indexed by hand as `exif-extract` leaves
 * a file whose tags hold no date; every JSON and XMP packet is invented.
 */
import type { MediaSidecarsAnswer } from '@archive/media/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const CATEGORY = '/home/admin/staging/files/google-photos';
const PHOTOS = `${CATEGORY}/upload-2026-10-18/Takeout/Google Photos/Photos from 2019`;
const ALBUM = `${CATEGORY}/upload-2026-10-18/Takeout/Google Photos/Sommar i Exempelstad`;
const LONG = 'Exempelstad_hamnfest_med_segelbatar_och_musik_2019.jpg';
const SHORTENED = `${LONG.slice(0, 43)}.jpg`;

/** A Takeout JSON for the photo named `title`, taken at `taken` (epoch seconds), with `more`. */
const takeout = (title: string, taken: number, more: Record<string, unknown> = {}) =>
  JSON.stringify({
    title,
    description: '',
    creationTime: { timestamp: '1782900000', formatted: '1 Jul 2026, 10:00:00 UTC' },
    photoTakenTime: { timestamp: String(taken), formatted: '' },
    geoData: { latitude: 0, longitude: 0, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
    geoDataExif: { latitude: 0, longitude: 0, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
    url: 'https://photos.google.com/photo/AF1Qip-example',
    ...more,
  });

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:DateCreated="1968-07"/>
</rdf:RDF></x:xmpmeta>`;

Deno.test({ name: 'media-sidecars', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const sidecars = (args: string) => client.execJson<MediaSidecarsAnswer>(`media-sidecars ${args}`);
  const attrsOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs as Record<string, unknown>;

  /** A file with `body`, typed `mimetype`, as an upload leaves it (size and sha256 from the write). */
  const put = async (path: string, body: string, mimetype: string) => {
    const slash = path.lastIndexOf('/');
    await vfs.create(ADMIN_ACCESS, 'file', path.slice(0, slash), path.slice(slash + 1), { attrs: { mimetype } });
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };
  /** A photo as `exif-extract` leaves one whose tags hold no date or place. */
  const photo = async (path: string, mimetype = 'image/jpeg') => {
    await put(path, `bytes of ${path}`, mimetype);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { indexedAt: '2026-10-18T00:00:00Z' } });
    await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.create(ADMIN_ACCESS, 'exif', `${path}/metadata`, 'exif', { attrs: { indexedAt: '2026-10-18T00:00:00Z', when: {} } });
  };

  try {
    await cmd.shouldSucceed('staging init && staging category google-photos --create --kind google-photos');
    await cmd.shouldSucceed(`mkdir -p '${PHOTOS}' && mkdir -p '${ALBUM}'`);

    // Both JSON forms, the number Google moves to the end, a cut name, an edited copy, a photo
    // no JSON is for, a JSON no photo is for, and JSON that is no sidecar.
    await photo(`${PHOTOS}/IMG_0001.jpg`);
    await put(
      `${PHOTOS}/IMG_0001.jpg.supplemental-metadata.json`,
      takeout('IMG_0001.jpg', 1559392496, {
        description: 'En segelbåt vid bryggan',
        favorited: true,
        geoData: { latitude: 57.7, longitude: 11.95 },
        geoDataExif: { latitude: 57.7, longitude: 11.95 },
      }),
      'application/json',
    );
    await photo(`${PHOTOS}/IMG_0001(1).jpg`);
    await put(`${PHOTOS}/IMG_0001.jpg.supplemental-metadata(1).json`, takeout('IMG_0001.jpg', 1559400000), 'application/json');
    await photo(`${PHOTOS}/${SHORTENED}`);
    await put(`${PHOTOS}/${LONG.slice(0, 46)}.json`, takeout(LONG, 1562000000), 'application/json');
    await photo(`${PHOTOS}/IMG_0002.jpg`);
    await photo(`${PHOTOS}/IMG_0002-edited.jpg`);
    await put(`${PHOTOS}/IMG_0002.jpg.json`, takeout('IMG_0002.jpg', 1563000000), 'application/json');
    await photo(`${PHOTOS}/IMG_0009.jpg`);
    await put(`${PHOTOS}/IMG_0008.jpg.json`, takeout('IMG_0008.jpg', 1563000000), 'application/json');
    await put(`${PHOTOS}/print-settings.json`, JSON.stringify({ paper: 'A4' }), 'application/json');
    // An album with its metadata, and a scan an editor dated in an XMP file.
    await put(
      `${ALBUM}/metadata.json`,
      JSON.stringify({ title: 'Sommar i Exempelstad', description: 'Veckan vid sjön', access: 'protected', date: { timestamp: '0' } }),
      'application/json',
    );
    await photo(`${ALBUM}/IMG_0003.jpg`);
    await put(`${ALBUM}/IMG_0003.jpg.json`, takeout('IMG_0003.jpg', 1561980000), 'application/json');
    await photo(`${ALBUM}/scan0004.tif`, 'image/tiff');
    await put(`${ALBUM}/scan0004.xmp`, XMP, 'application/rdf+xml');

    const root = `${CATEGORY}/upload-2026-10-18`;
    const counts = (answer: MediaSidecarsAnswer) => {
      const { ok, found, paired, shared, albums, duplicates, unmatched, other, described, starred, retimed, positioned } = answer;
      return { ok, found, paired, shared, albums, duplicates, unmatched, other, described, starred, retimed, positioned };
    };
    const expected = {
      ok: true,
      found: 9,
      paired: 6,
      shared: 1,
      albums: 1,
      duplicates: 0,
      unmatched: 1,
      other: 1,
      described: 1,
      starred: 1,
      retimed: 7,
      positioned: 1,
    };

    await t.step('a dry run counts what it would do and writes nothing', async () => {
      const answer = await sidecars(`'${root}' --dry-run`);
      assertEquals(counts(answer), expected);
      assertEquals(answer.dryRun, true);
      assertEquals(answer.unmatchedPaths, [`${PHOTOS}/IMG_0008.jpg.json`]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PHOTOS}/IMG_0001.jpg/sidecar`), false);
      assertEquals((await attrsOf(`${PHOTOS}/IMG_0001.jpg.supplemental-metadata.json`)).sidecar, undefined);
      assertEquals((await attrsOf(`${PHOTOS}/IMG_0001.jpg`)).takenAt, undefined);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/home/admin/stars'), false);
    });

    await t.step('each sidecar goes under its photo, named by both forms, the moved number and a cut name', async () => {
      const answer = await sidecars(`'${root}'`);
      assertEquals(counts(answer), expected);
      assertEquals(answer.failed, []);
      for (
        const [file, sidecar] of [
          ['IMG_0001.jpg', 'IMG_0001.jpg.supplemental-metadata.json'],
          ['IMG_0001(1).jpg', 'IMG_0001.jpg.supplemental-metadata(1).json'],
          [SHORTENED, `${LONG.slice(0, 46)}.json`],
          ['IMG_0002.jpg', 'IMG_0002.jpg.json'],
        ]
      ) {
        const node = await vfs.get(ADMIN_ACCESS, `${PHOTOS}/${file}/sidecar`);
        assertEquals([node.attrs.sourceId, (node.attrs.sidecar as { kind: string }).kind], [(await vfs.get(ADMIN_ACCESS, `${PHOTOS}/${file}`)).id, 'takeout'], file);
        assertEquals(await vfs.exists(ADMIN_ACCESS, `${PHOTOS}/${sidecar}`), false, sidecar);
      }
      // What is no sidecar's, and what no photo is for, stay where they are.
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PHOTOS}/IMG_0008.jpg.json`), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PHOTOS}/print-settings.json`), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PHOTOS}/IMG_0009.jpg/sidecar`), false);
    });

    await t.step("an edited copy shares its original's sidecar through a softlink", async () => {
      const link = await vfs.get(ADMIN_ACCESS, `${PHOTOS}/IMG_0002-edited.jpg/sidecar`, { follow: false, readlink: true });
      assertEquals(link.props.softlink, `${PHOTOS}/IMG_0002.jpg/sidecar`);
    });

    await t.step("the photos are dated by the sidecar's instant, and placed by its place", async () => {
      const dated = await attrsOf(`${PHOTOS}/IMG_0001.jpg`);
      assertEquals([dated.takenAt, dated.takenAtUtc, dated.takenAtSource], ['2019-06-01T12:34:56Z', '2019-06-01T12:34:56Z', 'sidecar']);
      assertEquals((await attrsOf(`${PHOTOS}/IMG_0001(1).jpg`)).takenAtUtc, '2019-06-01T14:40:00Z');
      assertEquals((await attrsOf(`${PHOTOS}/IMG_0002-edited.jpg`)).takenAtUtc, '2019-07-13T06:40:00Z');
      assertEquals((await vfs.getPoints(ADMIN_ACCESS, [(await vfs.get(ADMIN_ACCESS, `${PHOTOS}/IMG_0001.jpg/position`)).id])).size, 1);
      assertEquals((await attrsOf(`${PHOTOS}/IMG_0009.jpg`)).takenAt, undefined);
      // An XMP date is a person's, at the precision they gave it.
      const scan = await attrsOf(`${ALBUM}/scan0004.tif`);
      assertEquals([scan.takenAt, scan.takenAtSource], ['1968-07', 'sidecar']);
    });

    await t.step('a caption becomes the description, a favourite a star for the inbox owner, an album its folder title', async () => {
      assertEquals((await attrsOf(`${PHOTOS}/IMG_0001.jpg`)).description, 'En segelbåt vid bryggan');
      const stars = await vfs.children(ADMIN_ACCESS, '/home/admin/stars', { follow: false });
      assertEquals(stars.map((entry) => entry.node.props.softlink), [`${PHOTOS}/IMG_0001.jpg`]);
      const folder = await vfs.get(ADMIN_ACCESS, ALBUM);
      assertEquals([folder.attrs.title, folder.attrs.description], ['Sommar i Exempelstad', 'Veckan vid sjön']);
      const metadata = await attrsOf(`${ALBUM}/metadata.json`);
      assertEquals([metadata.sourceId, (metadata.sidecar as { kind: string }).kind], [folder.id, 'takeout-album']);
    });

    await t.step('a second run finds nothing more to pair', async () => {
      const before = await vfs.get(ADMIN_ACCESS, `${PHOTOS}/IMG_0001.jpg/sidecar`);
      const answer = await sidecars(`'${root}'`);
      assertEquals(counts(answer), { ...expected, found: 2, paired: 0, shared: 0, albums: 0, described: 0, starred: 0, retimed: 0, positioned: 0 });
      assertEquals((await vfs.get(ADMIN_ACCESS, `${PHOTOS}/IMG_0001.jpg/sidecar`)).props.modtime, before.props.modtime);
    });

    await t.step('a second copy of a paired sidecar is removed; one that says otherwise stays unmatched', async () => {
      const paired = await vfs.get(ADMIN_ACCESS, `${ALBUM}/IMG_0003.jpg/sidecar`);
      await put(`${ALBUM}/IMG_0003.jpg.supplemental-metadata.json`, takeout('IMG_0003.jpg', 1561980000), 'application/json');
      assertEquals((await attrsOf(`${ALBUM}/IMG_0003.jpg.supplemental-metadata.json`)).sha256, paired.attrs.sha256);
      let answer = await sidecars(`'${ALBUM}'`);
      assertEquals([answer.found, answer.duplicates, answer.paired, answer.unmatched], [1, 1, 0, 0]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUM}/IMG_0003.jpg.supplemental-metadata.json`), false);

      await put(`${ALBUM}/IMG_0003.jpg.supplemental-metadata.json`, takeout('IMG_0003.jpg', 1500000000), 'application/json');
      answer = await sidecars(`'${ALBUM}'`);
      assertEquals([answer.found, answer.duplicates, answer.paired, answer.unmatched], [1, 0, 0, 1]);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUM}/IMG_0003.jpg.supplemental-metadata.json`));
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
