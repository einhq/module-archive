import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Summary = {
  scanned: number;
  candidates: number;
  regenerated: number;
  skippedWithinBound: number;
  skippedMissingCrop: number;
  skippedInvalid: number;
  failed: number;
  dryRun: boolean;
  nextAfter: string | null;
  done: boolean;
};

Deno.test({
  name: 'regenerate-face-crops batches existing crops without re-detecting',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/a/files`);

    for (const name of ['one.jpg', 'two.jpg']) {
      const image = `${ALBUMS_ROOT}/a/files/${name}`;
      await client.exec(`mkfile ${image}`);
      await vfs.update(ADMIN_ACCESS, image, { attrs: { mimetype: 'image/jpeg', width: 1200, height: 800 } });
      const fileId = (await vfs.get(ADMIN_ACCESS, image)).id;
      await client.exec(`mkdir -p ${image}/regions`);
      await client.exec(`mknode -t media-region ${image}/regions/face-0 --as fileId=${fileId}`);
      await vfs.update(ADMIN_ACCESS, `${image}/regions/face-0`, {
        attrs: { faceBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } },
      });
      await client.exec(`mknode -p -t file ${image}/regions/face-0/image.avif --as mimetype=image/avif --as sourceId=${fileId}`);
    }

    const first = await client.execJson<Summary>('regenerate-face-crops --dry-run --limit 1');
    assertEquals(first.scanned, 1);
    assertEquals(first.candidates, 1);
    assertEquals(first.regenerated, 0);
    assertEquals(first.dryRun, true);
    assertEquals(first.done, false);
    assertEquals(typeof first.nextAfter, 'string');

    const second = await client.execJson<Summary>(`regenerate-face-crops --dry-run --limit 1 --after ${first.nextAfter}`);
    assertEquals(second.scanned, 1);
    assertEquals(second.candidates, 1);
    assertEquals(second.failed, 0);

    await cmd.shouldFailWith('regenerate-face-crops --limit 0', 'invalid --limit');
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
