/**
 * raw: RAW detection and RAW↔non-RAW pairing by metadata (capture timestamp,
 * camera) and filename stem; --sort files a RAW under its same-named partner's
 * versions/, follows an album's links, and drops the RAW's regions.
 */

import { assert, assertEquals } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';
import { ALBUMS_ROOT } from '@archive/paths';
import { RAW_IMAGE_MIMETYPES } from '@ein/client';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Partner = { path: string; score: number; reasons: string[] };
type SingleResult = { path: string; raw: boolean; mimetype: string | null; partners: Partner[] };
type ScanResult = {
  scope: string;
  count: number;
  pairs: { raw: string; mimetype: string | null; partners: Partner[] }[];
  unmatched: string[];
};

type SortSingle = {
  path: string;
  raw: boolean;
  mimetype: string | null;
  action: string;
  dest?: string;
  partner?: string;
  error?: string;
  note?: string;
};
type Added = { facePath: string; personPath: string };
type SortScan = {
  scope: string;
  count: number;
  sorted: { raw: string; dest: string }[];
  ambiguous: string[];
  left: string[];
  errors: { raw: string; error: string }[];
};

const T1 = '2020-01-01T10:00:00';
const T2 = '2020-02-02T11:00:00';
const T3 = '2020-03-03T12:00:00';
// distinct timestamps for the --sort fixtures so they never collide with T1..T3
const TS1 = '2021-01-01T10:00:00';
const TS2 = '2021-02-02T11:00:00';
const TS3 = '2021-03-03T12:00:00';
const TS4 = '2021-04-04T13:00:00';

Deno.test({
  name: 'raw',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  try {
    const seed = async (path: string, mimetype: string, takenAt?: string, extra: Record<string, unknown> = {}) => {
      await client.exec(`echo x > ${path}`);
      const attrs: Record<string, unknown> = { size: 2, mimetype, ...extra };
      if (takenAt) attrs.takenAt = takenAt;
      await vfs.update(ADMIN_ACCESS, path, { attrs });
    };

    await client.exec('mkdir -p /a && mkdir -p /b && mkdir -p /c');
    // Same-shot pair: same stem, dir and takenAt.
    await seed('/a/IMG_1.CR2', 'image/x-canon-cr2', T1);
    await seed('/a/IMG_1.JPG', 'image/jpeg', T1);
    // Lone RAW: no non-RAW partner anywhere.
    await seed('/a/IMG_2.NEF', 'image/x-nikon-nef', T2);
    // Rendition: has a sourceId, so it must never count as a RAW original.
    await seed('/a/IMG_3.CR2', 'image/x-canon-cr2', T1, { sourceId: 'node-src' });
    // Cross-directory metadata-only pair: shared takenAt, different stem and dir.
    await seed('/b/rawshot.dng', 'image/x-adobe-dng', T3);
    await seed('/c/editedphoto.jpg', 'image/jpeg', T3);

    // --sort fixtures
    await client.exec('mkdir -p /s && mkdir -p /s1');
    // clean pair → sorted under the JPEG's versions/
    await seed('/s1/SHOT.CR2', 'image/x-canon-cr2', TS4);
    await seed('/s1/SHOT.JPG', 'image/jpeg', TS4);
    // /s: a clean pair, a lone RAW, an ambiguous RAW (two equal-scoring partners of its name),
    // and a RAW whose only partner shares its time and folder but not its name
    await seed('/s/PIC_1.CR2', 'image/x-canon-cr2', TS1);
    await seed('/s/PIC_1.JPG', 'image/jpeg', TS1);
    await seed('/s/LONE.NEF', 'image/x-nikon-nef', TS2);
    await seed('/s/AMB.CR2', 'image/x-canon-cr2', TS3);
    await seed('/s/AMB.jpg', 'image/jpeg', TS3);
    await seed('/s/AMB.png', 'image/png', TS3); // → ties AMB.jpg, so AMB.CR2 is ambiguous
    await seed('/s/NAMELESS.ARW', 'image/x-sony-arw', '2021-05-05T14:00:00');
    await seed('/s/x1.jpg', 'image/jpeg', '2021-05-05T14:00:00');

    await t.step('single RAW → its same-shot JPEG (stem + time)', async () => {
      const res = await client.execJson<SingleResult>('raw /a/IMG_1.CR2');
      assertEquals(res.raw, true);
      assertEquals(res.partners.map((p) => p.path), ['/a/IMG_1.JPG']);
      assert(res.partners[0].reasons.includes('stem'));
      assert(res.partners[0].reasons.includes('time'));
    });

    await t.step('reverse: single JPEG → its RAW', async () => {
      const res = await client.execJson<SingleResult>('raw /a/IMG_1.JPG');
      assertEquals(res.raw, false);
      assertEquals(res.partners.map((p) => p.path), ['/a/IMG_1.CR2']);
    });

    await t.step('metadata-only: paired across dirs by takenAt', async () => {
      const res = await client.execJson<SingleResult>('raw /b/rawshot.dng');
      assertEquals(res.partners.map((p) => p.path), ['/c/editedphoto.jpg']);
      assert(res.partners[0].reasons.includes('time'));
      assert(!res.partners[0].reasons.includes('stem'));
    });

    await t.step('scan: lists pairs, unmatched RAW, excludes renditions', async () => {
      const res = await client.execJson<ScanResult>('raw /a');
      assertEquals(res.pairs.map((p) => p.raw), ['/a/IMG_1.CR2']);
      assertEquals(res.pairs[0].partners.map((p) => p.path), ['/a/IMG_1.JPG']);
      assertEquals(res.unmatched, ['/a/IMG_2.NEF']);
      // rendition (sourceId set) never appears as a RAW original
      assert(!res.pairs.some((p) => p.raw === '/a/IMG_3.CR2'));
      assert(!res.unmatched.includes('/a/IMG_3.CR2'));
      assertEquals(res.count, 2);
    });

    await t.step('scan --unmatched: only the lone RAW', async () => {
      const res = await client.execJson<{ scope: string; count: number; unmatched: string[] }>('raw /a --unmatched');
      assertEquals(res.unmatched, ['/a/IMG_2.NEF']);
      assertEquals(res.count, 1);
    });

    await t.step('--sort single: RAW moved under partner versions/ as frozen sourceId', async () => {
      const res = await client.execJson<SortSingle>('raw /s1/SHOT.CR2 --sort');
      assertEquals(res.action, 'sorted');
      assertEquals(res.dest, '/s1/SHOT.JPG/versions/SHOT.CR2');
      // original path gone; version node exists frozen + sourceId → the JPEG
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s1/SHOT.CR2'), false);
      const jpg = await vfs.get(ADMIN_ACCESS, '/s1/SHOT.JPG');
      const version = await vfs.get(ADMIN_ACCESS, '/s1/SHOT.JPG/versions/SHOT.CR2');
      assertEquals((version.attrs as { sourceId?: string }).sourceId, jpg.id);
      assertEquals((version.attrs as { frozen?: boolean }).frozen, true);
    });

    await t.step('--sort on a non-RAW with no RAW of its name left: nothing to do', async () => {
      const res = await client.execJson<SortScan>('raw /s1/SHOT.JPG --sort');
      assertEquals(res.scope, '/s1/SHOT.JPG');
      assertEquals(res.count, 0);
    });

    await t.step('--sort on a non-RAW files the RAW of its name that came first', async () => {
      await client.exec('mkdir -p /late');
      await seed('/late/LATE.CR2', 'image/x-canon-cr2');
      await seed('/late/LATE.JPG', 'image/jpeg');
      const res = await client.execJson<SortScan>('raw /late/LATE.JPG --sort');
      assertEquals(res.sorted, [{ raw: '/late/LATE.CR2', dest: '/late/LATE.JPG/versions/LATE.CR2' }]);
    });

    await t.step('--sort leaves a RAW whose only partner shares its time, not its name', async () => {
      const res = await client.execJson<SortSingle>('raw /b/rawshot.dng --sort');
      assertEquals(res.action, 'left');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/b/rawshot.dng'), true);
    });

    await t.step('--sort scan: sorts clear pairs, leaves lone + ambiguous', async () => {
      const res = await client.execJson<SortScan>('raw /s --sort');
      assertEquals(res.sorted.map((s) => s.dest), ['/s/PIC_1.JPG/versions/PIC_1.CR2']);
      assertEquals(res.sorted.map((s) => s.raw), ['/s/PIC_1.CR2']);
      assertEquals(res.left, ['/s/LONE.NEF', '/s/NAMELESS.ARW']); // no partner of its name → left as is
      assertEquals(res.ambiguous, ['/s/AMB.CR2']); // two equal-scoring partners → left as is
      assertEquals(res.errors, []);
      assertEquals(res.count, 4);
      // the ambiguous + lone RAW are untouched, the paired one moved
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s/PIC_1.CR2'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s/AMB.CR2'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s/LONE.NEF'), true);
    });

    await t.step('--sort on an album files the RAWs it links to where they live; the links follow, the cover goes to the picture', async () => {
      await client.exec(`mkdir -p /staged && mkdir -p ${ALBUMS_ROOT}`);
      await seed('/staged/IMG_9.CR2', 'image/x-canon-cr2');
      await seed('/staged/IMG_9.JPG', 'image/jpeg');
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'suggested', { attrs: { name: 'Suggested' } });
      const link = (name: string, target: string) =>
        vfs.create(ADMIN_ACCESS, 'softlink', `${ALBUMS_ROOT}/suggested`, name, {
          props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: target },
        });
      await link('raw', '/staged/IMG_9.CR2');
      await link('jpg', '/staged/IMG_9.JPG');
      await link('coverPhoto', '/staged/IMG_9.CR2');

      const report = await client.execJson<ScanResult>(`raw ${ALBUMS_ROOT}/suggested`);
      assertEquals(report.pairs.map((p) => p.raw), ['/staged/IMG_9.CR2']);

      const res = await client.execJson<SortScan>(`raw ${ALBUMS_ROOT}/suggested --sort`);
      assertEquals(res.sorted, [{ raw: '/staged/IMG_9.CR2', dest: '/staged/IMG_9.JPG/versions/IMG_9.CR2' }]);
      const moved = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/suggested/raw`, { follow: false });
      assertEquals(moved.props.softlink, '/staged/IMG_9.JPG/versions/IMG_9.CR2');
      // The cover shows the picture the RAW went under, not the hidden version.
      const cover = await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/suggested/coverPhoto`, { follow: false });
      assertEquals(cover.props.softlink, '/staged/IMG_9.JPG');
      // Its RAW filed, the album has none left to offer.
      assertEquals((await client.execJson<ScanResult>(`raw ${ALBUMS_ROOT}/suggested`)).count, 0);
    });

    await t.step('--sort replaces a version of the same bytes already filed, and refuses one of other bytes', async () => {
      await client.exec('mkdir -p /again');
      await seed('/again/IMG_7713.CR2', 'image/x-canon-cr2', undefined, { sha1: 'aa' });
      await seed('/again/IMG_7713.JPG', 'image/jpeg');
      await seed('/again/IMG_7714.CR2', 'image/x-canon-cr2', undefined, { sha1: 'bb' });
      await seed('/again/IMG_7714.JPG', 'image/jpeg');
      assertEquals((await client.execJson<SortScan>('raw /again --sort')).sorted.length, 2);
      // A resumed import makes each RAW again where it first landed.
      await seed('/again/IMG_7713.CR2', 'image/x-canon-cr2', undefined, { sha1: 'aa' });
      await client.exec('echo other > /again/IMG_7714.CR2');
      await vfs.update(ADMIN_ACCESS, '/again/IMG_7714.CR2', { attrs: { size: 6, mimetype: 'image/x-canon-cr2', sha1: 'cc' } });
      const copy = await vfs.get(ADMIN_ACCESS, '/again/IMG_7713.CR2');

      const res = await client.execJson<SortScan>('raw /again --sort');
      assertEquals(res.sorted, [{ raw: '/again/IMG_7713.CR2', dest: '/again/IMG_7713.JPG/versions/IMG_7713.CR2' }]);
      assertEquals(res.errors, [{ raw: '/again/IMG_7714.CR2', error: 'already exists: /again/IMG_7714.JPG/versions/IMG_7714.CR2' }]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/again/IMG_7713.CR2'), false);
      const version = await vfs.get(ADMIN_ACCESS, '/again/IMG_7713.JPG/versions/IMG_7713.CR2');
      assertEquals(version.id, copy.id);
      assertEquals((version.attrs as { sourceId?: string }).sourceId, (await vfs.get(ADMIN_ACCESS, '/again/IMG_7713.JPG')).id);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/again/IMG_7714.CR2'), true);
    });

    await t.step("--sort deletes the RAW's regions and lets go of a person left with none", async () => {
      await client.exec('mkdir -p /faces');
      await seed('/faces/FACE.CR2', 'image/x-canon-cr2');
      await seed('/faces/FACE.JPG', 'image/jpeg');
      await vfs.update(ADMIN_ACCESS, '/faces/FACE.CR2', { attrs: { width: 1200, height: 800 } });
      const face = await client.execJson<Added>('face-add /faces/FACE.CR2 --box 0.1,0.2,0.3,0.4 --no-crop');
      assertEquals(await vfs.exists(ADMIN_ACCESS, face.personPath), true);

      const res = await client.execJson<SortSingle & { regions?: number }>('raw /faces/FACE.CR2 --sort');
      assertEquals(res.action, 'sorted');
      assertEquals(res.regions, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/faces/FACE.JPG/versions/FACE.CR2/regions'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, face.personPath), false);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});

Deno.test('media-raw triggers on every RAW mimetype core knows', async () => {
  const definition = parseYaml(await Deno.readTextFile(new URL('../../pipelines/media-raw.yaml', import.meta.url))) as {
    trigger: { match: { mimetype: string[] } };
  };
  assertEquals([...definition.trigger.match.mimetype].sort(), [...RAW_IMAGE_MIMETYPES].sort());
});
