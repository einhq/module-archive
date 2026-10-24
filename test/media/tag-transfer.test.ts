/**
 * tag-transfer: moving a legacy manual face tag's personId onto the
 * auto-detected face in the same image, so recognition gains an anchor.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Box = { x: number; y: number; width: number; height: number };

type Summary = {
  faces: number;
  images: number;
  transferred: number;
  unmatched: number;
  ambiguous: { none: number; multiAuto: number; multiManual: number; tooSmall: number };
  conflicts: number;
  cropped: number;
  pruned: number;
  failed: number;
  stranded: number;
  byAngle: Record<string, { files: number; manual: number; matched: number; rate: number }>;
  dryRun: boolean;
};

type FaceAttrs = { personId?: string | null; personSource?: string; transferredTo?: string };

Deno.test({
  name: 'tag-transfer',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const attrsOf = (path: string) => vfs.get<FaceAttrs>(ADMIN_ACCESS, path).then((n) => n.attrs);

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}`);
    const personId = async (slug: string) => {
      const node = await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, {
        props: { uid: 1000, gid: 1000, mode: 0o775 },
        attrs: { name: slug },
      });
      return node.id;
    };
    const anna = await personId('anna');
    const bob = await personId('bob');

    const seedImage = async (path: string, angle = 0) => {
      await client.exec('mkdir -p /img');
      await client.exec(`echo x > ${path}`);
      await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', width: 800, height: 600, angle } });
      await client.exec(`mkdir -p ${path}/regions`);
      return (await vfs.get(ADMIN_ACCESS, path)).id;
    };

    /** A legacy tag: a region with a personId and a loose hand-drawn box, no embedding. */
    const seedManual = (image: string, fileId: string, name: string, faceBox: Box, pid: string) =>
      vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, name, {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: {
          fileId,
          faceBox,
          personId: pid,
          confidence: 1,
          detectedBy: 'legacy-manual',
        },
      });

    /** A detection: a region with a tight box and an embedding, but nobody knows who it is. */
    const seedAuto = async (image: string, fileId: string, name: string, faceBox: Box) => {
      const region = await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, name, {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: { fileId, faceBox, personId: null, confidence: 0.9, detectedBy: 'insightface-buffalo_l' },
      });
      await vfs.create(ADMIN_ACCESS, 'embedding', `${image}/regions/${name}`, 'embedding', {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: { embeddingType: 'face', capacity: 512 },
      });
      return region;
    };

    // /img/a.jpg — one loose tag around a head, one tight detection inside it.
    const aId = await seedImage('/img/a.jpg');
    await seedManual('/img/a.jpg', aId, 'manual-0', { x: 100, y: 100, width: 200, height: 200 }, anna);
    await seedAuto('/img/a.jpg', aId, 'face-0', { x: 140, y: 140, width: 110, height: 110 });

    await t.step('dry run reports the match without writing', async () => {
      const res = await client.execJson<Summary>('tag-transfer --dry-run');
      assertEquals(res.transferred, 1);
      assertEquals(res.dryRun, true);
      assertEquals((await attrsOf('/img/a.jpg/regions/face-0')).personId ?? null, null);
      assertEquals((await attrsOf('/img/a.jpg/regions/manual-0')).transferredTo, undefined);
    });

    await t.step('transfers the personId onto the detected face and deletes the tag', async () => {
      const res = await client.execJson<Summary>('tag-transfer');
      assertEquals(res.transferred, 1);
      assertEquals(res.pruned, 1);
      assertEquals(res.failed, 0);

      const face = await attrsOf('/img/a.jpg/regions/face-0');
      assertEquals(face.personId, anna);
      // Provenance is what makes the run undoable without touching legacy tags.
      assertEquals(face.personSource, 'transfer');

      // The identity lives on the detection now; a second box over the same
      // face would only be a duplicate in the lightbox.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/a.jpg/regions/manual-0'), false);
    });

    await t.step('re-running is a no-op', async () => {
      const res = await client.execJson<Summary>('tag-transfer');
      assertEquals(res.transferred, 0);
      assertEquals(res.pruned, 0);
      assertEquals((await attrsOf('/img/a.jpg/regions/face-0')).personId, anna);
    });

    await t.step('a detection far from every tag is left alone', async () => {
      const bId = await seedImage('/img/b.jpg');
      await seedManual('/img/b.jpg', bId, 'manual-0', { x: 0, y: 0, width: 100, height: 100 }, bob);
      await seedAuto('/img/b.jpg', bId, 'face-0', { x: 600, y: 400, width: 90, height: 90 });

      const res = await client.execJson<Summary>('tag-transfer');
      assertEquals(res.transferred, 0);
      assertEquals(res.unmatched, 1);
      assertEquals((await attrsOf('/img/b.jpg/regions/face-0')).personId ?? null, null);
    });

    await t.step('two tags in one image take one detection each', async () => {
      const cId = await seedImage('/img/c.jpg');
      await seedManual('/img/c.jpg', cId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedManual('/img/c.jpg', cId, 'manual-1', { x: 300, y: 0, width: 120, height: 120 }, bob);
      await seedAuto('/img/c.jpg', cId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      await seedAuto('/img/c.jpg', cId, 'face-1', { x: 320, y: 20, width: 80, height: 80 });

      const res = await client.execJson<Summary>('tag-transfer');
      assertEquals(res.transferred, 2);
      assertEquals((await attrsOf('/img/c.jpg/regions/face-0')).personId, anna);
      assertEquals((await attrsOf('/img/c.jpg/regions/face-1')).personId, bob);
    });

    await t.step('a detection that already has a person is never overwritten', async () => {
      const dId = await seedImage('/img/d.jpg');
      await seedManual('/img/d.jpg', dId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      const face = await seedAuto('/img/d.jpg', dId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      await vfs.update(ADMIN_ACCESS, `/img/d.jpg/regions/face-0`, { attrs: { personId: bob, personSource: 'manual' } });
      assertEquals(face.type, 'media-region');

      const res = await client.execJson<Summary>('tag-transfer');
      assertEquals(res.transferred, 0);
      assertEquals(res.conflicts, 1);
      assertEquals((await attrsOf('/img/d.jpg/regions/face-0')).personId, bob);
      // The tag lost the argument, so it stays for a human to look at.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/d.jpg/regions/manual-0'), true);
    });

    await t.step('a tag whose detection already is that person is a duplicate box, and pruned', async () => {
      // A tag over a face already settled on the same name.
      const nId = await seedImage('/img/n.jpg');
      await seedManual('/img/n.jpg', nId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedAuto('/img/n.jpg', nId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      await vfs.update(ADMIN_ACCESS, '/img/n.jpg/regions/face-0', { attrs: { personId: anna, personSource: 'transfer' } });

      const res = await client.execJson<Summary>('tag-transfer --file /img/n.jpg');
      assertEquals(res.transferred, 0);
      assertEquals(res.conflicts, 0);
      assertEquals(res.pruned, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/n.jpg/regions/manual-0'), false);
      assertEquals((await attrsOf('/img/n.jpg/regions/face-0')).personSource, 'transfer');
    });

    await t.step('one person cannot land on two faces of the same image', async () => {
      const eId = await seedImage('/img/e.jpg');
      // Two tags naming the same person (a legacy duplicate) over two detections.
      await seedManual('/img/e.jpg', eId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedManual('/img/e.jpg', eId, 'manual-1', { x: 300, y: 0, width: 120, height: 120 }, anna);
      await seedAuto('/img/e.jpg', eId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      await seedAuto('/img/e.jpg', eId, 'face-1', { x: 320, y: 20, width: 80, height: 80 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/e.jpg');
      assertEquals(res.transferred, 1);
      assertEquals(res.conflicts, 1);
      const ids = [
        (await attrsOf('/img/e.jpg/regions/face-0')).personId ?? null,
        (await attrsOf('/img/e.jpg/regions/face-1')).personId ?? null,
      ];
      assertEquals(ids.filter((i) => i === anna).length, 1, 'exactly one face gets her');
    });

    await t.step('--file restricts the run to one image', async () => {
      const fId = await seedImage('/img/f.jpg');
      const gId = await seedImage('/img/g.jpg');
      for (const [img, id] of [['/img/f.jpg', fId], ['/img/g.jpg', gId]] as const) {
        await seedManual(img, id, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
        await seedAuto(img, id, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      }

      const res = await client.execJson<Summary>('tag-transfer --file /img/f.jpg');
      assertEquals(res.transferred, 1);
      assertEquals((await attrsOf('/img/f.jpg/regions/face-0')).personId, anna);
      assertEquals((await attrsOf('/img/g.jpg/regions/face-0')).personId ?? null, null);
    });

    await t.step('the angle histogram splits the match rate by image rotation', async () => {
      // A systematic frame error in the legacy boxes would only show on rotated
      // images, so the rate has to be readable per angle before a bulk run.
      const rId = await seedImage('/img/r.jpg', 90);
      await seedManual('/img/r.jpg', rId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedAuto('/img/r.jpg', rId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });

      const res = await client.execJson<Summary>('tag-transfer --dry-run');
      assertEquals(res.byAngle['90'].manual, 1);
      assertEquals(res.byAngle['90'].matched, 1);
      assertEquals(res.byAngle['90'].rate, 1);
    });

    await t.step('a machine guess is overridden, a human decision is not', async () => {
      // assign-faces runs off the face node's creation, so a detection routinely
      // already carries a minted personId by the time this command sees it.
      // Skipping those would leave the transfer permanently losing that race.
      const hId = await seedImage('/img/h.jpg');
      await seedManual('/img/h.jpg', hId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedAuto('/img/h.jpg', hId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      await vfs.update(ADMIN_ACCESS, '/img/h.jpg/regions/face-0', { attrs: { personId: bob, personSource: 'auto' } });

      const res = await client.execJson<Summary>('tag-transfer --file /img/h.jpg');
      assertEquals(res.transferred, 1);
      const face = await attrsOf('/img/h.jpg/regions/face-0');
      assertEquals(face.personId, anna, 'the named tag outranks the kNN guess');
      assertEquals(face.personSource, 'transfer');
    });

    await t.step('a face in the background loses to the larger one in front', async () => {
      const oId = await seedImage('/img/o.jpg');
      await seedManual('/img/o.jpg', oId, 'manual-0', { x: 0, y: 0, width: 300, height: 150 }, anna);
      await seedAuto('/img/o.jpg', oId, 'face-0', { x: 250, y: 10, width: 30, height: 30 });
      await seedAuto('/img/o.jpg', oId, 'face-1', { x: 60, y: 20, width: 100, height: 100 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/o.jpg');
      assertEquals(res.transferred, 1);
      assertEquals((await attrsOf('/img/o.jpg/regions/face-1')).personId, anna);
      assertEquals((await attrsOf('/img/o.jpg/regions/face-0')).personId ?? null, null);
    });

    await t.step('a detection with a corner outside the tag is ignored', async () => {
      // The neighbour's face brushing the edge overlaps more than the small one
      // inside; it is not a candidate at all. `--margin` admits it.
      const pId = await seedImage('/img/p.jpg');
      await seedManual('/img/p.jpg', pId, 'manual-0', { x: 0, y: 0, width: 200, height: 200 }, anna);
      await seedAuto('/img/p.jpg', pId, 'face-0', { x: 120, y: 40, width: 100, height: 100 });

      const strict = await client.execJson<Summary>('tag-transfer --file /img/p.jpg');
      assertEquals(strict.transferred, 0);
      assertEquals(strict.unmatched, 1);
      assertEquals((await attrsOf('/img/p.jpg/regions/face-0')).personId ?? null, null);

      const loose = await client.execJson<Summary>('tag-transfer --file /img/p.jpg --margin 0.1');
      assertEquals(loose.transferred, 1);
      assertEquals((await attrsOf('/img/p.jpg/regions/face-0')).personId, anna);
    });

    await t.step('two equally large detections in one loose tag leave it for a human', async () => {
      const iId = await seedImage('/img/i.jpg');
      await seedManual('/img/i.jpg', iId, 'manual-0', { x: 0, y: 0, width: 300, height: 150 }, anna);
      await seedAuto('/img/i.jpg', iId, 'face-0', { x: 10, y: 10, width: 90, height: 90 });
      await seedAuto('/img/i.jpg', iId, 'face-1', { x: 180, y: 10, width: 90, height: 90 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/i.jpg');
      assertEquals(res.transferred, 0);
      assertEquals(res.ambiguous.multiAuto, 1);
      assertEquals((await attrsOf('/img/i.jpg/regions/manual-0')).transferredTo, undefined);
      assertEquals((await attrsOf('/img/i.jpg/regions/face-0')).personId ?? null, null);

      // The tag stays, so it needs somewhere for a thumbnail to land — that is
      // the whole point of keeping it. Encoding needs ImageMagick, which the
      // fast tier does not have; the node is the part checkable here.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/i.jpg/regions/manual-0/image.avif'), true);
    });

    await t.step('--no-crop leaves the surviving tag without one', async () => {
      const jId = await seedImage('/img/j.jpg');
      await seedManual('/img/j.jpg', jId, 'manual-0', { x: 0, y: 0, width: 100, height: 100 }, anna);

      await client.execJson<Summary>('tag-transfer --file /img/j.jpg --no-crop');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/j.jpg/regions/manual-0/image.avif'), false);
    });

    await t.step('a tag a previous run marked but did not delete is finished', async () => {
      // The run died between writing the marker and unlinking the tag. The
      // marker names a live face, so the transfer happened; only the delete is
      // owed, and the tag must not be transferred a second time.
      const kId = await seedImage('/img/k.jpg');
      await seedManual('/img/k.jpg', kId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedManual('/img/k.jpg', kId, 'manual-1', { x: 600, y: 400, width: 120, height: 120 }, bob);
      const face = await seedAuto('/img/k.jpg', kId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });
      await vfs.update(ADMIN_ACCESS, '/img/k.jpg/regions/face-0', { attrs: { personId: anna, personSource: 'transfer' } });
      await vfs.update(ADMIN_ACCESS, '/img/k.jpg/regions/manual-0', { attrs: { transferredTo: face.id } });

      const res = await client.execJson<Summary>('tag-transfer --file /img/k.jpg');
      assertEquals(res.transferred, 0);
      assertEquals(res.pruned, 1);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/k.jpg/regions/manual-0'), false, 'transferred tag is gone');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/k.jpg/regions/manual-1'), true, 'the unmatched tag stays');
      // The identity survives on the detection, which is the point of the move.
      assertEquals((await attrsOf('/img/k.jpg/regions/face-0')).personId, anna);
    });

    await t.step('a dry run deletes nothing', async () => {
      const qId = await seedImage('/img/q.jpg');
      await seedManual('/img/q.jpg', qId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await seedAuto('/img/q.jpg', qId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/q.jpg --dry-run');
      assertEquals(res.transferred, 1);
      assertEquals(res.pruned, 1, 'reported as what the real run would delete');
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/q.jpg/regions/manual-0'), true);
      assertEquals((await attrsOf('/img/q.jpg/regions/face-0')).personId ?? null, null);
    });
    await t.step('a tag whose transfer target is gone is reopened, not skipped', async () => {
      // A marker naming a deleted detection. The tag is not handled —
      // its identity points at nothing — so the run has to reconsider it.
      const lId = await seedImage('/img/l.jpg');
      await seedManual('/img/l.jpg', lId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await vfs.update(ADMIN_ACCESS, '/img/l.jpg/regions/manual-0', { attrs: { transferredTo: 'a-deleted-face' } });
      await seedAuto('/img/l.jpg', lId, 'face-0', { x: 20, y: 20, width: 80, height: 80 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/l.jpg');
      assertEquals(res.stranded, 1);
      assertEquals(res.transferred, 1);
      assertEquals(res.pruned, 1);
      assertEquals((await attrsOf('/img/l.jpg/regions/face-0')).personId, anna);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/l.jpg/regions/manual-0'), false);
    });

    await t.step('a tag whose transfer target is gone is never deleted', async () => {
      // The dangerous half: a stale marker read as a finished transfer would
      // destroy a hand-drawn box whose identity went nowhere, and nothing can
      // redraw it. Here nothing matches, so the marker is cleared instead.
      const mId = await seedImage('/img/m.jpg');
      await seedManual('/img/m.jpg', mId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await vfs.update(ADMIN_ACCESS, '/img/m.jpg/regions/manual-0', { attrs: { transferredTo: 'a-deleted-face' } });
      await seedAuto('/img/m.jpg', mId, 'face-0', { x: 600, y: 400, width: 90, height: 90 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/m.jpg');
      assertEquals(res.pruned, 0);
      assertEquals(res.transferred, 0);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/m.jpg/regions/manual-0'), true);
      assertEquals(
        (await attrsOf('/img/m.jpg/regions/manual-0')).transferredTo,
        undefined,
        'the stale marker is cleared so the state converges',
      );
    });

    await t.step('a back-of-head tag with a stranger behind is left for a human', async () => {
      const sId = await seedImage('/img/s.jpg');
      await seedManual('/img/s.jpg', sId, 'manual-0', { x: 0, y: 0, width: 300, height: 300 }, anna);
      await seedAuto('/img/s.jpg', sId, 'face-0', { x: 250, y: 10, width: 30, height: 30 });

      const res = await client.execJson<Summary>('tag-transfer --file /img/s.jpg');
      assertEquals(res.transferred, 0);
      assertEquals(res.ambiguous.tooSmall, 1);
      assertEquals((await attrsOf('/img/s.jpg/regions/face-0')).personId ?? null, null);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/s.jpg/regions/manual-0'), true);
    });

    await t.step('a detection without a vector is never an anchor', async () => {
      // A face the quality gate turned into a tag is still a `face-<n>` region, but it cannot
      // anchor recognition, so the legacy tag waits rather than handing its name to it.
      const vId = await seedImage('/img/v.jpg');
      await seedManual('/img/v.jpg', vId, 'manual-0', { x: 0, y: 0, width: 120, height: 120 }, anna);
      await vfs.create(ADMIN_ACCESS, 'media-region', '/img/v.jpg/regions', 'face-0', {
        attrs: { fileId: vId, faceBox: { x: 20, y: 20, width: 80, height: 80 }, confidence: 0.55, detectedBy: 'insightface-buffalo_l' },
      });

      const res = await client.execJson<Summary>('tag-transfer --file /img/v.jpg');
      assertEquals(res.transferred, 0);
      assertEquals(res.ambiguous.none, 1);
      assertEquals((await attrsOf('/img/v.jpg/regions/face-0')).personId ?? null, null);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
