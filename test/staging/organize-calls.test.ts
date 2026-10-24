/**
 * PG tier: `staging organize` reads a category in batches, never a file at a time: planning a
 * category of 400 photos makes the same statements, as many of each, as planning one of 50 in the
 * same number of groups, and a full build of either then writes in a few statements per group. An
 * incremental run after a photo arrives makes the same statements in either, and a run of an empty
 * category reads nothing of the library (ein/core#655). Gated by EIN_TEST_PG.
 *
 * The photos are invented: ten quiet days of one photo and five busy days per category, each
 * day its own event.
 */
import type { StagingOrganizeReport } from '@archive/staging/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, pgTest, pgTestContext, SystemTestHarness, testCommands } from '@ein/testing';

const FILES = '/home/admin/staging/files';

pgTest('staging organize reads as many statements for 400 photos as for 50', async (t) => {
  const ctx = pgTestContext();
  const harness = new SystemTestHarness({ ssh: false, modules: ['archive'], pg: { pool: ctx.pool, prefix: ctx.prefix } });
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  /** The statements a call makes, by their first words; the queue's fanout, which runs apart from the call, left out. */
  let counting: Record<string, number> | undefined;
  // Every client as it is handed out, those the harness opened before this test too.
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
  const callsDuring = async (fn: () => Promise<void>): Promise<Record<string, number>> => {
    counting = {};
    try {
      await fn();
      return counting;
    } finally {
      counting = undefined;
    }
  };

  /** Ten quiet days of one photo and five busy days of `perDay` photos each in the category `category`, indexed. */
  const seed = async (category: string, perDay: number) => {
    await cmd.shouldSucceed(`staging category ${category} --create --kind generic && mkdir -p ${FILES}/${category}/upload`);
    const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
    const photo = (name: string, at: string) => ({
      type: 'file',
      name,
      props: { uid: home.props.uid, gid: home.props.gid, mode: 0o640 },
      attrs: { mimetype: 'image/jpeg', size: 10, takenAt: at.replace('Z', ''), takenAtUtc: at, indexedAt: '2026-10-18T00:00:00Z', facesAt: '2026-10-18T00:00:00Z' },
    });
    await vfs.createTree(ADMIN_ACCESS, `${FILES}/${category}/upload`, [
      ...Array.from({ length: 10 }, (_, day) => photo(`q${day}.jpg`, `2019-03-${String(day + 1).padStart(2, '0')}T12:00:00Z`)),
      ...Array.from(
        { length: 5 },
        (_, day) =>
          Array.from(
            { length: perDay },
            (_, i) =>
              photo(`d${day}-${i}.jpg`, new Date(Date.parse(`2019-05-${String(4 + day * 5).padStart(2, '0')}T08:00:00Z`) + i * 60_000).toISOString().replace('.000', '')),
          ),
      ).flat(),
    ]);
  };

  const organize = (category: string, dryRun: boolean) => async () => {
    const [result] = (await client.execJson<StagingOrganizeReport>(`staging organize ${category}${dryRun ? ' --dry-run' : ''}`)).results;
    assertEquals([result.error, result.byKind.event], [undefined, 5]);
  };

  try {
    await cmd.shouldSucceed('staging init');
    await seed('few', 10);
    await seed('many', 80);

    await t.step('planning reads alike, whatever the number of photos', async () => {
      // Once each first, so the paths both walk are known to the store alike.
      await organize('many', true)();
      await organize('few', true)();
      assertEquals(await callsDuring(organize('many', true)), await callsDuring(organize('few', true)));
    });

    await t.step('a full build writes a few statements per group, not per photo', async () => {
      const [few, many] = [await callsDuring(organize('few', false)), await callsDuring(organize('many', false))];
      const total = (calls: Record<string, number>) => Object.values(calls).reduce((sum, n) => sum + n, 0);
      assert(total(many) < total(few) * 1.5, `400 photos took ${total(many)} statements, 50 took ${total(few)}`);
    });

    await t.step('an incremental run reads what changed, alike whatever the number of photos', async () => {
      const home = await vfs.get(ADMIN_ACCESS, '/home/admin');
      const incremental = (category: string) => async () => {
        const [result] = (await client.execJson<StagingOrganizeReport>(`staging organize ${category}`)).results;
        assertEquals([result.error, result.mode, result.items], [undefined, 'incremental', 1]);
      };
      for (const category of ['few', 'many']) {
        await vfs.createTree(ADMIN_ACCESS, `${FILES}/${category}/upload`, [{
          type: 'file',
          name: 'late.jpg',
          props: { uid: home.props.uid, gid: home.props.gid, mode: 0o640 },
          attrs: {
            mimetype: 'image/jpeg',
            size: 10,
            takenAt: '2019-08-01T12:00:00',
            takenAtUtc: '2019-08-01T12:00:00Z',
            indexedAt: '2026-10-18T00:00:00Z',
            facesAt: '2026-10-18T00:00:00Z',
          },
        }]);
      }
      assertEquals(await callsDuring(incremental('many')), await callsDuring(incremental('few')));
    });

    await t.step('an empty category reads nothing of the library', async () => {
      await cmd.shouldSucceed('staging category none --create --kind generic');
      const aggregate = vfs.aggregate.bind(vfs);
      const read: string[][] = [];
      vfs.aggregate = (access, query) => {
        read.push(query.types ?? []);
        return aggregate(access, query);
      };
      try {
        for (const flags of ['--full', '']) {
          const [result] = (await client.execJson<StagingOrganizeReport>(`staging organize none ${flags}`)).results;
          assertEquals([result.error, result.items], [undefined, 0]);
        }
      } finally {
        vfs.aggregate = aggregate;
      }
      assertEquals(read.filter((types) => types.includes('media-region')), []);
    });
  } finally {
    client.close();
    await harness.stop();
    await ctx.teardown();
  }
});
