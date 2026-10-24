import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Box = { x: number; y: number; width: number; height: number };
type Added = { faceId: string; facePath: string; personId: string; personPath: string };
type Removed = { personRemoved: boolean; representativeChanged: boolean };

Deno.test({
  name: 'face editing updates boxes and removes only empty unnamed people',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec('mkdir -p /img');
    await client.exec('mkfile /img/photo.jpg');
    await vfs.update(ADMIN_ACCESS, '/img/photo.jpg', { attrs: { mimetype: 'image/jpeg', width: 1200, height: 800 } });

    const first = await client.execJson<Added>('face-add /img/photo.jpg --box 0.1,0.2,0.3,0.4 --no-crop');

    await t.step('updates stored geometry and leaves a repairable crop', async () => {
      const result = await client.execJson<{ box: Box; cropWritten: boolean }>(
        `face-set-box ${first.facePath} --box 0.2,0.25,0.35,0.3 --no-crop`,
      );
      assertEquals(result.box, { x: 0.2, y: 0.25, width: 0.35, height: 0.3 });
      assertEquals(result.cropWritten, false);

      const face = await vfs.get<{ faceBox?: Box; boxEditedBy?: string; boxEditedAt?: string }>(ADMIN_ACCESS, first.facePath);
      assertEquals(face.attrs.faceBox, result.box);
      assertEquals(face.attrs.boxEditedBy, 'face-set-box');
      assertEquals(typeof face.attrs.boxEditedAt, 'string');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${first.facePath}/image.avif`), true);
    });

    await t.step('moving a detected face takes its vector away, not its person', async () => {
      // The vector describes the box the detector drew; once a human moves it, it describes
      // something else, so the face stops voting and stays a tag of the same person.
      const fileId = (await vfs.get(ADMIN_ACCESS, '/img/photo.jpg')).id;
      await vfs.create(ADMIN_ACCESS, 'media-region', '/img/photo.jpg/regions', 'face-7', {
        attrs: { fileId, detectedBy: 'insightface-buffalo_l', confidence: 0.9, personId: first.personId, faceBox: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
      });
      await vfs.create(ADMIN_ACCESS, 'embedding', '/img/photo.jpg/regions/face-7', 'embedding', { attrs: { embeddingType: 'face', capacity: 512 } });

      await client.execJson(`face-set-box /img/photo.jpg/regions/face-7 --box 0.5,0.5,0.15,0.15 --no-crop`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/img/photo.jpg/regions/face-7/embedding'), false);
      assertEquals((await vfs.get<{ personId?: string }>(ADMIN_ACCESS, '/img/photo.jpg/regions/face-7')).attrs.personId, first.personId);
      await vfs.unlink(ADMIN_ACCESS, '/img/photo.jpg/regions/face-7', '/img/photo.jpg/regions', { recursive: true });
    });

    await t.step('keeps a multi-face unknown and advances its representative', async () => {
      const second = await vfs.create(ADMIN_ACCESS, 'media-region', '/img/photo.jpg/regions', 'manual-extra', {
        attrs: {
          personId: first.personId,
          faceBox: { x: 0.6, y: 0.2, width: 0.2, height: 0.3 },
        },
      });

      const result = await client.execJson<Removed>(`face-remove ${first.facePath}`);
      assertEquals(result.personRemoved, false);
      assertEquals(result.representativeChanged, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, first.personPath), true);
      assertEquals(
        (await vfs.get<{ representativeFaceId?: string }>(ADMIN_ACCESS, first.personPath)).attrs.representativeFaceId,
        second.id,
      );
    });

    await t.step('removes the unnamed person with its last face', async () => {
      const result = await client.execJson<Removed>('face-remove /img/photo.jpg/regions/manual-extra');
      assertEquals(result.personRemoved, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, first.personPath), false);
    });

    await t.step('never removes a named person', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna --name Anna`);
      const person = await client.execJson<{ id: string }>(`info ${PEOPLE_ROOT}/anna`);
      await vfs.create(ADMIN_ACCESS, 'media-region', '/img/photo.jpg/regions', 'manual-named', {
        attrs: {
          personId: person.id,
          faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        },
      });
      const face = await vfs.get(ADMIN_ACCESS, '/img/photo.jpg/regions/manual-named');
      await vfs.update(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna`, { attrs: { representativeFaceId: face.id } });

      const result = await client.execJson<Removed>('face-remove /img/photo.jpg/regions/manual-named');
      assertEquals(result.personRemoved, false);
      assertEquals(result.representativeChanged, true);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna`), true);
      assertEquals((await vfs.get<{ representativeFaceId?: string }>(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna`)).attrs.representativeFaceId, undefined);
    });

    await t.step('rejects invalid boxes and non-face paths', async () => {
      await cmd.shouldFailWith('face-set-box /img/photo.jpg --box 0.1,0.1,0.2,0.2 --no-crop', 'expected a region path');
      await cmd.shouldFailWith('face-set-box /img/photo.jpg/regions/missing --box 0.1,0.1,0,0.2 --no-crop', '--box must be');
      await cmd.shouldFailWith('face-remove /img/photo.jpg', 'expected a region path');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
