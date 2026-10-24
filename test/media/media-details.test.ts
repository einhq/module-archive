/**
 * media-details: one read aggregating description, capture time, location,
 * location, the device with its owners, the albums holding the file, tagged people
 * (with age at capture) and comments.
 */

import { ALBUMS_ROOT, DEVICES_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, modeUnder, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type NodeRef = { id: string; path: string; name: string };

type Box = { x: number; y: number; width: number; height: number };

type Details = {
  name: string;
  ownership: { uid: number; gid: number; mode: number };
  description?: string;
  content?: string;
  contentTruncated?: boolean;
  contentLanguage?: { code: string; confidence?: number };
  contentLanguageManual?: string;
  takenAt?: string;
  angle: number;
  mirror: boolean;
  mimetype?: string;
  size?: number;
  exif: {
    make?: string;
    model?: string;
    iso?: number;
    exposure?: number;
    fps?: number;
    duration?: number;
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    raw?: Record<string, unknown>;
  } | null;
  position: { lat: number; lng: number; address?: string } | null;
  location: (NodeRef & { lat?: number; lng?: number; radius?: number }) | null;
  photographer: NodeRef | null;
  device: (NodeRef & { make?: string; model?: string; owners: (NodeRef & { from?: string; to?: string })[] }) | null;
  albums: (NodeRef & { memberPath?: string })[];
  people: { id: string; name: string; born?: string; age?: number; ageMonths?: number; ageApprox?: boolean; source: string; faceBox?: Box }[];
  faces: { faceId: string; facePath: string; faceBox: Box; hasFace: boolean; personId?: string; personPath?: string; personName?: string; unnamed?: boolean }[];
  unknownFaces: { faceId: string; facePath: string; personId: string; personPath: string; personName: string; faceBox?: Box }[];
  comments: { body: string; author: string }[];
  hashes: { sha256?: string; sha1?: string; md5?: string };
  fingerprints: { name: string; computedAt?: string; computedBy?: string }[];
  storyboard?: { name: string; sha256: string; interval: number; count: number; columns: number; tileWidth: number; tileHeight: number };
  chapters?: number[];
  albumStack?: {
    albumId: string;
    albumPath: string;
    albumOwnership: { uid: number; gid: number; mode: number };
    excluded: boolean;
    membersComplete: boolean;
    frontId?: string;
    members: { id: string; path: string; name: string; ownership: { uid: number; gid: number; mode: number } }[];
  };
};

const FILE = `${ALBUMS_ROOT}/a/files/p.jpg`;

Deno.test({
  name: 'media-details',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a/files && mkdir -p ${PEOPLE_ROOT} && mkdir -p ${LOCATIONS_ROOT}`);
    await client.exec(`mkfile ${FILE}`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna --name Anna --born 1980-05-02`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/bo --name Bo --born 1975`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/cid --name Cid`);
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/infant --name Infant --born 2019-01-20`);

    await t.step('bare file yields empty sections and no capture time', async () => {
      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.name, 'p.jpg');
      // A new node is its creator's and takes the group of the node it was created in.
      const folder = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/a/files`)).props;
      assertEquals(details.ownership, { uid: ADMIN_ACCESS.uid, gid: folder.gid, mode: modeUnder(folder.mode) });
      // modtime is not a capture time — ages must not be derived from it
      assertEquals(details.takenAt, undefined);
      assertEquals(details.position, null);
      assertEquals(details.location, null);
      assertEquals(details.photographer, null);
      assertEquals(details.people, []);
      assertEquals(details.faces, []);
      assertEquals(details.comments, []);
      assertEquals(details.exif, null);
      assertEquals(details.angle, 0);
      assertEquals(details.mirror, false);
      assertEquals(details.device, null);
      assertEquals(details.fingerprints, []);
      // `/albums/a` is a plain directory here, so there is no album above the file.
      assertEquals(details.albums, []);
    });

    await t.step('reports description, capture time, location and location', async () => {
      await cmd.shouldSucceed(`attrs ${FILE} -s description="Boat trip"`);
      await cmd.shouldSucceed(`file-set-time ${FILE} 2019-06-14T13:45:02Z`);
      await cmd.shouldSucceed(`file-set-position ${FILE} 57.685 11.944`);
      await cmd.shouldSucceed(`attrs ${FILE}/position -s displayName="Gothenburg, Sweden"`);
      await cmd.shouldSucceed(`mknode -t position ${LOCATIONS_ROOT}/harbour --as name=Harbour`);
      await cmd.shouldSucceed(`ln -s ${LOCATIONS_ROOT}/harbour ${FILE}/location`);
      await cmd.shouldSucceed(`file-set-photographer ${FILE} ${PEOPLE_ROOT}/cid`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.description, 'Boat trip');
      assertEquals(details.takenAt, '2019-06-14T13:45:02Z');
      assertEquals(details.position?.lat, 57.685);
      assertEquals(details.position?.address, 'Gothenburg, Sweden');
      assertEquals(details.location?.name, 'Harbour');
      assertEquals(details.location?.id, 'harbour');
      assertEquals(details.photographer?.name, 'Cid');
    });

    await t.step('tagged people carry their age at capture time', async () => {
      await cmd.shouldSucceed(`mkdir ${FILE}/people`);
      await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/anna ${FILE}/people/anna`);
      await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/bo ${FILE}/people/bo`);
      await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/infant ${FILE}/people/infant`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.people.map((p) => p.name), ['Anna', 'Bo', 'Infant']);

      const anna = details.people[0];
      assertEquals(anna.age, 39);
      assertEquals(anna.ageApprox, false);
      assertEquals(anna.source, 'tag');

      // year-only birth date: age is approximate
      assertEquals(details.people[1].age, 44);
      assertEquals(details.people[1].ageApprox, true);

      assertEquals(details.people[2].age, 0);
      assertEquals(details.people[2].ageMonths, 4);
    });

    await t.step('without a capture time people carry no age', async () => {
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/a/files/undated.jpg`);
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/a/files/undated.jpg/people`);
      await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/anna ${ALBUMS_ROOT}/a/files/undated.jpg/people/anna`);

      const details = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/a/files/undated.jpg`);
      assertEquals(details.takenAt, undefined);
      assertEquals(details.people[0].name, 'Anna');
      assertEquals(details.people[0].age, undefined);
    });

    await t.step('faces with a personId add people, tags win over faces', async () => {
      const cidId = (await client.execJson<{ id: string }>(`info ${PEOPLE_ROOT}/cid`)).id;
      const annaId = (await client.execJson<{ id: string }>(`info ${PEOPLE_ROOT}/anna`)).id;

      await cmd.shouldSucceed(`mkdir ${FILE}/regions`);
      await cmd.shouldSucceed(`mknode -t media-region ${FILE}/regions/face-1 --as personId=${cidId}`);
      await cmd.shouldSucceed(`mknode -t media-region ${FILE}/regions/face-2 --as personId=${annaId}`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.people.map((p) => p.name), ['Anna', 'Bo', 'Cid', 'Infant']);
      assertEquals(details.people.find((p) => p.name === 'Cid')?.source, 'face');
      assertEquals(details.people.find((p) => p.name === 'Anna')?.source, 'tag');
    });

    await t.step('an unnamed person is kept out of people and reported as an unidentified face', async () => {
      // Auto-created people are real person nodes, but listing them beside the
      // named ones would swamp the sidebar with "Unknown …" rows.
      await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT}/unknown`);
      await cmd.shouldSucceed(`mknode -t person ${PEOPLE_ROOT}/unknown/xyz --as "name=Unknown XYZ" --aj "unnamed=true"`);
      const unknownId = (await client.execJson<{ id: string }>(`info ${PEOPLE_ROOT}/unknown/xyz`)).id;
      await cmd.shouldSucceed(`mknode -t media-region ${FILE}/regions/face-3 --as personId=${unknownId}`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.people.map((p) => p.name), ['Anna', 'Bo', 'Cid', 'Infant'], 'named people unchanged');
      assertEquals(details.unknownFaces.length, 1);
      assertEquals(details.unknownFaces[0].personId, unknownId);
      assertEquals(details.unknownFaces[0].personName, 'Unknown XYZ');
      assertEquals(details.unknownFaces[0].facePath, `${FILE}/regions/face-3`);
      assertEquals(details.unknownFaces[0].facePath, `${FILE}/regions/face-3`);
    });

    await t.step('reports the camera, and the resolution as displayed', async () => {
      await cmd.shouldSucceed(`attrs ${FILE} -J width=4000 -J height=3000 -J angle=90`);
      await cmd.shouldSucceed(`mkdir -p ${FILE}/metadata`);
      await cmd.shouldSucceed(`mknode -t exif ${FILE}/metadata/exif`);
      await cmd.shouldSucceed(
        `attrs ${FILE}/metadata/exif -J 'deviceinfo={"make":"Canon","model":"EOS 40D"}' -J 'fileinfo={"width":4000,"height":3000,"iso":400,"exposure":0.004}'`,
      );

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.angle, 90);
      assertEquals(details.exif?.make, 'Canon');
      assertEquals(details.exif?.model, 'EOS 40D');
      assertEquals(details.exif?.iso, 400);
      // A quarter turn swaps the axes: what is stored is 4000x3000, what is seen is 3000x4000.
      assertEquals(details.exif?.width, 4000);
      assertEquals(details.exif?.displayWidth, 3000);
      assertEquals(details.exif?.displayHeight, 4000);
    });

    await t.step('the raw dump only travels with --fields raw', async () => {
      await cmd.shouldSucceed(`attrs ${FILE}/metadata/exif -J 'raw={"LensModel":"EF-S 17-55"}'`);
      assertEquals((await client.execJson<Details>(`media-details ${FILE}`)).exif?.raw, undefined);
      const withRaw = await client.execJson<Details>(`media-details ${FILE} --fields raw`);
      assertEquals(withRaw.exif?.raw, { LensModel: 'EF-S 17-55' });
    });

    await t.step('face boxes reach the client, named and unnamed alike', async () => {
      await cmd.shouldSucceed(`attrs ${FILE}/regions/face-1 -J 'faceBox={"x":0.1,"y":0.2,"width":0.3,"height":0.4}'`);
      await cmd.shouldSucceed(`attrs ${FILE}/regions/face-3 -J 'faceBox={"x":0.5,"y":0.5,"width":0.1,"height":0.1}'`);
      const cidId = (await client.execJson<{ id: string }>(`info ${PEOPLE_ROOT}/cid`)).id;
      await cmd.shouldSucceed(`mknode -t media-region ${FILE}/regions/face-4 --as personId=${cidId}`);
      await cmd.shouldSucceed(`attrs ${FILE}/regions/face-4 -J 'faceBox={"x":0.65,"y":0.1,"width":0.2,"height":0.25}'`);
      await cmd.shouldSucceed(`mknode -t embedding ${FILE}/regions/face-4/embedding --as embeddingType=face`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.people.find((p) => p.name === 'Cid')?.faceBox, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
      assertEquals(details.unknownFaces[0].faceBox, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 });
      assertEquals(details.faces.map((face) => face.facePath), [
        `${FILE}/regions/face-1`,
        `${FILE}/regions/face-3`,
        `${FILE}/regions/face-4`,
      ]);
      assertEquals(details.faces.filter((face) => face.personName === 'Cid').length, 2, 'named people stay collapsed but their boxes do not');
      // Only a region with an embedding is a face; the others are tags, drawn dashed.
      assertEquals(details.faces.map((face) => face.hasFace), [false, false, true]);
      // A tag without a face still has no box — the sidebar shows the name, the overlay does not.
      assertEquals(details.people.find((p) => p.name === 'Anna')?.faceBox, undefined);
    });

    await t.step('a location carries its own point, so a file without GPS still maps', async () => {
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/a/files/placed.jpg`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/quay --as name=Quay`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/quay/position --lat=57.7 --lng=11.9`);
      await cmd.shouldSucceed(`ln -s ${LOCATIONS_ROOT}/quay ${ALBUMS_ROOT}/a/files/placed.jpg/location`);

      const details = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/a/files/placed.jpg`);
      assertEquals(details.position, null, 'the file itself has no GPS');
      assertEquals(details.location?.lat, 57.7);
      assertEquals(details.location?.lng, 11.9);
    });

    await t.step('includes comments', async () => {
      await cmd.shouldSucceed(`comment add ${FILE} --body "lovely light"`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.comments.length, 1);
      assertEquals(details.comments[0].body, 'lovely light');
      assertEquals(details.comments[0].author, 'admin');
    });

    await t.step('the extracted text travels separately from the description', async () => {
      const target = `${ALBUMS_ROOT}/a/files/scanned.jpg`;
      await cmd.shouldSucceed(`mkfile ${target}`);
      await cmd.shouldSucceed(`attrs ${target} -s 'description=Grandmother in the garden'`);
      await cmd.shouldSucceed(`mkdir -p ${target}/metadata`);
      await cmd.shouldSucceed(`mkfile ${target}/metadata/content`);
      await cmd.shouldSucceed(`echo 'Exempelgatan 2 Lund' > ${target}/metadata/content`);

      const details = await client.execJson<Details>(`media-details ${target}`);
      // The hand-written one is untouched by the machine-written field.
      assertEquals(details.description, 'Grandmother in the garden');
      assertEquals(details.content, 'Exempelgatan 2 Lund');
      assertEquals(details.contentTruncated, undefined);
      assertEquals([details.contentLanguage, details.contentLanguageManual], [undefined, undefined]);
    });

    await t.step('the language the text was read in travels with it, and the one a person set', async () => {
      const target = `${ALBUMS_ROOT}/a/files/scanned.jpg`;
      await vfs.update(ADMIN_ACCESS, `${target}/metadata/content`, { attrs: { ocrLanguage: 'sv', ocrLanguageConfidence: 0.97 } });
      assertEquals((await client.execJson<Details>(`media-details ${target}`)).contentLanguage, { code: 'sv', confidence: 0.97 });

      await vfs.update(ADMIN_ACCESS, target, { attrs: { ocrLanguageManual: 'en' } });
      await vfs.update(ADMIN_ACCESS, `${target}/metadata/content`, { attrs: { ocrLanguage: 'en', ocrLanguageConfidence: null } });
      const details = await client.execJson<Details>(`media-details ${target}`);
      assertEquals([details.contentLanguage, details.contentLanguageManual], [{ code: 'en' }, 'en']);
    });

    await t.step('a file without extracted text reports none', async () => {
      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.content, undefined);
    });

    await t.step('reports the containing album, and the albums that link the file', async () => {
      // An album holds its files and links the ones added to it. Both
      // have to answer, and only the reverse lookup can see the second kind.
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/summer --name Summer`);
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/summer/boat.jpg`);
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/auto --name Automatic`);
      await cmd.shouldSucceed(`ln -s ${ALBUMS_ROOT}/summer/boat.jpg ${ALBUMS_ROOT}/auto/boat.jpg`);

      const details = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/summer/boat.jpg`);
      assertEquals(details.albums.map((a) => a.name), ['Automatic', 'Summer']);

      const auto = details.albums.find((a) => a.name === 'Automatic')!;
      assertEquals(auto.path, `${ALBUMS_ROOT}/auto`);
      // The link is reported as well as the album: unfiling acts on the link.
      assertEquals(auto.memberPath, `${ALBUMS_ROOT}/auto/boat.jpg`);

      const summer = details.albums.find((a) => a.name === 'Summer')!;
      assertEquals(summer.path, `${ALBUMS_ROOT}/summer`);
      assertEquals(summer.memberPath, undefined, 'where the file lives carries no member link');
    });

    await t.step('a relation below a picture in another album does not file the file there', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/winter --name Winter`);
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/winter/snow.jpg`);
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/winter/snow.jpg/relations`);
      await cmd.shouldSucceed(`ln -s ${ALBUMS_ROOT}/summer/boat.jpg ${ALBUMS_ROOT}/winter/snow.jpg/relations/related-1`);

      const details = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/summer/boat.jpg`);
      assertEquals(details.albums.map((a) => a.name), ['Automatic', 'Summer']);
    });

    await t.step('an album is found through a files/ directory too', async () => {
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/imported --name Imported`);
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/imported/files`);
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/imported/files/scan.jpg`);

      const details = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/imported/files/scan.jpg`);
      assertEquals(details.albums.map((a) => a.path), [`${ALBUMS_ROOT}/imported`]);
    });

    await t.step('album context reports ordered stack members, ownership and exclusions', async () => {
      await cmd.shouldSucceed(`mkfile ${ALBUMS_ROOT}/summer/burst-2.jpg`);
      const album = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer`);
      const front = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer/boat.jpg`);
      const second = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer/burst-2.jpg`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer`, {
        attrs: {
          mediaStacks: {
            version: 1,
            threshold: 0.85,
            maxGapSeconds: 10,
            sourceSignature: 'details-test',
            computedAt: '2026-08-30T00:00:00Z',
            excludedIds: [],
            groups: [{ frontId: front.id, memberIds: [front.id, second.id] }],
          },
        },
      });

      const stacked = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/summer/burst-2.jpg --album ${ALBUMS_ROOT}/summer`);
      assertEquals(stacked.albumStack?.albumId, album.id);
      assertEquals(stacked.albumStack?.frontId, front.id);
      assertEquals(stacked.albumStack?.membersComplete, true);
      assertEquals(stacked.albumStack?.members.map((member) => member.path), [`${ALBUMS_ROOT}/summer/boat.jpg`, `${ALBUMS_ROOT}/summer/burst-2.jpg`]);
      const summerMode = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer`)).props.mode;
      assertEquals(stacked.albumStack?.members.every((member) => member.ownership.mode === modeUnder(summerMode)), true);

      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/summer`, {
        attrs: {
          mediaStacks: {
            version: 1,
            threshold: 0.85,
            maxGapSeconds: 10,
            sourceSignature: 'details-test-2',
            computedAt: '2026-08-30T00:01:00Z',
            excludedIds: [second.id],
            groups: [],
          },
        },
      });
      const separated = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/summer/burst-2.jpg --album ${ALBUMS_ROOT}/summer`);
      assertEquals(separated.albumStack?.excluded, true);
      assertEquals(separated.albumStack?.members.map((member) => member.id), [second.id]);
    });

    await t.step('a coverPhoto link does not make the picture a member', async () => {
      // An album may use a photo living somewhere else as its cover. That is a
      // link pointing at the file like any member link, and it is not membership.
      await cmd.shouldSucceed(`album create ${ALBUMS_ROOT}/borrowed --name Borrowed --cover ${ALBUMS_ROOT}/summer/boat.jpg`);

      const details = await client.execJson<Details>(`media-details ${ALBUMS_ROOT}/summer/boat.jpg`);
      assertEquals(details.albums.map((a) => a.name), ['Automatic', 'Summer']);
    });

    await t.step('reports the device with its owners and their ownership span', async () => {
      await cmd.shouldSucceed(`mkdir -p ${DEVICES_ROOT}`);
      await cmd.shouldSucceed(`device-create ${DEVICES_ROOT}/eos --name "Canon EOS 40D" --make Canon --model "EOS 40D"`);
      await cmd.shouldSucceed(`device-set-owner ${DEVICES_ROOT}/eos ${PEOPLE_ROOT}/anna --from 2008 --to 2014`);
      await cmd.shouldSucceed(`device-set-owner ${DEVICES_ROOT}/eos ${PEOPLE_ROOT}/bo`);
      await cmd.shouldSucceed(`attrs ${FILE} -s devicePath=${DEVICES_ROOT}/eos`);

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.device?.path, `${DEVICES_ROOT}/eos`);
      assertEquals(details.device?.name, 'Canon EOS 40D');
      assertEquals(details.device?.owners.map((o) => o.name), ['Anna', 'Bo']);
      assertEquals(details.device?.owners[0].from, '2008');
      assertEquals(details.device?.owners[0].to, '2014');
      assertEquals(details.device?.owners[1].from, undefined);
    });

    await t.step('reports whatever content hashes the node carries', async () => {
      // file-sync writes sha256; the legacy import wrote md5 and sha1 and no
      // sha256 at all. Both have to come back.
      const legacy = `${ALBUMS_ROOT}/a/files/legacy.jpg`;
      await cmd.shouldSucceed(`mkfile ${legacy}`);
      await cmd.shouldSucceed(`attrs ${legacy} -s md5=7e1660 -s sha1=39380f`);
      assertEquals((await client.execJson<Details>(`media-details ${legacy}`)).hashes, { sha1: '39380f', md5: '7e1660' });

      await cmd.shouldSucceed(`attrs ${FILE} -s sha256=9f2a00`);
      assertEquals((await client.execJson<Details>(`media-details ${FILE}`)).hashes, { sha256: '9f2a00' });
    });

    await t.step('reports fingerprint provenance, never the vector', async () => {
      await cmd.shouldSucceed(
        `mknode -t embedding ${FILE}/metadata/sscd-image --as embeddingType=sscd-image --as computedBy=sscd_disc_mixup --as computedAt=2026-03-11T09:00:00Z`,
      );

      const details = await client.execJson<Details>(`media-details ${FILE}`);
      assertEquals(details.fingerprints.length, 1);
      assertEquals(details.fingerprints[0].name, 'sscd-image');
      assertEquals(details.fingerprints[0].computedBy, 'sscd_disc_mixup');
      assertEquals(details.fingerprints[0].computedAt, '2026-03-11T09:00:00Z');
    });

    await t.step("a video's storyboard sheet travels with how to read it; one half-written does not", async () => {
      const video = `${ALBUMS_ROOT}/a/files/film.mp4`;
      await cmd.shouldSucceed(`mkfile ${video} && attrs ${video} -s mimetype=video/mp4`);
      await cmd.shouldSucceed(`mkdir -p ${video}/thumbnails && printf sheet > ${video}/thumbnails/storyboard-160.avif`);
      assertEquals((await client.execJson<Details>(`media-details ${video}`)).storyboard, undefined);

      const geometry = { interval: 1, count: 182, columns: 12, rows: 16, tileWidth: 160, tileHeight: 120 };
      await vfs.update(ADMIN_ACCESS, `${video}/thumbnails/storyboard-160.avif`, { attrs: { storyboard: geometry, sha256: 'ab12' } });
      assertEquals((await client.execJson<Details>(`media-details ${video}`)).storyboard, {
        name: 'storyboard-160.avif',
        sha256: 'ab12',
        interval: 1,
        count: 182,
        columns: 12,
        tileWidth: 160,
        tileHeight: 120,
      });
      // Only a video is read for one.
      assertEquals((await client.execJson<Details>(`media-details ${FILE}`)).storyboard, undefined);
    });

    await t.step("a video's chapters start at 0 and at each cut; a video with no cut has none", async () => {
      const video = `${ALBUMS_ROOT}/a/files/film.mp4`;
      await cmd.shouldSucceed(`mkdir -p ${video}/metadata && mknode -t file --as "mimetype=text/vtt" ${video}/metadata/chapters`);
      await vfs.update(ADMIN_ACCESS, `${video}/metadata/chapters`, { attrs: { boundaries: [] } });
      assertEquals((await client.execJson<Details>(`media-details ${video}`)).chapters, undefined);
      await vfs.update(ADMIN_ACCESS, `${video}/metadata/chapters`, {
        attrs: { boundaries: [{ t: 6.2, score: 0.97, kind: 'cut' }, { t: 41.12, score: null, kind: 'leader' }] },
      });
      assertEquals((await client.execJson<Details>(`media-details ${video}`)).chapters, [0, 6.2, 41.12]);
    });

    await t.step('missing file fails', async () => {
      await cmd.shouldFail(`media-details ${ALBUMS_ROOT}/a/files/nope.jpg`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
