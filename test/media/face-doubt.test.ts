/**
 * A face's doubt (@archive/media/regions): how person-faces lists the doubtful faces, a doubt that
 * stops applying once the face moves, face-confirm taking one back, and face-doubt raising and
 * withdrawing one by hand, which media-details reports for the lightbox.
 */

import { PEOPLE_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import type { FaceConfirmResult, FaceDoubtResult, MediaDetails } from '@archive/media/api';
import type { FaceDoubtView, FaceListResult } from '@archive/people/api';
import type { FaceDoubt, RegionAttrs } from '@archive/media/regions';

const testCtx = createTestContext({ modules: ['archive'] });

/** Who asked, or who the face looks like. */
const why = (doubt?: FaceDoubtView) => doubt && ('markedBy' in doubt ? doubt.markedBy : doubt.likeName);

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
      attrs: {
        fileId,
        faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        confidence: 0.9,
        detectedBy: 'insightface-buffalo_l',
        personId,
        personSource,
        ...(doubt ? { doubt } : {}),
      },
    });
    return `${image}/regions/face-0`;
  };

  try {
    await client.exec(`mkdir -p ${PEOPLE_ROOT} /img`);
    const anna = await person('Anna_Andersson', 'Anna Andersson');
    const bertil = await person('Bertil_Berg', 'Bertil Berg');
    const doubt = { personId: anna, likePersonId: bertil, similarity: 0.8, ownSimilarity: 0.4, auditedAt: '2026-10-01T00:00:00Z' };

    await face('a0', anna, 'transfer');
    const a1 = await face('a1', anna, 'manual');
    // Bertil's face, given to Anna, and found out.
    const wrong = await face('w', anna, 'transfer', doubt);

    await t.step('person-faces lists the doubtful faces and counts them', async () => {
      const all = await client.execJson<FaceListResult>(`person-faces ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals([all.total, all.doubtful, all.person.faceCount], [3, 1, 3]);
      const doubtful = await client.execJson<FaceListResult>(`person-faces --doubtful --sort doubt ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals([doubtful.total, doubtful.doubtful, doubtful.person.faceCount], [1, 1, 3]);
      assertEquals(doubtful.faces[0].facePath, wrong);
      assertEquals(why(doubtful.faces[0].doubt), 'Bertil Berg');
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

    await t.step('face-doubt questions a face a human named, and person-faces lists it first', async () => {
      const res = await client.execJson<FaceDoubtResult>(`face-doubt ${a1}`);
      assertEquals(res, { marked: [a1] });
      const attrs = await attrsOf(a1);
      assertEquals([attrs.personId, attrs.personSource], [anna, 'manual']);
      assertEquals(attrs.doubt && 'markedBy' in attrs.doubt ? attrs.doubt.markedBy : undefined, 'admin');
      await face('w2', anna, 'transfer', doubt);
      const doubtful = await client.execJson<FaceListResult>(`person-faces --doubtful --sort doubt ${PEOPLE_ROOT}/Anna_Andersson`);
      assertEquals(doubtful.faces.map((f) => f.facePath), [a1, '/img/w2.jpg/regions/face-0']);
      assertEquals(why(doubtful.faces[0].doubt), 'admin');
    });

    await t.step('media-details says which face is in question, and why', async () => {
      const details = await client.execJson<MediaDetails>('media-details /img/a1.jpg');
      assertEquals(details.faces.map((f) => f.doubt), [{ markedBy: 'admin' }]);
      const audited = await client.execJson<MediaDetails>('media-details /img/w2.jpg');
      assertEquals(audited.faces.map((f) => f.doubt), [{ likeName: 'Bertil Berg' }]);
    });

    await t.step('face-doubt --clear withdraws the doubt and leaves the person', async () => {
      assertEquals(await client.execJson<FaceDoubtResult>(`face-doubt --clear ${a1}`), { cleared: [a1] });
      const attrs = await attrsOf(a1);
      assertEquals([attrs.personId, attrs.doubt], [anna, undefined]);
    });

    await t.step('face-doubt refuses a face assigned to nobody', async () => {
      const loose = await face('loose-doubt', anna, 'manual');
      await vfs.update(ADMIN_ACCESS, loose, { attrs: { personId: null } });
      assert(!(await client.exec(`face-doubt ${a1} ${loose}`)).success);
      assertEquals((await attrsOf(a1)).doubt, undefined);
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
