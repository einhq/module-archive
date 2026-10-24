/**
 * PG tier: the near check reads the embedding index, not the archive. Over thousands of library
 * fingerprints its nearest-neighbour lookup is an HNSW index scan — as planned for its literal
 * vector and as a prepared statement's generic plan — every planted look-alike is found, and a
 * whole check (`duplicates --record` of one staged picture) takes a bounded handful of statements
 * and milliseconds. Gated by EIN_TEST_PG.
 *
 * The photos and their fingerprints are invented: random 512-dimension directions, as SSCD's are,
 * and staged copies a little turned away from some of them.
 */
import type { DuplicateFinding } from '@archive/media/api';
import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, pgTest, pgTestContext, SystemTestHarness, testCommands } from '@ein/testing';

const DIMENSIONS = 512;
const LIBRARY = 4_000;
const PLANTED = 40;
const UPLOAD = '/home/admin/staging/files/inbox/upload-2026-10-01';

/** A seeded generator, so every run invents the same fingerprints. */
const random = (() => {
  let seed = 11;
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
})();
const direction = () => Array.from({ length: DIMENSIONS }, random);
/** `base` with noise: about 0.9 alike. */
const copyOf = (base: number[]) => base.map((value) => value + random() * 0.48);

/** A photo's node with its fingerprint's embedding node under `metadata/`, as `createTree` takes them. */
const photo = (name: string, attrs: Record<string, unknown>) => ({
  type: 'file',
  name,
  attrs: { mimetype: 'image/jpeg', size: 1_000, width: 4000, height: 3000, takenAtSource: 'name', fingerprintedAt: '2026-10-01T00:00:00Z', ...attrs },
  children: [{
    type: 'directory',
    name: 'metadata',
    children: [{ type: 'embedding', name: 'sscd-image', attrs: { embeddingType: 'sscd-image', capacity: DIMENSIONS } }],
  }],
});

pgTest('a near check is an HNSW lookup that finds every planted look-alike in a few milliseconds', async (t) => {
  const ctx = pgTestContext();
  const harness = new SystemTestHarness({ ssh: false, modules: ['archive'], pg: { pool: ctx.pool, prefix: ctx.prefix, embeddings: true } });
  const { vfs } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const cmd = testCommands(client);

  let counting: number | undefined;
  ctx.pool.on('connect', (pooled) => {
    const query = pooled.query.bind(pooled) as (...args: unknown[]) => unknown;
    (pooled as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? '';
      if (counting !== undefined && !text.includes(`${ctx.prefix}_queues`)) counting++;
      return query(...args);
    };
  });

  try {
    await cmd.shouldSucceed(`staging init && mkdir -p ${ALBUMS_ROOT}/big/files ${UPLOAD}`);
    const vectors = Array.from({ length: LIBRARY }, direction);
    const library = await vfs.createTree(
      ADMIN_ACCESS,
      `${ALBUMS_ROOT}/big/files`,
      vectors.map((_, i) => photo(`IMG_${i}.jpg`, { sha256: `library-${i}` })),
    );
    const staged = await vfs.createTree(
      ADMIN_ACCESS,
      UPLOAD,
      Array.from({ length: PLANTED }, (_, i) => photo(`IMG_${i}-small.jpg`, { sha256: `staged-${i}`, width: 2000, height: 1500 })),
    );
    // The vectors go in with one statement, as writing them one embedding node at a time would
    // take as long as the rest of the test.
    const printIds = async (paths: string[]) => (await Promise.all(paths.map((path) => vfs.get(ADMIN_ACCESS, `${path}/metadata/sscd-image`)))).map((node) => node.id);
    const libraryPrints = await printIds(vectors.map((_, i) => `${ALBUMS_ROOT}/big/files/IMG_${i}.jpg`));
    const stagedPrints = await printIds(Array.from({ length: PLANTED }, (_, i) => `${UPLOAD}/IMG_${i}-small.jpg`));
    const table = (await ctx.pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE tablename LIKE $1`, [`${ctx.prefix}%sscd_image_data`])).rows[0]
      ?.tablename;
    assert(table, 'the registry made the type its table');
    await ctx.pool.query(`INSERT INTO ${table} (id, embedding) SELECT * FROM unnest($1::varchar[], $2::text[]::halfvec[])`, [
      [...libraryPrints, ...stagedPrints],
      [...vectors, ...vectors.slice(0, PLANTED).map(copyOf)].map((vector) => JSON.stringify(vector)),
    ]);
    await ctx.pool.query(`ANALYZE ${table}`);
    assertEquals(library.length + staged.length, LIBRARY + PLANTED);

    await t.step('the lookup is an index scan, for its literal and as a generic plan', async () => {
      const node = (plan: Record<string, unknown>): string[] => [
        `${plan['Node Type']}${plan['Index Name'] ? ` ${plan['Index Name']}` : ''}`,
        ...((plan.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(node),
      ];
      const literal = JSON.stringify(vectors[0]);
      const explained = await ctx.pool.query(`EXPLAIN (FORMAT JSON) SELECT id, embedding <=> $1::halfvec AS dist FROM ${table} ORDER BY embedding <=> $1::halfvec LIMIT 31`, [
        literal,
      ]);
      const generic = await ctx.pool.query(
        `EXPLAIN (GENERIC_PLAN, FORMAT JSON) SELECT id, embedding <=> $1::halfvec AS dist FROM ${table} ORDER BY embedding <=> $1::halfvec LIMIT $2`,
      );
      for (const result of [explained, generic]) {
        const steps = node((result.rows[0]['QUERY PLAN'] as { Plan: Record<string, unknown> }[])[0].Plan);
        assertEquals(steps, ['Limit', `Index Scan ${table}_hnsw_idx`]);
      }
    });

    await t.step('every planted look-alike is found, each check a bounded number of statements', async () => {
      await cmd.shouldSucceed(`duplicates --record ${UPLOAD}`);
      const times: number[] = [];
      const statements: number[] = [];
      let found = 0;
      for (let i = 0; i < PLANTED; i++) {
        const path = `${UPLOAD}/IMG_${i}-small.jpg`;
        // Checked again with its look-alike gone from its finding, so the check writes as it would the first time.
        await vfs.update(ADMIN_ACCESS, path, { attrs: { duplicate: { inbox: 'admin', sha256: `staged-${i}`, at: '2026-10-01T00:00:00Z' } } });
        counting = 0;
        const started = performance.now();
        await cmd.shouldSucceed(`duplicates --record ${path}`);
        times.push(performance.now() - started);
        statements.push(counting);
        counting = undefined;
        const finding = (await vfs.get(ADMIN_ACCESS, path)).attrs.duplicate as DuplicateFinding;
        if (finding.peers?.some((peer) => peer.id === library[i].id)) found++;
      }
      assertEquals(found, PLANTED, 'recall');
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(0.95 * times.length)];
      console.log(`near check over ${LIBRARY} prints: p50 ${times[times.length >> 1].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, statements ${Math.max(...statements)}`);
      // The whole command, its spawn included; the index's own lookup is a millisecond or two.
      assert(p95 < 500, `p95 ${p95.toFixed(1)} ms`);
      assert(Math.max(...statements) <= 80, `at most ${Math.max(...statements)} statements`);
    });
  } finally {
    client.close();
    await harness.stop();
    await ctx.teardown();
  }
});
