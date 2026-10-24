/**
 * assign-faces: the incremental path — a detected face either joins the person
 * a similar face already belongs to, or becomes a new unnamed person.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Result = { facePath: string; personId: string | null; created: boolean; reason: string };
type Summary = { file: string; faces: number; attached: number; created: number; skipped: number; dryRun: boolean; results: Result[] };

const DIM = 64;
const BLOCK = 16;
/** Orthogonal directions (cosine 0) so distinct people never vote on each other. */
const dir = (group: number) => Array.from({ length: DIM }, (_, i) => (Math.floor(i / BLOCK) === group ? 1 : 0));
const near = (base: number[], seed: number) => base.map((v, i) => (v === 1 && i % BLOCK === seed % BLOCK ? v + 0.02 : v));

const ANNA = dir(0);
const BOB = dir(1);
const CARL = dir(2);

Deno.test({
  name: 'assign-faces',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const attrsOf = (path: string) => vfs.get<{ personId?: string; personSource?: string; assignLocked?: boolean }>(ADMIN_ACCESS, path).then((n) => n.attrs);
  const unknownPeople = async () => {
    try {
      return (await vfs.children(ADMIN_ACCESS, `${PEOPLE_ROOT}/unknown`)).filter((c) => c.node.type === 'person');
    } catch {
      return [];
    }
  };

  /** Dimensions matter: the size gate is in pixels while a faceBox is a fraction. */
  const makeImage = async (image: string, dims: { width: number; height: number; angle?: number } = { width: 1000, height: 1000 }) => {
    await client.exec('mkdir -p /img');
    await client.exec(`echo x > ${image}`);
    await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg', ...dims } });
    await client.exec(`mkdir -p ${image}/regions`);
    return (await vfs.get(ADMIN_ACCESS, image)).id;
  };

  /** A detection: vector, box and confidence, but no personId yet. `size` is a fraction. */
  const addFace = async (
    image: string,
    name: string,
    vector: number[],
    opts: { confidence?: number; size?: number; sizeY?: number } = {},
  ) => {
    const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
    const path = `${image}/regions/${name}`;
    const side = opts.size ?? 0.12;
    await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, name, {
      attrs: { fileId, confidence: opts.confidence ?? 0.9, detectedBy: 'insightface-buffalo_l', faceBox: { x: 0, y: 0, width: side, height: opts.sizeY ?? side } },
    });
    await vfs.create(ADMIN_ACCESS, 'embedding', path, 'embedding', { attrs: { embeddingType: 'face', capacity: DIM } });
    const h = await vfs.open(ADMIN_ACCESS, `${path}/embedding`, { mode: 'w' });
    try {
      await h.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await h.close();
    }
    return path;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}`);

    let annaId = '';

    await t.step('a face matching nobody becomes a new unnamed person', async () => {
      await makeImage('/img/1.jpg');
      await addFace('/img/1.jpg', 'face-0', near(ANNA, 0));

      const res = await client.execJson<Summary>('assign-faces /img/1.jpg');
      assertEquals(res.created, 1);
      assertEquals(res.attached, 0);

      const people = await unknownPeople();
      assertEquals(people.length, 1);
      annaId = people[0].node.id;
      assertEquals((people[0].node.attrs as { unnamed?: boolean }).unnamed, true);

      const attrs = await attrsOf('/img/1.jpg/regions/face-0');
      assertEquals(attrs.personId, annaId);
      assertEquals(attrs.personSource, 'auto');
    });

    await t.step('the same person in a later photo joins, no second person', async () => {
      // This is the whole point: recognition compounds as photos arrive.
      await makeImage('/img/2.jpg');
      await addFace('/img/2.jpg', 'face-0', near(ANNA, 3));

      const res = await client.execJson<Summary>('assign-faces /img/2.jpg');
      assertEquals(res.attached, 1);
      assertEquals(res.created, 0);
      assertEquals((await attrsOf('/img/2.jpg/regions/face-0')).personId, annaId);
      assertEquals((await unknownPeople()).length, 1);
    });

    await t.step('a different person becomes their own unnamed person', async () => {
      await makeImage('/img/3.jpg');
      await addFace('/img/3.jpg', 'face-0', near(BOB, 0));

      const res = await client.execJson<Summary>('assign-faces /img/3.jpg');
      assertEquals(res.created, 1);
      assertEquals((await unknownPeople()).length, 2);
      const bob = (await attrsOf('/img/3.jpg/regions/face-0')).personId;
      assertEquals(bob !== annaId, true, 'not confused with the first person');
    });

    await t.step('two similar faces in one photo are not the same person', async () => {
      // Look-alikes in a single frame: whoever they are, they are two people.
      await makeImage('/img/4.jpg');
      await addFace('/img/4.jpg', 'face-0', near(CARL, 0));
      await addFace('/img/4.jpg', 'face-1', near(CARL, 1));

      const res = await client.execJson<Summary>('assign-faces /img/4.jpg');
      assertEquals(res.faces, 2);
      const a = (await attrsOf('/img/4.jpg/regions/face-0')).personId;
      const b = (await attrsOf('/img/4.jpg/regions/face-1')).personId;
      assertEquals(typeof a, 'string');
      assertEquals(typeof b, 'string');
      assertEquals(a === b, false, 'the two faces got different people');
    });

    await t.step('re-running is a no-op', async () => {
      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-faces /img/1.jpg');
      assertEquals(res.faces, 0, 'nothing left to decide');
      assertEquals(res.created, 0);
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('--no-create attaches but never mints', async () => {
      await makeImage('/img/5.jpg');
      await addFace('/img/5.jpg', 'face-0', dir(3));

      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-faces /img/5.jpg --no-create');
      assertEquals(res.created, 0);
      assertEquals(res.results[0].reason, 'skipped-no-match');
      assertEquals((await attrsOf('/img/5.jpg/regions/face-0')).personId ?? null, null);
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('--dry-run decides without writing', async () => {
      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-faces /img/5.jpg --dry-run');
      assertEquals(res.created, 1);
      assertEquals((await attrsOf('/img/5.jpg/regions/face-0')).personId ?? null, null);
      assertEquals((await unknownPeople()).length, before);
    });

    await t.step('a locked face is left alone', async () => {
      // A human removed a wrong person from this face; automation must not undo that.
      await makeImage('/img/6.jpg');
      const path = await addFace('/img/6.jpg', 'face-0', near(ANNA, 5));
      await vfs.update(ADMIN_ACCESS, path, { attrs: { assignLocked: true } });

      const res = await client.execJson<Summary>('assign-faces /img/6.jpg');
      assertEquals(res.results[0].reason, 'skipped-locked');
      assertEquals((await attrsOf(path)).personId ?? null, null);
    });

    await t.step('a small low-confidence face may attach but never seeds a person', async () => {
      await makeImage('/img/7.jpg');
      // A background face in a crowd: too small and uncertain to be an identity.
      await addFace('/img/7.jpg', 'face-0', dir(3), { confidence: 0.55, size: 0.02 });

      const before = (await unknownPeople()).length;
      const res = await client.execJson<Summary>('assign-faces /img/7.jpg');
      assertEquals(res.created, 0);
      assertEquals(res.results[0].reason, 'skipped-gate');
      assertEquals((await unknownPeople()).length, before);

      // ...but the same face still joins someone it clearly matches.
      await makeImage('/img/8.jpg');
      await addFace('/img/8.jpg', 'face-0', near(ANNA, 6), { confidence: 0.55, size: 0.02 });
      const res2 = await client.execJson<Summary>('assign-faces /img/8.jpg');
      assertEquals(res2.attached, 1);
      assertEquals((await attrsOf('/img/8.jpg/regions/face-0')).personId, annaId);
    });

    await t.step('the size gate reads the box against the rotated frame', async () => {
      // faceBox is a fraction of the *display* frame, so a rotated image resolves it against
      // the swapped axes: on a 1000x500 raw raster this box would be 90x100 px, but upright
      // (500x1000) it is 45x200 — a shortest side below minCreateSize (48).
      await makeImage('/img/10.jpg', { width: 1000, height: 500, angle: 90 });
      await addFace('/img/10.jpg', 'face-0', dir(7), { confidence: 0.95, size: 0.09, sizeY: 0.2 });

      const res = await client.execJson<Summary>('assign-faces /img/10.jpg');
      assertEquals(res.created, 0);
      assertEquals(res.results[0].reason, 'skipped-gate');
    });

    await t.step('a legacy box-only tag is skipped, having no vector to search with', async () => {
      await makeImage('/img/9.jpg');
      await vfs.create(ADMIN_ACCESS, 'media-region', '/img/9.jpg/regions', 'manual-0', {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: { detectedBy: 'legacy-manual', confidence: 1, personId: null },
      });

      const res = await client.execJson<Summary>('assign-faces /img/9.jpg');
      assertEquals(res.faces, 0);
      assertEquals(res.created, 0);
    });

    await t.step('an image with no regions directory is not an error', async () => {
      await client.exec('mkdir -p /img');
      await client.exec('echo x > /img/plain.jpg');
      const res = await client.execJson<Summary>('assign-faces /img/plain.jpg');
      assertEquals(res.faces, 0);
    });

    await t.step('person-detach --rematch places a face again, never back on the person it left', async () => {
      // Two more photos of whoever /img/1 seeded, then a Bob face in a known person of its own.
      await makeImage('/img/rm-1.jpg');
      const annaFace = await addFace('/img/rm-1.jpg', 'face-0', near(ANNA, 5));
      await client.execJson<Summary>('assign-faces /img/rm-1.jpg');
      assertEquals((await attrsOf(annaFace)).personId, annaId);

      // Anna's votes are the only ones near this face, so with Anna ruled out nobody
      // matches: it seeds a new unnamed person rather than going back.
      const res = await client.execJson<{ ok: boolean; rematched: { facePath: string; person: { id: string; unnamed: boolean } | null }[] }>(
        `person-detach --rematch ${annaFace}`,
      );
      assertEquals(res.ok, true);
      const landed = res.rematched[0].person;
      assertEquals(landed !== null && landed.id !== annaId, true);
      assertEquals(landed?.unnamed, true);
      const attrs = await vfs.get<{ personId?: string; rejectedPersonIds?: string[]; personSource?: string }>(ADMIN_ACCESS, annaFace).then((n) => n.attrs);
      assertEquals(attrs.personId, landed?.id);
      assertEquals(attrs.rejectedPersonIds, [annaId]);
      assertEquals(attrs.personSource, 'auto');
    });

    await t.step('a rematched face joins another known person when it looks like them', async () => {
      await makeImage('/img/rm-bob.jpg');
      const bobSeed = await addFace('/img/rm-bob.jpg', 'face-0', near(BOB, 1));
      await client.execJson<Summary>('assign-faces /img/rm-bob.jpg');
      const bobId = (await attrsOf(bobSeed)).personId!;

      // A Bob face wrongly put on Anna by hand.
      await makeImage('/img/rm-wrong.jpg');
      const wrong = await addFace('/img/rm-wrong.jpg', 'face-0', near(BOB, 7));
      await vfs.update(ADMIN_ACCESS, wrong, { attrs: { personId: annaId, personSource: 'manual' } });

      await client.execJson(`person-detach --rematch ${wrong}`);
      assertEquals((await attrsOf(wrong)).personId, bobId);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
