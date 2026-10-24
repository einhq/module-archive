/**
 * `regions/` has two authors and only one of them is reproducible; a face is a region with an
 * `embedding` child. Fast tier — an in-memory VFS, no harness, no models.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestVfs } from '@ein/testing';
import type { NodeVFS } from '@ein/testing';
import { allRegions, faceEmbeddingsOfRegions, imageOfRegion, MANUAL_DETECTOR, nextManualName, regionsOfEmbeddings, removeDetectedRegions } from '../../lib/media/regions.ts';

const OWNER = { uid: 1000, gid: 1000, mode: 0o644 };

const seedImage = async (vfs: NodeVFS, path = '/img.jpg') => {
  await vfs.create(ADMIN_ACCESS, 'file', '/', path.slice(1), { props: OWNER, attrs: { mimetype: 'image/jpeg', width: 800, height: 600 } });
  await vfs.create(ADMIN_ACCESS, 'directory', path, 'regions', { props: { ...OWNER, mode: 0o775 } });
  return path;
};

/** A region; `face` gives it an embedding child. */
const seedRegion = async (vfs: NodeVFS, image: string, name: string, detectedBy: string, opts: { face?: boolean; attrs?: Record<string, unknown> } = {}) => {
  const region = await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, name, { props: OWNER, attrs: { detectedBy, ...opts.attrs } });
  const embedding = opts.face
    ? await vfs.create(ADMIN_ACCESS, 'embedding', `${image}/regions/${name}`, 'embedding', { props: OWNER, attrs: { embeddingType: 'face', capacity: 512 } })
    : undefined;
  return { region, embedding };
};

Deno.test('removeDetectedRegions drops detections and spares tags', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    const image = await seedImage(vfs);
    await seedRegion(vfs, image, 'face-0', 'insightface-buffalo_l', { face: true });
    // A detection that lost its vector is still a detection.
    await seedRegion(vfs, image, 'face-1', 'insightface-buffalo_l');
    await seedRegion(vfs, image, 'manual-0', MANUAL_DETECTOR);

    assertEquals(await removeDetectedRegions(vfs, ADMIN_ACCESS, image), { removed: 2, reopened: 0 });

    const left = (await vfs.children(ADMIN_ACCESS, `${image}/regions`)).map((c) => c.name);
    assertEquals(left, ['manual-0'], 'the hand-drawn tag survives a re-detect');
  } finally {
    await dispose();
  }
});

Deno.test('removeDetectedRegions takes the embedding and the crop with it', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    const image = await seedImage(vfs);
    await seedRegion(vfs, image, 'face-0', 'insightface-buffalo_l', { face: true });
    await vfs.create(ADMIN_ACCESS, 'file', `${image}/regions/face-0`, 'image.avif', { props: OWNER, attrs: { mimetype: 'image/avif' } });

    assertEquals(await removeDetectedRegions(vfs, ADMIN_ACCESS, image), { removed: 1, reopened: 0 });
    assertEquals(await vfs.exists(ADMIN_ACCESS, `${image}/regions/face-0`), false);
  } finally {
    await dispose();
  }
});

Deno.test('removeDetectedRegions is a no-op on an image never detected', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    await vfs.create(ADMIN_ACCESS, 'file', '/', 'bare.jpg', { props: OWNER, attrs: { mimetype: 'image/jpeg' } });
    assertEquals(await removeDetectedRegions(vfs, ADMIN_ACCESS, '/bare.jpg'), { removed: 0, reopened: 0 });
  } finally {
    await dispose();
  }
});

Deno.test('removeDetectedRegions reopens a tag whose transfer target it deletes, by region or embedding id', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    const image = await seedImage(vfs);
    const first = await seedRegion(vfs, image, 'face-0', 'insightface-buffalo_l', { face: true });
    const second = await seedRegion(vfs, image, 'face-1', 'insightface-buffalo_l', { face: true });
    await seedRegion(vfs, image, 'manual-0', MANUAL_DETECTOR, { attrs: { transferredTo: first.region.id } });
    // A marker may name the face node, which is now the embedding.
    await seedRegion(vfs, image, 'manual-1', MANUAL_DETECTOR, { attrs: { transferredTo: second.embedding!.id } });

    // Without this the tag keeps pointing at a deleted node: tag-transfer reads
    // it as a finished transfer and deletes it.
    assertEquals(await removeDetectedRegions(vfs, ADMIN_ACCESS, image), { removed: 2, reopened: 2 });

    for (const name of ['manual-0', 'manual-1']) {
      const tag = await vfs.get<{ transferredTo?: string }>(ADMIN_ACCESS, `${image}/regions/${name}`);
      assertEquals(tag.attrs.transferredTo, undefined, 'the marker is removed, not blanked');
    }
  } finally {
    await dispose();
  }
});

Deno.test('removeDetectedRegions leaves a marker naming a region it did not delete', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    const image = await seedImage(vfs);
    await seedRegion(vfs, image, 'face-0', 'insightface-buffalo_l', { face: true });
    await seedRegion(vfs, image, 'manual-0', MANUAL_DETECTOR, { attrs: { transferredTo: 'a-region-in-another-image' } });

    assertEquals(await removeDetectedRegions(vfs, ADMIN_ACCESS, image), { removed: 1, reopened: 0 });

    const tag = await vfs.get<{ transferredTo?: string }>(ADMIN_ACCESS, `${image}/regions/manual-0`);
    assertEquals(tag.attrs.transferredTo, 'a-region-in-another-image');
  } finally {
    await dispose();
  }
});

Deno.test('a face maps to its region and back; a tag has no embedding', async () => {
  const { vfs, dispose } = await createTestVfs();
  try {
    const image = await seedImage(vfs);
    const face = await seedRegion(vfs, image, 'face-0', 'insightface-buffalo_l', { face: true, attrs: { personId: 'p1' } });
    const tag = await seedRegion(vfs, image, 'manual-0', MANUAL_DETECTOR, { attrs: { personId: 'p2' } });

    assertEquals(await regionsOfEmbeddings(vfs, ADMIN_ACCESS, [face.embedding!.id]), new Map([[face.embedding!.id, face.region.id]]));
    assertEquals(await faceEmbeddingsOfRegions(vfs, ADMIN_ACCESS, [face.region.id, tag.region.id]), new Map([[face.region.id, face.embedding!.id]]));

    const { faces, tags } = await allRegions(vfs, ADMIN_ACCESS);
    assertEquals(faces.map((f) => [f.regionPath, f.embeddingId, f.attrs.personId]), [[`${image}/regions/face-0`, face.embedding!.id, 'p1']]);
    assertEquals(tags.map((t) => [t.regionPath, t.attrs.personId]), [[`${image}/regions/manual-0`, 'p2']]);
  } finally {
    await dispose();
  }
});

Deno.test('region path helpers', () => {
  assertEquals(imageOfRegion('/a/b.jpg/regions/face-0'), '/a/b.jpg');
  assertEquals(imageOfRegion('/a/b.jpg/regions/face-0/embedding'), undefined);
  assertEquals(nextManualName(['face-0', 'manual-0', 'manual-3']), 'manual-4');
  assertEquals(nextManualName([]), 'manual-0');
});
