/**
 * raw: RAW detection and RAW↔non-RAW pairing by metadata (capture timestamp,
 * camera) and filename stem. Report-only.
 */

import { assert, assertEquals } from '@std/assert';
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
    // /s: a clean pair, a lone RAW, and an ambiguous RAW (two equal-scoring JPEGs)
    await seed('/s/PIC_1.CR2', 'image/x-canon-cr2', TS1);
    await seed('/s/PIC_1.JPG', 'image/jpeg', TS1);
    await seed('/s/LONE.NEF', 'image/x-nikon-nef', TS2);
    await seed('/s/AMB.CR2', 'image/x-canon-cr2', TS3);
    await seed('/s/x1.jpg', 'image/jpeg', TS3); // same dir + takenAt as AMB, no stem match
    await seed('/s/x2.jpg', 'image/jpeg', TS3); // → ties x1, so AMB is ambiguous

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

    await t.step('--sort single on non-RAW: nothing to do', async () => {
      const res = await client.execJson<SortSingle>('raw /s1/SHOT.JPG --sort');
      assertEquals(res.action, 'skip');
      assertEquals(res.raw, false);
    });

    await t.step('--sort scan: sorts clear pairs, leaves lone + ambiguous', async () => {
      const res = await client.execJson<SortScan>('raw /s --sort');
      assertEquals(res.sorted.map((s) => s.dest), ['/s/PIC_1.JPG/versions/PIC_1.CR2']);
      assertEquals(res.sorted.map((s) => s.raw), ['/s/PIC_1.CR2']);
      assertEquals(res.left, ['/s/LONE.NEF']); // no partner → left as is
      assertEquals(res.ambiguous, ['/s/AMB.CR2']); // two equal-scoring JPEGs → left as is
      assertEquals(res.errors, []);
      assertEquals(res.count, 3);
      // the ambiguous + lone RAW are untouched, the paired one moved
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s/PIC_1.CR2'), false);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s/AMB.CR2'), true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/s/LONE.NEF'), true);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
