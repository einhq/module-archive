/**
 * `staging check` finds each way a staging area breaks its rules, and changes nothing: a staging
 * area just set up has no problems, and every break made by hand below is named by its code.
 */
import type { StagingCheckAnswer } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const STAGING = '/home/anna/staging';
const FILES = `${STAGING}/files`;
const ALBUMS = `${STAGING}/albums`;

Deno.test({ name: 'staging check', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const check = () => client.execJson<StagingCheckAnswer>('staging check --user anna');
  try {
    await cmd.shouldSucceed('user-create anna --uid 3700');

    await t.step('it reads one user at a time', async () => {
      await cmd.shouldFailWith('staging check --all', '--all is only for init, organize, match and duplicates --repair');
    });

    await t.step('a staging area not set up is missing', async () => {
      const answer = await check();
      assertEquals([answer.ok, answer.problems.map((problem) => `${problem.code} ${problem.path}`)], [false, [`missing ${STAGING}`]]);
    });

    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed(`staging category scans --user anna --create --kind scans`);
    await cmd.shouldSucceed(`mkdir -p ${FILES}/inbox/batch ${FILES}/scans/box`);
    for (const path of [`${FILES}/inbox/batch/a.jpg`, `${FILES}/inbox/batch/b.jpg`, `${FILES}/scans/box/scan.tif`]) {
      await cmd.shouldSucceed(`mknode -t file ${path} --as mimetype=image/jpeg`);
    }
    await cmd.shouldSucceed(`mknode -t album ${ALBUMS}/inbox/day --as origin=auto`);
    await cmd.shouldSucceed(`ln -s ${FILES}/inbox/batch/a.jpg ${ALBUMS}/inbox/day/a.jpg && ln -s ${FILES}/inbox/batch/a.jpg ${ALBUMS}/inbox/day/coverPhoto`);

    await t.step('a staging area as init leaves it has no problems', async () => {
      const answer = await check();
      assertEquals([answer.ok, answer.problems, answer.checkedLinks, answer.truncated], [true, [], 2, false]);
    });

    await t.step('each break is named, and nothing is changed', async () => {
      await cmd.shouldSucceed(`chmod 0755 ${FILES}/inbox`);
      await cmd.shouldSucceed(`mknode -t file ${FILES}/loose.jpg --as mimetype=image/jpeg`);
      await cmd.shouldSucceed(`mkdir ${ALBUMS}/gone`);
      await cmd.shouldSucceed(`ln -s ${FILES}/scans/box/scan.tif ${ALBUMS}/inbox/day/scan.tif`);
      await cmd.shouldSucceed(`ln -s ${FILES}/inbox/batch/b.jpg ${ALBUMS}/inbox/day/b.jpg && rm ${FILES}/inbox/batch/b.jpg`);
      await cmd.shouldSucceed(`mknode -t file ${FILES}/inbox/batch/hike.gpx --as mimetype=application/gpx+xml`);
      await vfs.update(ADMIN_ACCESS, `${FILES}/inbox/batch/hike.gpx`, { attrs: { trackDevicePending: true } });
      await cmd.shouldSucceed(`rm -r ${STAGING}/journal`);

      const answer = await check();
      assertEquals(answer.ok, false);
      assertEquals(answer.problems.map((problem) => `${problem.code} ${problem.path}`).sort(), [
        `cross-category ${ALBUMS}/inbox/day/scan.tif`,
        `dangling-link ${ALBUMS}/inbox/day/b.jpg`,
        `loose-entry ${FILES}/loose.jpg`,
        `missing ${STAGING}/journal`,
        `mode ${FILES}/inbox`,
        `orphan-albums ${ALBUMS}/gone`,
        `waiting-route ${FILES}/inbox/batch/hike.gpx`,
      ]);
      assertEquals((await vfs.get(ADMIN_ACCESS, `${FILES}/inbox`)).props.mode & 0o777, 0o755);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${FILES}/loose.jpg`), true);
    });

    await t.step('init repairs what is the layout’s, and check then finds only the links', async () => {
      await cmd.shouldSucceed('staging init --user anna');
      const answer = await check();
      assertEquals(answer.problems.map((problem) => problem.code).sort(), ['cross-category', 'dangling-link', 'orphan-albums']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
