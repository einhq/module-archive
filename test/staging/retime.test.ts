/**
 * `staging retime`: staged media originals are stamped with their category's time rules and dated
 * again where the stamps change; a dry run writes nothing and a second run nothing more. A batch
 * moved from a phone category into a scans category is announced by the bridge's rules, and the
 * retime they start takes its dates off; moved back, they are restored. A scan filed into the
 * library stays undated through `media-resolve-time`, its `digitized` going with it.
 *
 * The files are invented and their exif nodes written by hand, as `exif-extract` leaves them.
 */
import { ALBUMS_ROOT } from '@archive/paths';
import { type ArchiveRuleContext, deriveArchiveEvents } from '@archive/event-rules';
import type { StagingRetimeAnswer } from '@archive/staging/api';
import { STAGING_EVENTS } from '@archive/staging/facts';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const FILES = '/home/admin/staging/files';
const PHONE = `${FILES}/phone/trip`;
const SCANS = `${FILES}/scans/trip`;

type Attrs = { takenAt?: string; takenAtSource?: string; digitized?: boolean; whenName?: string };

Deno.test({ name: 'staging retime', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const attrsOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs as Attrs;
  const retime = (args: string) => client.execJson<StagingRetimeAnswer>(`staging retime ${args}`);
  /** The retime facts the bridge derives from a move of the directory `from` to `to`. */
  const announced = async (from: string, to: string): Promise<string[]> => {
    const ctx: ArchiveRuleContext = {
      getNode: async (path) => {
        const node = await vfs.get(ADMIN_ACCESS, path).catch(() => undefined);
        return node && { id: node.id, type: node.type, attrs: node.attrs as Record<string, unknown> };
      },
      exists: (path) => vfs.exists(ADMIN_ACCESS, path),
      getLink: () => Promise.resolve(undefined),
      hasPoint: () => Promise.resolve(false),
    };
    const node = await vfs.get(ADMIN_ACCESS, to);
    const facts = await deriveArchiveEvents({ type: 'moved', path: to, fromPath: from, nodeId: node.id, nodeType: 'directory', timestamp: 1 }, ctx, 1);
    return facts.filter((fact) => fact.type === STAGING_EVENTS.retimeRequested).map((fact) => fact.subject);
  };

  try {
    await cmd.shouldSucceed('staging init');
    await cmd.shouldSucceed('staging category phone --create --kind phone && staging category scans --create --kind scans');
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const props = { uid: home.props.uid, gid: home.props.gid, mode: 0o600 };
    /** A photo indexed with the camera clock `device` (none: its tags hold no date). */
    const photo = (name: string, device?: string) => ({
      type: 'file',
      name,
      props,
      attrs: {
        mimetype: 'image/jpeg',
        size: 10,
        indexedAt: '2026-10-18T00:00:00Z',
        ...(device ? { takenAt: device, takenAtUtc: `${device}Z`, takenAtSource: 'device' } : {}),
      },
      children: [{
        type: 'directory',
        name: 'metadata',
        props,
        children: [{
          type: 'exif',
          name: 'exif',
          props,
          attrs: {
            indexedAt: '2026-10-18T00:00:00Z',
            when: device
              ? {
                device: {
                  year: device.slice(0, 4),
                  month: device.slice(5, 7),
                  day: device.slice(8, 10),
                  hour: device.slice(11, 13),
                  minute: device.slice(14, 16),
                  second: device.slice(17, 19),
                },
              }
              : {},
          },
        }],
      }],
    });
    await cmd.shouldSucceed(`mkdir -p ${PHONE}`);
    await vfs.createTree<Record<string, unknown>>(ADMIN_ACCESS, PHONE, [
      // Its tags hold no date, its name does.
      photo('IMG_20190601_123456.jpg'),
      // Its camera clock dates it; its name spells nothing.
      photo('DSC_0001.jpg', '2018-05-01T10:00:00'),
      // No date anywhere.
      photo('IMG_0002.jpg'),
      { type: 'file', name: 'notes.txt', props, attrs: { mimetype: 'text/plain', size: 5 } },
    ]);

    await t.step('a dry run counts what it would do and writes nothing', async () => {
      const answer = await retime('phone --dry-run');
      assertEquals(answer, {
        ok: true,
        dryRun: true,
        user: 'admin',
        path: `${FILES}/phone`,
        scanned: 3,
        policyChanged: 1,
        retimed: 1,
        cleared: 0,
        bySource: { name: 1 },
        failed: [],
      });
      assertEquals(await attrsOf(`${PHONE}/IMG_20190601_123456.jpg`), { mimetype: 'image/jpeg', size: 10, indexedAt: '2026-10-18T00:00:00Z' } as Attrs);
    });

    await t.step('a run stamps and dates them, and a second one changes nothing', async () => {
      const answer = await retime('phone');
      assertEquals([answer.scanned, answer.policyChanged, answer.retimed, answer.bySource], [3, 1, 1, { name: 1 }]);
      const named = await attrsOf(`${PHONE}/IMG_20190601_123456.jpg`);
      assertEquals([named.whenName, named.takenAt, named.takenAtSource], ['2019-06-01T12:34:56', '2019-06-01T12:34:56', 'name']);
      assertEquals((await attrsOf(`${PHONE}/DSC_0001.jpg`)).takenAtSource, 'device');

      const modtime = (await vfs.get(ADMIN_ACCESS, `${PHONE}/IMG_20190601_123456.jpg`)).props.modtime;
      const again = await retime(PHONE);
      assertEquals([again.path, again.scanned, again.policyChanged, again.retimed], [PHONE, 3, 0, 0]);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${PHONE}/IMG_20190601_123456.jpg`)).props.modtime, modtime);
    });

    await t.step('moved into scans, the batch is announced and its retime takes every date off', async () => {
      await cmd.shouldSucceed(`mv ${PHONE} ${FILES}/scans/`);
      const subjects = await announced(PHONE, SCANS);
      assertEquals(subjects, [SCANS]);
      const answer = await retime(subjects[0]);
      assertEquals([answer.scanned, answer.policyChanged, answer.retimed, answer.cleared], [3, 3, 2, 2]);
      for (const name of ['IMG_20190601_123456.jpg', 'DSC_0001.jpg', 'IMG_0002.jpg']) {
        const attrs = await attrsOf(`${SCANS}/${name}`);
        assertEquals([attrs.digitized, attrs.whenName, attrs.takenAt], [true, undefined, undefined], name);
      }
    });

    await t.step('moved back, the dates are restored', async () => {
      await cmd.shouldSucceed(`mv ${SCANS} ${FILES}/phone/`);
      assertEquals(await announced(SCANS, PHONE), [PHONE]);
      const answer = await retime(PHONE);
      assertEquals([answer.retimed, answer.bySource], [2, { name: 1, device: 1 }]);
      assertEquals((await attrsOf(`${PHONE}/DSC_0001.jpg`)).takenAt, '2018-05-01T10:00:00');
      assertEquals((await attrsOf(`${PHONE}/IMG_20190601_123456.jpg`)).digitized, undefined);
    });

    await t.step('a move between categories with the same rules is not announced', async () => {
      await cmd.shouldSucceed('staging category phone-2 --create --kind messaging');
      await cmd.shouldSucceed(`mv ${PHONE} ${FILES}/phone-2/`);
      assertEquals(await announced(PHONE, `${FILES}/phone-2/trip`), []);
      await cmd.shouldSucceed(`mv ${FILES}/phone-2/trip ${FILES}/phone/`);
    });

    await t.step('a scan filed into the library stays undated through media-resolve-time', async () => {
      await cmd.shouldSucceed(`mv ${PHONE} ${FILES}/scans/ && staging retime ${SCANS}`);
      const album = `${ALBUMS_ROOT}/prints`;
      await cmd.shouldSucceed(`mkdir -p ${album} && mv ${SCANS}/DSC_0001.jpg ${album}/`);
      await cmd.shouldSucceed(`media-resolve-time --under ${album}`);
      const filed = await attrsOf(`${album}/DSC_0001.jpg`);
      assertEquals([filed.digitized, filed.takenAt], [true, undefined]);
    });

    await t.step('a path outside staging, a category that is not there, or two scopes are refused', async () => {
      await cmd.shouldFailWith(`staging retime ${ALBUMS_ROOT}/prints`, 'not a category');
      await cmd.shouldFailWith('staging retime nothing-here', 'no category nothing-here');
      await cmd.shouldFailWith('staging retime a b', 'takes one category');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
