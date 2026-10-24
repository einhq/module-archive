/**
 * PG tier: `staging dedupe --apply` and `staging undo` of it read and write a call's sets
 * together: they make the same statements, as many of each, to resolve 8 sets as to resolve 32,
 * and to undo them, so a call costs a few round trips per batch of files and none per set. Gated
 * by EIN_TEST_PG.
 *
 * The photos are invented: pairs of files with the same checksum, each with an empty
 * `metadata/exif` child, recorded with `duplicates --record`.
 */
import type { DuplicateResolveResult } from '@archive/media/api';
import type { StagingUndoResult } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, pgTest, pgTestContext, SystemTestHarness, testCommands } from '@ein/testing';

const FILES = '/home/admin/staging/files';

pgTest('staging dedupe --apply and undo make as many statements for 32 sets as for 8', async (t) => {
  const ctx = pgTestContext();
  const harness = new SystemTestHarness({ ssh: false, modules: ['archive'], pg: { pool: ctx.pool, prefix: ctx.prefix } });
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  /** The statements the call makes, by their first words; the queue's fanout, which runs apart from the call, left out. */
  let counting: Record<string, number> | undefined;
  ctx.pool.on('connect', (client) => {
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

  /** `sets` pairs of copies in the category `category`. */
  const seed = async (category: string, sets: number) => {
    await cmd.shouldSucceed(`staging category ${category} --create --kind generic && mkdir -p ${FILES}/${category}/seed`);
    await vfs.createTree(
      ADMIN_ACCESS,
      `${FILES}/${category}/seed`,
      Array.from({ length: sets }, (_, i) =>
        ['o', 'c'].map((prefix) => ({
          type: 'file',
          name: `${prefix}${i}.jpg`,
          attrs: { mimetype: 'image/jpeg', size: 10, sha256: `${category}-${i}`, indexedAt: '2026-10-18T00:00:00Z' },
          children: [{ type: 'directory', name: 'metadata', children: [{ type: 'directory', name: 'exif' }] }],
        }))).flat(),
    );
    await cmd.shouldSucceed(`duplicates --record ${FILES}/${category}`);
  };

  try {
    await cmd.shouldSucceed('staging init && mkdir -p /home/admin/.trash');
    await seed('few', 8);
    await seed('many', 32);

    const journals: Record<string, string> = {};
    const apply = (category: string, sets: number) => async () => {
      const answer = await client.execJson<DuplicateResolveResult>(`staging dedupe ${category} --apply --where inbox`);
      assertEquals([answer.resolved, answer.discarded, answer.more], [sets, sets, false]);
      journals[category] = answer.journal!;
    };
    const undo = (category: string, sets: number) => async () => {
      const answer = await client.execJson<StagingUndoResult>(`staging undo ${journals[category]}`);
      assertEquals([answer.restoredFiles, answer.failed], [sets, []]);
    };

    await t.step('resolving', async () => {
      assertEquals(await callsDuring(apply('many', 32)), await callsDuring(apply('few', 8)));
    });

    await t.step('undoing', async () => {
      assertEquals(await callsDuring(undo('many', 32)), await callsDuring(undo('few', 8)));
    });

    await t.step('the copies are back, each a copy again', async () => {
      const page = await client.execJson<{ total: number }>('staging duplicates --counts');
      assertEquals(page.total, 40);
    });
  } finally {
    client.close();
    await harness.stop();
    await ctx.teardown();
  }
});
