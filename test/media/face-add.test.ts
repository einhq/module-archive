import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Result = {
  faceId: string;
  facePath: string;
  personId: string;
  personPath: string;
  personName: string;
  box: { x: number; y: number; width: number; height: number };
  cropWritten: boolean;
};

Deno.test({
  name: 'face-add creates a protected manual box and an unidentified person',
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

    await t.step('creates the face, empty repairable crop, and singleton unknown', async () => {
      const first = await client.execJson<Result>('face-add /img/photo.jpg --box 0.1,0.2,0.3,0.4 --no-crop');
      assertEquals(first.facePath, '/img/photo.jpg/regions/manual-0');
      assertEquals(first.box, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
      assertEquals(first.cropWritten, false);

      const face = await vfs.get<{
        detectedBy?: string;
        fileId?: string;
        personId?: string;
        personSource?: string;
        faceBox?: Result['box'];
      }>(ADMIN_ACCESS, first.facePath);
      // A drawn box is a tag: a region with no embedding, so recognition never votes with it.
      assertEquals(face.type, 'media-region');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${first.facePath}/embedding`), false);
      assertEquals(face.attrs.detectedBy, 'manual');
      assertEquals(face.attrs.personId, first.personId);
      assertEquals(face.attrs.personSource, 'manual');
      assertEquals(face.attrs.faceBox, first.box);
      assertEquals(face.attrs.fileId, (await vfs.get(ADMIN_ACCESS, '/img/photo.jpg')).id);

      const person = await vfs.get<{
        name?: string;
        unnamed?: boolean;
        origin?: string;
        createdBy?: string;
        createdAt?: string;
        representativeFaceId?: string;
      }>(ADMIN_ACCESS, first.personPath);
      assertEquals(first.personPath.startsWith(`${PEOPLE_ROOT}/unknown/`), true);
      assertEquals(person.attrs, {
        name: first.personName,
        unnamed: true,
        origin: 'face',
        createdBy: 'face-add',
        createdAt: person.attrs.createdAt,
        representativeFaceId: first.faceId,
      });

      const crop = await vfs.get<{ mimetype?: string; sourceId?: string; size?: number }>(ADMIN_ACCESS, `${first.facePath}/image.avif`);
      assertEquals(crop.attrs.mimetype, 'image/avif');
      assertEquals(crop.attrs.sourceId, face.attrs.fileId);
      assertEquals(Number(crop.attrs.size ?? 0), 0);

      const details = await client.execJson<{
        faces: Array<{
          faceId: string;
          facePath: string;
          personId?: string;
          personPath?: string;
          personName?: string;
          unnamed?: boolean;
          faceBox: Result['box'];
          hasFace: boolean;
        }>;
        unknownFaces: Array<{
          faceId: string;
          facePath: string;
          personId: string;
          personPath: string;
          personName: string;
          faceBox?: Result['box'];
        }>;
      }>('media-details /img/photo.jpg');
      assertEquals(details.unknownFaces, [{
        faceId: first.faceId,
        facePath: first.facePath,
        personId: first.personId,
        personPath: first.personPath,
        personName: first.personName,
        faceBox: first.box,
      }]);
      assertEquals(details.faces, [{
        faceId: first.faceId,
        facePath: first.facePath,
        faceBox: first.box,
        hasFace: false,
        personId: first.personId,
        personPath: first.personPath,
        personName: first.personName,
        unnamed: true,
      }]);
    });

    await t.step('uses the next manual index without renumbering', async () => {
      const second = await client.execJson<Result>('face-add /img/photo.jpg --box 0.5,0.1,0.2,0.25 --no-crop');
      assertEquals(second.facePath, '/img/photo.jpg/regions/manual-1');
    });

    await t.step('rejects unusable geometry and non-images', async () => {
      await cmd.shouldFailWith('face-add /img/photo.jpg --box 0.1,0.2,0,0.4 --no-crop', '--box must be');
      await client.exec('mkfile /img/note.txt');
      await vfs.update(ADMIN_ACCESS, '/img/note.txt', { attrs: { mimetype: 'text/plain' } });
      await cmd.shouldFailWith('face-add /img/note.txt --box 0.1,0.2,0.3,0.4 --no-crop', 'not an image');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
