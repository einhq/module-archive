/**
 * subcluster-faces end to end: a person holding two orthogonal blobs of faces
 * comes back as two groups, and the dendrogram it reports is complete enough for
 * the caller to re-cut without asking again.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type SubclusterResult = {
  person: { id: string; path: string; name: string; unnamed: boolean };
  total: number;
  withoutVector: number;
  threshold: number | null;
  k: number | null;
  faces: { facePath: string; filePath?: string; confidence: number }[];
  merges: [number, number, number, number][];
  groups: number[][];
  suggested: { threshold: number; groups: number };
};

const DIM = 8;
const HALF = DIM / 2;

/** Two orthogonal directions, one per half of the coordinates — cosine 0 apart. */
const dir = (group: number) => Array.from({ length: DIM }, (_, i) => (Math.floor(i / HALF) === group ? 1 : 0));
const near = (group: number, seed: number) => dir(group).map((v, i) => (v === 1 && i % HALF === seed % HALF ? v + 0.02 : v));

Deno.test({
  name: 'subcluster-faces',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /**
   * A person whose faces come from `groups` blobs, each a region with a real embedding; the
   * `boxOnly` ones are tags, regions with none.
   */
  const seedPerson = async (tag: string, blobs: number[], boxOnly = 0) => {
    const person = await vfs.create(ADMIN_ACCESS, 'person', `${PEOPLE_ROOT}/unknown`, tag, {
      props: { uid: 1000, gid: 1000, mode: 0o775 },
      attrs: { name: `Unknown ${tag}`, unnamed: true, origin: 'face', createdBy: 'cluster-faces' },
    });

    let index = 0;
    const facePaths: string[] = [];
    const write = async (values: number[] | null) => {
      const image = `/img/${tag}-${index}.jpg`;
      await client.exec(`echo x > ${image}`);
      await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg' } });
      await client.exec(`mkdir -p ${image}/regions`);
      const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
      const facePath = `${image}/regions/face-0`;
      await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, 'face-0', {
        props: { uid: 1000, gid: 1000, mode: 0o644 },
        attrs: { fileId, personId: person.id, personSource: 'cluster', confidence: 0.9 },
      });
      // A tag has no embedding at all; a face has one holding the vector.
      if (values) {
        await vfs.create(ADMIN_ACCESS, 'embedding', facePath, 'embedding', {
          props: { uid: 1000, gid: 1000, mode: 0o644 },
          attrs: { embeddingType: 'face', capacity: DIM },
        });
        const handle = await vfs.open(ADMIN_ACCESS, `${facePath}/embedding`, { mode: 'w' });
        try {
          await handle.write(new TextEncoder().encode(JSON.stringify(values)));
        } finally {
          await handle.close();
        }
      }
      facePaths.push(facePath);
      index++;
    };

    for (const [group, count] of blobs.entries()) {
      for (let i = 0; i < count; i++) await write(near(group, i));
    }
    for (let i = 0; i < boxOnly; i++) await write(null);

    return { id: person.id, path: `${PEOPLE_ROOT}/unknown/${tag}`, facePaths };
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT}/unknown`);
    await client.exec('mkdir -p /img');

    const person = await seedPerson('fused', [4, 3]);

    await t.step('two blobs under one person come back as two groups', async () => {
      const res = await client.execJson<SubclusterResult>(`subcluster-faces ${person.path}`);

      assertEquals(res.total, 7);
      assertEquals(res.withoutVector, 0);
      assertEquals(res.person.id, person.id);
      // A full agglomeration: every face joined, in n-1 steps.
      assertEquals(res.merges.length, 6);
      assertEquals(res.merges[res.merges.length - 1][3], 7);
      // Merges arrive ordered by decreasing similarity, which is what makes a
      // cut a prefix of the list.
      for (let i = 1; i < res.merges.length; i++) {
        assertEquals(res.merges[i][2] <= res.merges[i - 1][2] + 1e-6, true);
      }

      // No --threshold given, so the cut comes from the dendrogram's own shape:
      // the gap between the two blobs' internal merges and their join.
      assertEquals(res.suggested.groups, 2);
      assertEquals(res.threshold, res.suggested.threshold);
      assertEquals(res.groups.map((g) => g.length), [4, 3]);
      // Group indices point into `faces`, and no face is in two groups.
      assertEquals(res.groups.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
      assertEquals(res.faces.length, 7);
      assertEquals(res.faces[0].filePath, res.faces[0].facePath.replace(/\/regions\/[^/]+$/, ''));
    });

    await t.step('--k cuts into exactly that many groups', async () => {
      const one = await client.execJson<SubclusterResult>(`subcluster-faces ${person.path} --k 1`);
      assertEquals(one.groups.length, 1);
      assertEquals(one.threshold, null);
      assertEquals(one.k, 1);

      const five = await client.execJson<SubclusterResult>(`subcluster-faces ${person.path} --k 5`);
      assertEquals(five.groups.length, 5);
    });

    await t.step('--threshold trades group count for tightness', async () => {
      const loose = await client.execJson<SubclusterResult>(`subcluster-faces ${person.path} --threshold -1`);
      assertEquals(loose.groups.length, 1, 'below the between-blob similarity everything is one person');

      const tight = await client.execJson<SubclusterResult>(`subcluster-faces ${person.path} --threshold 0.99999`);
      assertEquals(tight.groups.length, 7, 'above the within-blob similarity every face stands alone');
    });

    await t.step('box-only faces are reported, not clustered', async () => {
      // Legacy manual tags carry a box and no embedding; there is nothing to
      // cluster on and silently dropping them would misreport the face count.
      const mixed = await seedPerson('legacy', [3], 2);
      const res = await client.execJson<SubclusterResult>(`subcluster-faces ${mixed.path}`);

      assertEquals(res.total, 3);
      assertEquals(res.withoutVector, 2);
      assertEquals(res.faces.length, 3);
    });

    await t.step('a bad person or a bad flag fails cleanly', async () => {
      assertEquals((await client.exec('subcluster-faces')).success, false);
      assertEquals((await client.exec(`subcluster-faces ${PEOPLE_ROOT}/unknown/nope`)).success, false);
      assertEquals((await client.exec(`subcluster-faces ${person.path} --threshold high`)).success, false);
      // A bare id resolves under /people/unknown.
      assertEquals((await client.exec('subcluster-faces fused')).success, true);
    });

    await t.step('a person with one face has nothing to split', async () => {
      const lonely = await seedPerson('lonely', [1]);
      const res = await client.execJson<SubclusterResult>(`subcluster-faces ${lonely.path}`);

      assertEquals(res.total, 1);
      assertEquals(res.merges.length, 0);
      assertEquals(res.groups, [[0]]);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
