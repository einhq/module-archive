/**
 * face-audit: the leave-one-out nearest anchor (@archive/media/face-audit), the doubt the command
 * marks transferred faces with, how person-faces lists them, and face-confirm taking one back.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { type Anchor, disagrees, nearestAnchors } from '@archive/media/face-audit';
import type { FaceAuditResult, FaceConfirmResult } from '@archive/media/api';
import type { FaceListResult } from '@archive/people/api';
import type { RegionAttrs } from '@archive/media/regions';

/** Seeded so a failure reproduces. */
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};

/** The pass written the obvious way: every ordered pair, no blocking. */
const naive = (anchors: Anchor[]) => {
  const unit = anchors.map((a) => {
    const norm = Math.hypot(...Array.from(a.vector));
    return Array.from(a.vector, (x) => x / norm);
  });
  return anchors.map((a, i) => {
    const own = { index: -1, similarity: -Infinity };
    const other = { index: -1, similarity: -Infinity };
    anchors.forEach((b, j) => {
      if (i === j || (a.file !== undefined && a.file === b.file)) return;
      const sim = unit[i].reduce((sum, x, d) => sum + x * unit[j][d], 0);
      const best = a.person === b.person ? own : other;
      if (sim > best.similarity) (best.index = j, best.similarity = sim);
    });
    return { own: own.index === -1 ? null : own, other: other.index === -1 ? null : other };
  });
};

Deno.test('nearestAnchors finds what an unblocked search finds, with a partial last block', async () => {
  const next = random(7);
  // 29 is three full blocks of eight and five over.
  const anchors: Anchor[] = Array.from({ length: 29 }, (_, i) => ({
    person: `p${i % 4}`,
    file: `f${Math.floor(i / 3)}`,
    vector: Array.from({ length: 16 }, next),
  }));
  const got = await nearestAnchors(anchors);
  const want = naive(anchors);
  for (let i = 0; i < anchors.length; i++) {
    for (const side of ['own', 'other'] as const) {
      assertEquals(got[i][side]?.index, want[i][side]?.index, `${side} of ${i}`);
      if (want[i][side]) assertAlmostEquals(got[i][side]!.similarity, want[i][side]!.similarity, 1e-5);
    }
  }
});

Deno.test('nearestAnchors never pairs two faces of one photo', async () => {
  const anchors: Anchor[] = [
    { person: 'anna', file: 'f1', vector: [1, 0] },
    { person: 'bertil', file: 'f1', vector: [1, 0.01] },
    { person: 'anna', file: 'f2', vector: [0.6, 0.8] },
  ];
  const [first] = await nearestAnchors(anchors);
  assertEquals(first.other, null);
  assertEquals(first.own?.index, 2);
});

Deno.test('disagrees needs an own anchor to be outdone', () => {
  assert(disagrees({ own: { index: 0, similarity: 0.4 }, other: { index: 1, similarity: 0.6 } }));
  assert(!disagrees({ own: { index: 0, similarity: 0.6 }, other: { index: 1, similarity: 0.4 } }));
  assert(!disagrees({ own: null, other: { index: 1, similarity: 0.9 } }));
  assert(!disagrees({ own: { index: 0, similarity: 0.6 }, other: null }));
});

const testCtx = createTestContext({ modules: ['archive'] });

const DIM = 48;
const BLOCK = 16;
/** Three orthogonal directions, one block of coordinates each. */
const dir = (group: number, seed: number) => Array.from({ length: DIM }, (_, i) => Math.floor(i / BLOCK) === group ? 1 + (i % BLOCK === seed % BLOCK ? 0.05 : 0) : 0);

Deno.test({
  name: 'face-audit marks a transferred face that looks like somebody else',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const attrsOf = (path: string) => vfs.get<RegionAttrs>(ADMIN_ACCESS, path).then((n) => n.attrs);

  const person = async (slug: string, name: string) => (await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { attrs: { name } })).id;

  /** One image with one face on it, assigned as given. */
  const face = async (name: string, vector: number[], personId: string, personSource: string) => {
    const image = `/img/${name}.jpg`;
    await client.exec(`echo x > ${image} && mkdir -p ${image}/regions`);
    const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
    const path = `${image}/regions/face-0`;
    await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, 'face-0', {
      attrs: { fileId, confidence: 0.9, detectedBy: 'insightface-buffalo_l', personId, personSource },
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
    await client.exec(`mkdir -p ${PEOPLE_ROOT} /img`);
    const anna = await person('Anna_Andersson', 'Anna Andersson');
    const bertil = await person('Bertil_Berg', 'Bertil Berg');
    const cecilia = await person('Cecilia_Carlsson', 'Cecilia Carlsson');

    await face('a0', dir(0, 0), anna, 'transfer');
    await face('a1', dir(0, 1), anna, 'transfer');
    await face('a2', dir(0, 2), anna, 'manual');
    await face('b0', dir(1, 0), bertil, 'transfer');
    await face('b1', dir(1, 1), bertil, 'transfer');
    // Bertil's face, transferred to Anna.
    const wrong = await face('w', dir(1, 2), anna, 'transfer');
    // Cecilia's only anchor: nothing of her own to agree with.
    await face('c0', dir(1, 3), cecilia, 'transfer');
    // Recognition's guess is neither evidence nor audited.
    await face('auto', dir(1, 4), anna, 'auto');

    await t.step('--dry-run reports without marking', async () => {
      const res = await client.execJson<FaceAuditResult>('face-audit --dry-run');
      assertEquals(res.dryRun, true);
      assertEquals(res.anchors, 7);
      assertEquals(res.audited, 6);
      assertEquals(res.faces.map((f) => f.facePath), [wrong]);
      assertEquals((await attrsOf(wrong)).doubt, undefined);
    });

    await t.step('marks the face with who it looks like', async () => {
      const res = await client.execJson<FaceAuditResult>('face-audit');
      assertEquals(res.doubtful, 1);
      assertEquals(res.people, [{ id: anna, path: `${PEOPLE_ROOT}/Anna_Andersson`, name: 'Anna Andersson', doubtful: 1 }]);
      const doubt = (await attrsOf(wrong)).doubt!;
      assertEquals([doubt.personId, doubt.likePersonId], [anna, bertil]);
      assert(doubt.similarity > doubt.ownSimilarity);
    });

    await t.step('person-faces lists the doubtful faces and counts them', async () => {
      const all = await client.execJson<FaceListResult>(`person-faces ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals([all.total, all.doubtful, all.person.faceCount], [5, 1, 5]);
      const doubtful = await client.execJson<FaceListResult>(`person-faces --doubtful --sort doubt ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals([doubtful.total, doubtful.doubtful, doubtful.person.faceCount], [1, 1, 5]);
      assertEquals(doubtful.faces[0].facePath, wrong);
      assertEquals(doubtful.faces[0].doubt?.likeName, 'Bertil Berg');
    });

    await t.step('a doubt stops applying once the face moves, and the next run clears it', async () => {
      await vfs.update(ADMIN_ACCESS, wrong, { attrs: { personId: bertil } });
      const moved = await client.execJson<FaceListResult>(`person-faces --doubtful ${PEOPLE_ROOT}/Bertil_Berg`);
      assertEquals(moved.doubtful, 0);
      const res = await client.execJson<FaceAuditResult>('face-audit');
      assertEquals([res.doubtful, res.cleared], [0, 1]);
      assertEquals((await attrsOf(wrong)).doubt, undefined);
      await vfs.update(ADMIN_ACCESS, wrong, { attrs: { personId: anna } });
      assertEquals((await client.execJson<FaceAuditResult>('face-audit')).doubtful, 1);
    });

    await t.step('face-confirm keeps the person and drops the doubt', async () => {
      const res = await client.execJson<FaceConfirmResult>(`face-confirm ${wrong}`);
      assertEquals(res.confirmed, [wrong]);
      const attrs = await attrsOf(wrong);
      assertEquals([attrs.personId, attrs.personSource, attrs.doubt], [anna, 'manual', undefined]);
      const audit = await client.execJson<FaceAuditResult>('face-audit');
      assertEquals([audit.audited, audit.doubtful], [5, 0]);
    });

    await t.step('face-confirm refuses a region assigned to nobody, and changes nothing', async () => {
      const loose = await face('loose', dir(2, 0), anna, 'transfer');
      await vfs.update(ADMIN_ACCESS, loose, { attrs: { personId: null } });
      const before = await attrsOf(wrong);
      const res = await client.exec(`face-confirm ${wrong} ${loose}`);
      assert(!res.success);
      assertEquals((await attrsOf(wrong)).personAssignedAt, before.personAssignedAt);
    });
  } finally {
    await client.close();
    await testCtx.teardown();
  }
});
