/** Album-local photo stacks: rolling adjacency, reversible fronts/exclusions and linked albums. */

import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import type { AlbumMediaStacks } from '@archive/media/media-stacks';

const testCtx = createTestContext({ modules: ['archive'], rootMount: true });
const A = Array(64).fill(1);
const B = A.map((value, index) => index < 3 ? -value : value);
const C = A.map((value, index) => index < 6 ? -value : value);

Deno.test({
  name: 'album-stack command',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const album = async (name: string) => {
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, name, { attrs: { name } });
    return await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/${name}`);
  };
  const photo = async (path: string, takenAt: string, vector: number[]) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', takenAt: takenAt.replace(/Z$/, ''), takenAtUtc: takenAt } });
    await cmd.shouldSucceed(`mkdir -p ${path}/metadata`);
    await cmd.shouldSucceed(`mknode -t embedding ${path}/metadata/sscd-image --as embeddingType=sscd-image --an capacity=64 --as computedAt=2026-08-30T00:00:00Z`);
    const handle = await vfs.open(ADMIN_ACCESS, `${path}/metadata/sscd-image`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
    return await vfs.get(ADMIN_ACCESS, path);
  };

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}`);
    const burst = await album('burst');
    const a = await photo(`${ALBUMS_ROOT}/burst/a.jpg`, '2020-01-01T12:00:00Z', A);
    const b = await photo(`${ALBUMS_ROOT}/burst/b.jpg`, '2020-01-01T12:00:09Z', B);
    const c = await photo(`${ALBUMS_ROOT}/burst/c.jpg`, '2020-01-01T12:00:18Z', C);
    const late = await photo(`${ALBUMS_ROOT}/burst/late.jpg`, '2020-01-01T12:00:29Z', C);

    await t.step('dry-run finds a rolling chain without writing', async () => {
      const result = await client.execJson<{ changed: number; groups: number; stackedPhotos: number }>(
        `album-stack refresh ${ALBUMS_ROOT}/burst --dry-run`,
      );
      assertEquals(result.changed, 1);
      assertEquals(result.groups, 1);
      assertEquals(result.stackedPhotos, 3);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks, undefined);
    });

    await t.step('refresh persists ids and materializes links without moving originals', async () => {
      await cmd.shouldSucceed(`album-stack refresh ${ALBUMS_ROOT}/burst`);
      const manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, [{ frontId: a.id, memberIds: [a.id, b.id, c.id] }]);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg`));
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/b.jpg`));
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}/b.jpg`, { follow: false }));
      assertEquals((await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}/b.jpg`, { follow: false })).props.softlink, `${ALBUMS_ROOT}/burst/b.jpg`);
    });

    await t.step('threshold is inclusive and unchanged runs repair interrupted materialization', async () => {
      const atBoundary = await client.execJson<{ groups: number }>(`album-stack refresh ${ALBUMS_ROOT}/burst --threshold 0.90625 --dry-run`);
      const aboveBoundary = await client.execJson<{ groups: number }>(`album-stack refresh ${ALBUMS_ROOT}/burst --threshold 0.90626 --dry-run`);
      assertEquals(atBoundary.groups, 1);
      assertEquals(aboveBoundary.groups, 0);

      const unchanged = await client.execJson<{ changed: number }>(`album-stack refresh ${ALBUMS_ROOT}/burst`);
      assertEquals(unchanged.changed, 0);
      await cmd.shouldSucceed(`rm -rf ${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}`);
      const repairPreview = await client.execJson<{ changed: number }>(`album-stack refresh ${ALBUMS_ROOT}/burst --dry-run`);
      assertEquals(repairPreview.changed, 1);
      const repaired = await client.execJson<{ changed: number }>(`album-stack refresh ${ALBUMS_ROOT}/burst`);
      assertEquals(repaired.changed, 1);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}/b.jpg`, { follow: false }));
    });

    await t.step('front replacement is stable and removes the old managed view', async () => {
      await cmd.shouldSucceed(`album-stack front ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/c.jpg`);
      const manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups[0].frontId, c.id);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/c.jpg/stack/${burst.id}/a.jpg`, { follow: false }));
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}`, { follow: false }), false);

      await cmd.shouldSucceed(`album-stack refresh ${ALBUMS_ROOT}/burst`);
      assertEquals(((await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks).groups[0].frontId, c.id);
    });

    await t.step('album-local separation breaks the chain and allow restores it', async () => {
      await cmd.shouldSucceed(`album-stack separate ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/b.jpg`);
      let manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.excludedIds, [b.id]);
      assertEquals(manifest.groups, []);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/c.jpg/stack/${burst.id}`, { follow: false }), false);

      await cmd.shouldSucceed(`album-stack allow ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/b.jpg`);
      manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.excludedIds, []);
      assertEquals(manifest.groups[0].memberIds, [a.id, b.id, c.id]);
    });

    await t.step('a hand-made stack joins an existing one, keeps its front and survives a refresh', async () => {
      // `late` is 11 s after `c`: outside the gap, so never in the chain by itself.
      const stacked = await client.execJson<{ focusPath: string }>(`album-stack stack ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/late.jpg ${ALBUMS_ROOT}/burst/b.jpg`);
      assertEquals(stacked.focusPath, `${ALBUMS_ROOT}/burst/a.jpg`);
      let manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, [{ frontId: a.id, memberIds: [a.id, b.id, c.id, late.id], manual: true }]);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}/late.jpg`, { follow: false }));

      await cmd.shouldSucceed(`album-stack refresh ${ALBUMS_ROOT}/burst`);
      manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, [{ frontId: a.id, memberIds: [a.id, b.id, c.id, late.id], manual: true }]);

      // Keeping the front separate takes it out of the hand-made stack, which moves on
      // to its earliest remaining member; the rest stay as chosen.
      await cmd.shouldSucceed(`album-stack separate ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/a.jpg`);
      manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, [{ frontId: b.id, memberIds: [b.id, c.id, late.id], manual: true }]);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}`, { follow: false }), false);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/b.jpg/stack/${burst.id}/late.jpg`, { follow: false }));

      // Stacking a kept-separate photo is the answer to keeping it separate.
      await cmd.shouldSucceed(`album-stack stack ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/a.jpg ${ALBUMS_ROOT}/burst/c.jpg`);
      manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.excludedIds, []);
      assertEquals(manifest.groups, [{ frontId: b.id, memberIds: [a.id, b.id, c.id, late.id], manual: true }]);

      // Undoing it leaves what similarity finds on its own: the chain, without `late`.
      const unstacked = await client.execJson<{ focusPath: string }>(`album-stack unstack ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/late.jpg`);
      assertEquals(unstacked.focusPath, `${ALBUMS_ROOT}/burst/late.jpg`);
      manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, [{ frontId: a.id, memberIds: [a.id, b.id, c.id] }]);
      await cmd.shouldFail(`album-stack unstack ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/late.jpg`);

      // Back to the hand-made stack, so the later steps see the same album as before.
      await cmd.shouldSucceed(`album-stack stack ${ALBUMS_ROOT}/burst ${ALBUMS_ROOT}/burst/late.jpg ${ALBUMS_ROOT}/burst/b.jpg`);
      manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, [{ frontId: a.id, memberIds: [a.id, b.id, c.id, late.id], manual: true }]);
    });

    await t.step('a linked album gets an independent manifest and managed view', async () => {
      const linked = await album('linked');
      for (const [name, target] of [['one', `${ALBUMS_ROOT}/burst/a.jpg`], ['two', `${ALBUMS_ROOT}/burst/b.jpg`], ['three', `${ALBUMS_ROOT}/burst/c.jpg`]] as const) {
        await vfs.create(ADMIN_ACCESS, 'softlink', `${ALBUMS_ROOT}/linked`, name, {
          props: { uid: 0, gid: 0, mode: 0o777, softlink: target },
        });
      }
      await cmd.shouldSucceed(`album-stack refresh ${ALBUMS_ROOT}/linked`);
      const manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/linked`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups[0].memberIds, [a.id, b.id, c.id]);
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${linked.id}/b.jpg`, { follow: false }));
      // The burst album itself still shows its hand-made stack from `a`, untouched by this one.
      assert(await vfs.exists(ADMIN_ACCESS, `${ALBUMS_ROOT}/burst/a.jpg/stack/${burst.id}`, { follow: false }));
    });

    await t.step('missing fingerprints and non-photos break chains in imported albums', async () => {
      await album('imported');
      await cmd.shouldSucceed(`mkdir ${ALBUMS_ROOT}/imported/files`);
      const first = await photo(`${ALBUMS_ROOT}/imported/files/first.jpg`, '2020-02-01T12:00:00Z', A);
      await cmd.shouldSucceed(`echo x > ${ALBUMS_ROOT}/imported/files/missing.jpg`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/imported/files/missing.jpg`, {
        attrs: { mimetype: 'image/jpeg', takenAt: '2020-02-01T12:00:02', takenAtUtc: '2020-02-01T12:00:02Z' },
      });
      const last = await photo(`${ALBUMS_ROOT}/imported/files/last.jpg`, '2020-02-01T12:00:04Z', A);
      await cmd.shouldSucceed(`echo x > ${ALBUMS_ROOT}/imported/files/clip.mp4`);
      await vfs.update(ADMIN_ACCESS, `${ALBUMS_ROOT}/imported/files/clip.mp4`, {
        attrs: { mimetype: 'video/mp4', takenAt: '2020-02-01T12:00:05', takenAtUtc: '2020-02-01T12:00:05Z' },
      });
      await photo(`${ALBUMS_ROOT}/imported/files/after.jpg`, '2020-02-01T12:00:06Z', A);

      const result = await client.execJson<{ missingFingerprints: number }>(`album-stack refresh ${ALBUMS_ROOT}/imported`);
      assertEquals(result.missingFingerprints, 1);
      const manifest = (await vfs.get(ADMIN_ACCESS, `${ALBUMS_ROOT}/imported`)).attrs.mediaStacks as AlbumMediaStacks;
      assertEquals(manifest.groups, []);
      assertEquals(manifest.excludedIds, []);
      assert(first.id !== last.id);
    });

    await t.step('--all reuses a paged primary-fingerprint index, and leaves the suggestions out', async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'suggested', { attrs: { name: 'suggested', origin: 'auto' } });
      const result = await client.execJson<{ scanned: number; groups: number }>('album-stack refresh --all --dry-run');
      assertEquals(result.scanned, 3);
      assert(result.groups >= 2);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
