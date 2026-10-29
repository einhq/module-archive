/**
 * A face's doubt (@archive/media/regions): how person-faces lists the doubtful faces, a doubt that
 * stops applying once the face moves, and face-confirm taking one back.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import type { FaceConfirmResult } from '@archive/media/api';
import type { FaceListResult } from '@archive/people/api';
import type { FaceDoubt, RegionAttrs } from '@archive/media/regions';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'a doubtful face is listed, stops applying once moved, and face-confirm takes it back',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const attrsOf = (path: string) => vfs.get<RegionAttrs>(ADMIN_ACCESS, path).then((n) => n.attrs);

  const person = async (slug: string, name: string) => (await vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { attrs: { name } })).id;

  /** One image with one face on it, assigned as given. */
  const face = async (name: string, personId: string, personSource: string, doubt?: FaceDoubt) => {
    const image = `/img/${name}.jpg`;
    await client.exec(`echo x > ${image} && mkdir -p ${image}/regions`);
    const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
    await vfs.create(ADMIN_ACCESS, 'media-region', `${image}/regions`, 'face-0', {
      attrs: { fileId, confidence: 0.9, detectedBy: 'insightface-buffalo_l', personId, personSource, ...(doubt ? { doubt } : {}) },
    });
    return `${image}/regions/face-0`;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT} /img`);
    const anna = await person('Anna_Andersson', 'Anna Andersson');
    const bertil = await person('Bertil_Berg', 'Bertil Berg');
    const doubt = { personId: anna, likePersonId: bertil, similarity: 0.8, ownSimilarity: 0.4, auditedAt: '2026-10-01T00:00:00Z' };

    await face('a0', anna, 'transfer');
    await face('a1', anna, 'manual');
    // Bertil's face, given to Anna, and found out.
    const wrong = await face('w', anna, 'transfer', doubt);

    await t.step('person-faces lists the doubtful faces and counts them', async () => {
      const all = await client.execJson<FaceListResult>(`person-faces ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals([all.total, all.doubtful, all.person.faceCount], [3, 1, 3]);
      const doubtful = await client.execJson<FaceListResult>(`person-faces --doubtful --sort doubt ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals([doubtful.total, doubtful.doubtful, doubtful.person.faceCount], [1, 1, 3]);
      assertEquals(doubtful.faces[0].facePath, wrong);
      assertEquals(doubtful.faces[0].doubt?.likeName, 'Bertil Berg');
    });

    await t.step('a doubt stops applying once the face moves', async () => {
      await vfs.update(ADMIN_ACCESS, wrong, { attrs: { personId: bertil } });
      const moved = await client.execJson<FaceListResult>(`person-faces --doubtful ${PEOPLE_ROOT}/Bertil_Berg`);
      assertEquals(moved.doubtful, 0);
      await vfs.update(ADMIN_ACCESS, wrong, { attrs: { personId: anna } });
      assertEquals((await client.execJson<FaceListResult>(`person-faces ${PEOPLE_ROOT}/Anna_Andersson`)).doubtful, 1);
    });

    await t.step('face-confirm keeps the person and drops the doubt', async () => {
      const res = await client.execJson<FaceConfirmResult>(`face-confirm ${wrong}`);
      assertEquals(res.confirmed, [wrong]);
      const attrs = await attrsOf(wrong);
      assertEquals([attrs.personId, attrs.personSource, attrs.doubt], [anna, 'manual', undefined]);
      assertEquals((await client.execJson<FaceListResult>(`person-faces ${PEOPLE_ROOT}/Anna_Andersson`)).doubtful, 0);
    });

    await t.step('face-confirm refuses a region assigned to nobody, and changes nothing', async () => {
      const loose = await face('loose', anna, 'transfer');
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
