/**
 * cluster-faces --create-people: minting an unnamed person per leftover
 * cluster of untagged faces, and the fences that keep a chained component from
 * becoming one un-splittable person.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Summary = {
  faces: number;
  tagged: number;
  untagged: number;
  recognized: number;
  written: number;
  suggestionClusters: number;
  clusterSizes: Record<string, number>;
  largestCluster: number;
  oversized: number;
  created: number;
  clusterTagged: number;
  sameFileSkipped: number;
  dryRun: boolean;
};

const DIM = 64;
const GROUPS = 4;
const BLOCK = DIM / GROUPS;

/**
 * One direction per group, each occupying its own block of coordinates, so any
 * two groups are exactly orthogonal (cosine 0). Overlapping directions would
 * let one group vote on another's faces and quietly absorb them.
 */
const dir = (group: number) => Array.from({ length: DIM }, (_, i) => (Math.floor(i / BLOCK) === group ? 1 : 0));
const DIR_A = dir(0);
const DIR_B = dir(1);
const DIR_C = dir(2);
const DIR_D = dir(3);

/** Nudge one in-block coordinate so group members are near-identical but distinct. */
const near = (base: number[], seed: number) => base.map((v, i) => (v === 1 && i % BLOCK === seed % BLOCK ? v + 0.02 : v));

Deno.test({
  name: 'cluster-faces --create-people',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const attrsOf = (path: string) => vfs.get<{ personId?: string; personSource?: string }>(ADMIN_ACCESS, path).then((n) => n.attrs);
  const unknownPeople = async () => {
    try {
      return (await vfs.children(ADMIN_ACCESS, `${PEOPLE_ROOT}/unknown`)).filter((c) => c.node.type === 'person');
    } catch {
      return [];
    }
  };

  /** One image holding one detected face with a vector and no personId. */
  const seedFace = async (name: string, vector: number[], opts: { fileId?: string; image?: string } = {}) => {
    const image = opts.image ?? `/img/${name}.jpg`;
    await client.exec('mkdir -p /img');
    if (!opts.image) {
      await client.exec(`echo x > ${image}`);
      await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg' } });
      await client.exec(`mkdir -p ${image}/regions`);
    }
    const fileId = opts.fileId ?? (await vfs.get(ADMIN_ACCESS, image)).id;
    const path = `${image}/regions/${name}`;
    await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, name, { attrs: { fileId, confidence: 0.9, detectedBy: 'insightface-buffalo_l' } });
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

    // Three faces of one stranger, and two of another (below --min-cluster 3).
    const aPaths: string[] = [];
    for (let i = 0; i < 3; i++) aPaths.push(await seedFace(`a${i}`, near(DIR_A, i)));
    for (let i = 0; i < 2; i++) await seedFace(`b${i}`, near(DIR_B, i));

    await t.step('without --create-people nothing is created', async () => {
      const res = await client.execJson<Summary>('cluster-faces');
      assertEquals(res.created, 0);
      assertEquals(await unknownPeople(), []);
      // The 3-face group is reported as a candidate; the 2-face one is under the bar.
      assertEquals(res.suggestionClusters, 1);
    });

    await t.step('--dry-run reports the person it would create without writing', async () => {
      const res = await client.execJson<Summary>('cluster-faces --create-people --dry-run');
      assertEquals(res.created, 1);
      assertEquals(res.dryRun, true);
      assertEquals(await unknownPeople(), []);
      assertEquals((await attrsOf(aPaths[0])).personId ?? null, null);
    });

    let personId = '';
    await t.step('creates one unnamed person for the cluster', async () => {
      const res = await client.execJson<Summary>('cluster-faces --create-people');
      assertEquals(res.created, 1);
      assertEquals(res.clusterTagged, 3);

      const people = await unknownPeople();
      assertEquals(people.length, 1);
      personId = people[0].node.id;
      assertEquals((people[0].node.attrs as { unnamed?: boolean }).unnamed, true);

      for (const p of aPaths) {
        const attrs = await attrsOf(p);
        assertEquals(attrs.personId, personId, `${p} joined the new person`);
        assertEquals(attrs.personSource, 'cluster');
      }
    });

    await t.step('the two-face group stayed untagged', async () => {
      assertEquals((await attrsOf('/img/b0.jpg/regions/b0')).personId ?? null, null);
      assertEquals((await attrsOf('/img/b1.jpg/regions/b1')).personId ?? null, null);
    });

    await t.step('a new face of that person attaches instead of minting a second', async () => {
      const extra = await seedFace('a3', near(DIR_A, 7));
      const res = await client.execJson<Summary>('cluster-faces --create-people');

      assertEquals(res.created, 0, 'no second person for someone already known');
      assertEquals((await attrsOf(extra)).personId, personId);
      assertEquals((await unknownPeople()).length, 1);
    });

    await t.step('re-running changes nothing', async () => {
      const res = await client.execJson<Summary>('cluster-faces --create-people');
      assertEquals(res.created, 0);
      assertEquals(res.written, 0);
      assertEquals((await unknownPeople()).length, 1);
    });

    await t.step('an oversized cluster is reported, never turned into a person', async () => {
      // A crowd of near-identical faces beyond --max-cluster: far likelier a
      // chained component than one person, and unsplittable once created.
      for (let i = 0; i < 6; i++) await seedFace(`c${i}`, near(DIR_C, i));

      const res = await client.execJson<Summary>('cluster-faces --create-people --max-cluster 5');
      assertEquals(res.oversized, 1);
      assertEquals(res.created, 0);
      assertEquals((await unknownPeople()).length, 1, 'still just the first person');
    });

    await t.step('one person is not spread across two faces of the same image', async () => {
      // Two detections in a single photo that look alike — a person cannot be both.
      await client.exec('mkdir -p /img');
      await client.exec('echo x > /img/pair.jpg');
      await vfs.update(ADMIN_ACCESS, '/img/pair.jpg', { attrs: { mimetype: 'image/jpeg' } });
      await client.exec('mkdir -p /img/pair.jpg/regions');
      const pairId = (await vfs.get(ADMIN_ACCESS, '/img/pair.jpg')).id;
      await seedFace('d0', near(DIR_D, 0), { image: '/img/pair.jpg', fileId: pairId });
      await seedFace('d1', near(DIR_D, 1), { image: '/img/pair.jpg', fileId: pairId });
      // A third, in its own image, so the cluster still reaches --min-cluster.
      await seedFace('d2', near(DIR_D, 2));

      // --min-cluster 2 also lets the earlier leftover groups become people, so
      // assert about this pair rather than the global count.
      const res = await client.execJson<Summary>('cluster-faces --create-people --min-cluster 2');
      assertEquals(res.sameFileSkipped >= 1, true, 'the duplicate in-image face was dropped');

      const tagged = [
        (await attrsOf('/img/pair.jpg/regions/d0')).personId ?? null,
        (await attrsOf('/img/pair.jpg/regions/d1')).personId ?? null,
      ].filter((p) => p !== null);
      assertEquals(tagged.length, 1, 'only one face of the image got the person');
      // The face that was kept and the one in its own image are the same person.
      assertEquals((await attrsOf('/img/d2.jpg/regions/d2')).personId, tagged[0]);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
