/**
 * compute-fingerprint for pictures: the descriptor is asked of what the picture vector is read
 * from (the display-frame rendition, else the file turned as its node says), stored as an
 * embedding stamped with EMS's producer, and not asked again once a print is there — while a
 * picture marked fingerprinted with no print of its own is.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const testCtx = createTestContext({ modules: ['archive'], rootMount: true });

Deno.test({
  name: 'compute-fingerprint: pictures',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const stub = startStubEms({
    ops: {
      'fingerprint.compute': () => ({
        result: { fingerprints: [{ kind: 'sscd-image', dimension: 2, vector: [0.6, 0.8], label: 'primary' }] },
        producer: 'sscd_disc_mixup',
      }),
    },
  });
  const run = async (path: string, flags = '') => {
    const out = await client.exec(`CFG_EMS_URL=${stub.url} compute-fingerprint ${flags} ${path}`);
    assertEquals(out.success, true, out.error);
  };

  try {
    await client.exec('mkdir -p /fp');
    await vfs.create(ADMIN_ACCESS, 'file', '/fp', 'turned.jpg', { attrs: { size: 10, mimetype: 'image/jpeg', angle: 90, mirror: true } });
    const shown = await vfs.create(ADMIN_ACCESS, 'file', '/fp', 'shown.jpg', { attrs: { size: 10, mimetype: 'image/jpeg', angle: 90 } });
    await client.exec('mkdir -p /fp/shown.jpg/thumbnails');
    await vfs.create(ADMIN_ACCESS, 'file', '/fp/shown.jpg/thumbnails', '800x800.avif', { attrs: { size: 5, mimetype: 'image/avif', sourceId: shown.id } });

    await t.step('a picture with no rendition is described from the file, turned as its node says', async () => {
      await run('/fp/turned.jpg');
      const file = stub.requests.at(-1)!.body.file as Record<string, unknown>;
      assert(String(file.path).endsWith('.jpg'), String(file.path));
      assertEquals([file.angle, file.mirror, file.mimetype], [90, true, 'image/jpeg']);

      const print = await vfs.get(ADMIN_ACCESS, '/fp/turned.jpg/metadata/sscd-image');
      assertEquals([print.type, print.attrs.embeddingType, print.attrs.computedBy, print.attrs.label], ['embedding', 'sscd-image', 'sscd_disc_mixup', 'primary']);
      assert(typeof (await vfs.get(ADMIN_ACCESS, '/fp/turned.jpg')).attrs.fingerprintedAt === 'string');
    });

    await t.step('a picture with its rendition is described from that, already in the display frame', async () => {
      await run('/fp/shown.jpg');
      const file = stub.requests.at(-1)!.body.file as Record<string, unknown>;
      assert(String(file.path).endsWith('.avif'), String(file.path));
      assertEquals([file.angle, file.mirror, file.mimetype], [0, false, 'image/avif']);
    });

    await t.step('a fingerprinted picture is not asked again; one marked without a print is', async () => {
      const asked = stub.requests.length;
      await run('/fp/turned.jpg');
      assertEquals(stub.requests.length, asked);

      await vfs.create(ADMIN_ACCESS, 'file', '/fp', 'marked.jpg', { attrs: { size: 10, mimetype: 'image/jpeg', fingerprintedAt: '2026-10-11T10:00:00Z' } });
      await run('/fp/marked.jpg');
      assertEquals(stub.requests.length, asked + 1);
      assert(await vfs.exists(ADMIN_ACCESS, '/fp/marked.jpg/metadata/sscd-image'));
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
  }
});
