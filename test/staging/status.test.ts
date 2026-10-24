/**
 * `staging status` reads a staging area without writing to it: per category the staged originals
 * by kind from one aggregate (renditions and versions are not originals), with the exact copies
 * among them by where their originals lie, the destination as an
 * album reference, today's upload folder, and the routes waiting for a device.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import type { StagingStatus } from '@archive/staging/api';
import { assertEquals, assertMatch } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/anna/staging';
const BATCH = `${STAGING}/files/inbox/upload-2026-10-16`;

Deno.test({ name: 'staging status', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('user-create anna --uid 3600');

    await t.step('a staging area not set up reads as not initialized, and is not made', async () => {
      const status = await client.execJson<StagingStatus>('staging status --user anna');
      assertEquals(status, { user: 'anna', initialized: false, stagingPath: STAGING, defaultCategory: 'inbox', categories: [], routesWaiting: 0 });
      assertEquals(await vfs.exists(ADMIN_ACCESS, STAGING), false);
    });

    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed(`mkdir -p ${BATCH} ${ALBUMS_ROOT}/family`);
    await cmd.shouldSucceed(`mknode -t album ${ALBUMS_ROOT}/family/prints --as name="Family prints"`);
    await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/family/prints`, { attrs: { mediaCount: 12 } });
    await cmd.shouldSucceed(`staging category scans --user anna --create --kind scans --label "Box 3" --destination ${ALBUMS_ROOT}/family/prints`);
    /** A file at `path` with `attrs`. */
    const file = async (path: string, attrs: Record<string, unknown>) => {
      await cmd.shouldSucceed(`mknode -t file ${path}`);
      await vfs.update(ADMIN_ACCESS, path, { attrs });
    };
    const read = { indexedAt: '2026-10-16T10:00:00Z' };
    await file(`${BATCH}/waiting.jpg`, { mimetype: 'image/jpeg', size: 100 });
    const copy = (where: string) => ({ duplicate: { inbox: 'anna', sha256: 'c'.repeat(64), at: '2026-10-16T10:00:00Z', kind: 'exact', where, of: 'x' } });
    await file(`${BATCH}/dated.mp4`, { mimetype: 'video/mp4', size: 1000, ...read, takenAtUtc: '2019-06-14T10:00:00Z', ...copy('inbox') });
    await file(`${BATCH}/undated.jpg`, { mimetype: 'image/jpeg', size: 200, ...read, ...copy('library') });
    // An empty upload never gets indexed, so it never counts as waiting for it.
    await file(`${BATCH}/empty.jpg`, { mimetype: 'image/jpeg', size: 0 });
    await file(`${BATCH}/notes.json`, { mimetype: 'application/json', size: 10 });
    // A file's own children, and a version, are not originals.
    await cmd.shouldSucceed(`mkdir -p ${BATCH}/dated.mp4/thumbnails ${BATCH}/dated.mp4/versions`);
    await file(`${BATCH}/dated.mp4/thumbnails/grid`, { mimetype: 'image/avif', size: 5, sourceId: 'x' });
    await file(`${BATCH}/dated.mp4/versions/raw.mov`, { mimetype: 'video/quicktime', size: 5000, sourceId: 'x' });
    // A marker, with no kind: checked, and no copy.
    await file(`${STAGING}/files/scans/scan0001.tif`, {
      mimetype: 'image/tiff',
      size: 3000,
      ...read,
      duplicate: { inbox: 'anna', sha256: 'd'.repeat(64), at: '2026-10-16T10:00:00Z' },
    });
    await file(`${STAGING}/routes/hike.gpx`, { mimetype: 'application/gpx+xml', size: 10, trackDevicePending: true });

    await t.step('each category is counted by kind, and the reading writes nothing', async () => {
      const seen: string[] = [];
      const subscription = await vfs.subscribe!(() => ADMIN_ACCESS, (event) => {
        if (event.path.startsWith(STAGING)) seen.push(`${event.type} ${event.path}`);
      });
      let status: StagingStatus;
      try {
        status = await client.execJson<StagingStatus>('staging status --user anna');
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        await subscription.unsubscribe();
      }
      assertEquals(seen, []);

      assertEquals([status.initialized, status.routesWaiting], [true, 1]);
      assertEquals(status.categories.map((category) => category.name), ['inbox', 'scans']);
      const [inbox, scans] = status.categories;
      assertEquals(inbox.counts, { files: 4, other: 1, indexing: 1, indexed: 2, undated: 1, bytes: 1310, copies: { library: 1, inbox: 1 }, near: { library: 0, inbox: 0 } });
      assertEquals(inbox.albumsPath, `${STAGING}/albums/inbox`);
      assertEquals([inbox.label, inbox.kind, inbox.destination, inbox.organizer], ['Inbox', 'inbox', null, null]);
      assertMatch(inbox.uploadPath, new RegExp(`^${STAGING}/files/inbox/upload-\\d{4}-\\d{2}-\\d{2}$`));

      assertEquals(scans.counts, { files: 1, other: 0, indexing: 0, indexed: 1, undated: 1, bytes: 3000, copies: { library: 0, inbox: 0 }, near: { library: 0, inbox: 0 } });
      assertEquals(scans.settings, {
        kind: 'scans',
        label: 'Box 3',
        destinationId: (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/family/prints`)).id,
        group: { strategy: 'folders', significance: 'normal' },
        time: { digitized: true, filenameDates: false },
        lane: 'bulk',
        sidecars: 'pair',
      });
      const destination = scans.destination!;
      assertEquals([destination.path, destination.title, destination.count, destination.writable], [`${ALBUMS_ROOT}/family/prints`, 'Family prints', 12, true]);
    });

    await t.step('a destination that is gone reads as none', async () => {
      await cmd.shouldSucceed(`rm -r ${ALBUMS_ROOT}/family/prints`);
      const status = await client.execJson<StagingStatus>('staging status --user anna');
      assertEquals(status.categories[1].destination, null);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
