/**
 * PG tier: `staging retime` of 2,000 staged photos reads and writes a page of files at a time, never
 * a file at a time: its statements per page do not grow with the files on it, and a second run,
 * which has nothing to change, reads the same pages and writes nothing. Gated by EIN_TEST_PG.
 *
 * The photos are invented, named the way a phone names them, with tags that hold no date.
 */
import type { StagingRetimeAnswer } from '@archive/staging/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, pgTest, pgTestContext, SystemTestHarness, testCommands } from '@ein/testing';

const FILES = '/home/admin/staging/files';

pgTest('staging retime of 2,000 photos takes a few statements per page', async (t) => {
  const ctx = pgTestContext();
  const harness = new SystemTestHarness({ ssh: false, modules: ['archive'], pg: { pool: ctx.pool, prefix: ctx.prefix } });
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  /** The statements a call makes, by their first words; the queue's fanout, which runs apart from the call, left out. */
  let counting: Record<string, number> | undefined;
  const patched = new WeakSet<object>();
  ctx.pool.on('acquire', (client) => {
    if (patched.has(client)) return;
    patched.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? '';
      if (counting && !text.includes(`${ctx.prefix}_queues`)) {
        const key = text.replace(/\s+/g, ' ').trim().replaceAll(ctx.prefix, 'T').slice(0, 60);
        counting[key] = (counting[key] ?? 0) + 1;
      }
      return query(...args);
    };
  });
  const total = (calls: Record<string, number>) => Object.values(calls).reduce((sum, n) => sum + n, 0);
  const retime = async (category: string): Promise<{ answer: StagingRetimeAnswer; calls: Record<string, number> }> => {
    counting = {};
    try {
      return { answer: await client.execJson<StagingRetimeAnswer>(`staging retime ${category}`), calls: counting };
    } finally {
      counting = undefined;
    }
  };

  /** `count` indexed photos in category `category`, in folders of 250. */
  const seed = async (category: string, count: number) => {
    await cmd.shouldSucceed(`staging category ${category} --create --kind phone`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const props = { uid: home.props.uid, gid: home.props.gid, mode: 0o600 };
    for (let folder = 0; folder * 250 < count; folder++) {
      await cmd.shouldSucceed(`mkdir -p ${FILES}/${category}/day-${folder}`);
      await vfs.createTree<Record<string, unknown>>(
        ADMIN_ACCESS,
        `${FILES}/${category}/day-${folder}`,
        Array.from({ length: Math.min(250, count - folder * 250) }, (_, i) => ({
          type: 'file',
          name: `IMG_2019${String(folder + 1).padStart(2, '0')}01_12${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}.jpg`,
          props,
          attrs: { mimetype: 'image/jpeg', size: 10, indexedAt: '2026-10-18T00:00:00Z' },
          children: [{
            type: 'directory',
            name: 'metadata',
            props,
            children: [{ type: 'exif', name: 'exif', props, attrs: { indexedAt: '2026-10-18T00:00:00Z', when: {} } }],
          }],
        })),
      );
    }
  };

  try {
    await cmd.shouldSucceed('staging init');
    await seed('few', 500);
    await seed('many', 2000);

    await t.step('each page of files is read and written in a few statements, whatever it holds', async () => {
      const few = await retime('few');
      const many = await retime('many');
      assertEquals([few.answer.scanned, few.answer.bySource], [500, { name: 500 }]);
      assertEquals([many.answer.scanned, many.answer.retimed, many.answer.bySource], [2000, 2000, { name: 2000 }]);
      // 2,000 photos are four pages of the 500 one page holds.
      assert(total(many.calls) <= total(few.calls) * 4 + 20, `2,000 photos took ${total(many.calls)} statements, 500 took ${total(few.calls)}`);
      assert(total(few.calls) < 100, `500 photos took ${total(few.calls)} statements: ${JSON.stringify(few.calls)}`);
    });

    await t.step('a second run changes nothing, and reads only its pages', async () => {
      const again = await retime('many');
      assertEquals([again.answer.scanned, again.answer.policyChanged, again.answer.retimed], [2000, 0, 0]);
      assert(total(again.calls) < 40, `a second run took ${total(again.calls)} statements: ${JSON.stringify(again.calls)}`);
    });
  } finally {
    client.close();
    await harness.stop();
    await ctx.teardown();
  }
});
