/**
 * duplicates: exact (checksum) scans of a subtree and of the whole store, which agree and leave
 * renditions and prints out; single-file lookups; `--against`; fuzzy (fingerprint vectors)
 * single-file lookups and subtree and store-wide clusters, which keep only pairs touching the
 * scope, with every member a copy of every other; for sound, chromaprints written by
 * compute-fingerprint and matched once aligned. And the clusters' linkage and score, whatever
 * order their edges come in.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { startStubEms } from '@ems/testing';
import type { DuplicatePathTag, ExactDuplicateScan, ExactDuplicatesOf, FuzzyDuplicateScan, FuzzyDuplicatesOf } from '@archive/media/api';
import { CHROMAPRINT_MIMETYPE, encodeChromaprint } from '@archive/media/chromaprint';
import { chainedFiles, duplicateClusters } from '@archive/media/duplicate-clusters';

// Keep registries on the VFS mounted at `/`, not on the root returned to
// commands. This is the production boundary that fuzzy search must cross.
const testCtx = createTestContext({ modules: ['archive'], rootMount: true });

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_RENDITION = '7'.repeat(64);

// 64-dim ±1 vectors, where n differing bits give a cosine of 1 - n/32. B differs from
// A in 2 bits (0.9375) and F in 1 (0.96875); C is A negated (-1). D is orthogonal to A, and E
// differs from D in 2 bits.
const VEC_A = Array(64).fill(1);
const VEC_B = VEC_A.map((v, i) => (i < 2 ? -v : v));
const VEC_C = VEC_A.map((v) => -v);
const VEC_D = VEC_A.map((v, i) => (i < 32 ? v : -v));
const VEC_E = VEC_D.map((v, i) => (i < 2 ? -v : v));
const VEC_F = VEC_A.map((v, i) => (i === 5 ? -v : v));
// A chain of retakes, orthogonal to the vectors above: H differs from G in 6 bits (0.8125), I from
// H in 5 others (0.84375), so G and I differ in 11 (0.65625), below the 0.75 a copy needs.
const VEC_G = VEC_A.map((v, i) => (i % 2 === 0 ? v : -v));
const VEC_H = VEC_G.map((v, i) => (i >= 10 && i < 16 ? -v : v));
const VEC_I = VEC_H.map((v, i) => (i >= 20 && i < 25 ? -v : v));

/** Deterministic pseudo-random uint32s (xorshift32), standing in for a recording's chromaprint. */
const sequence = (seed: number, length: number): number[] => {
  let x = seed;
  return Array.from({ length }, () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>>= 0);
  });
};
// A recording; the same recording with 40 values (~5 s) of other sound in front and bit noise
// throughout; and an unrelated recording that opens with the same 40 values as the copy.
const PRINT_A = sequence(7, 300);
const PRINT_B = [...sequence(99, 40), ...PRINT_A.map((v, i) => (i % 4 === 0 ? (v ^ 3) >>> 0 : v))];
const PRINT_C = [...sequence(99, 40), ...sequence(13, 300)];

const byScore = (clusters: { members: string[]; topSimilarity: number }[]) => clusters.sort((a, b) => b.topSimilarity - a.topSimilarity);

Deno.test('duplicate clusters join when every pair across is a copy, and keep their best score', () => {
  const all = (a: string, b: string) => a !== b ? 0.8 : null;
  for (const [from, to] of [['/b', '/d'], ['/d', '/b']]) {
    const edges = [{ a: '/a', b: '/b', sim: 0.99 }, { a: '/c', b: '/d', sim: 0.90 }, { a: from, b: to, sim: 0.86 }, { a: '/x', b: '/y', sim: 0.88 }];
    assertEquals(byScore(duplicateClusters(edges, all)), [
      { members: ['/a', '/b', '/c', '/d'], topSimilarity: 0.99 },
      { members: ['/x', '/y'], topSimilarity: 0.88 },
    ]);
  }
});

Deno.test('duplicate clusters do not follow a chain: the closer pair keeps the middle file', () => {
  const none = () => null;
  const edges = [{ a: '/g', b: '/h', sim: 0.81 }, { a: '/h', b: '/i', sim: 0.84 }];
  assertEquals(duplicateClusters(edges, none), [{ members: ['/h', '/i'], topSimilarity: 0.84 }]);
  // Two clusters joined by one edge stay apart when a pair across them is not a copy.
  const pairs = [{ a: '/a', b: '/b', sim: 0.95 }, { a: '/c', b: '/d', sim: 0.95 }, { a: '/b', b: '/c', sim: 0.9 }];
  const allButAd = (a: string, b: string) => [a, b].sort().join() === '/a,/d' ? null : 0.8;
  assertEquals(duplicateClusters(pairs, allButAd).map((c) => c.members), [['/a', '/b'], ['/c', '/d']]);
});

Deno.test('chained files are those in groups of three or more', () => {
  const edges = [{ a: '/a', b: '/b', sim: 0.9 }, { a: '/b', b: '/c', sim: 0.9 }, { a: '/x', b: '/y', sim: 0.9 }];
  assertEquals(chainedFiles(edges), ['/a', '/b', '/c']);
});

Deno.test({
  name: 'duplicates',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const createFile = async (path: string, attrs: Record<string, unknown>) => {
    const slash = path.lastIndexOf('/');
    return await vfs.create(ADMIN_ACCESS, 'file', path.slice(0, slash) || '/', path.slice(slash + 1), { attrs });
  };
  const seedMedia = async (path: string, sha256: string | null, size = 100) => {
    return await createFile(path, { size, mimetype: 'image/jpeg', ...(sha256 ? { sha256 } : {}) });
  };
  const write = async (path: string, bytes: Uint8Array) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  };

  try {
    // --- exact-mode fixtures under /ex, with a copy in /library ---
    await client.exec('mkdir -p /ex/sub /library /links');
    const a = await seedMedia('/ex/a.jpg', HASH_A);
    const b = await seedMedia('/ex/b.jpg', HASH_A);
    await seedMedia('/ex/sub/c.jpg', HASH_A);
    await seedMedia('/ex/uniq.jpg', HASH_B, 50);
    await seedMedia('/ex/unhashed.jpg', null, 7);
    await seedMedia('/library/a.jpg', HASH_A);
    await seedMedia('/library/only.jpg', '9'.repeat(64), 50);
    await client.exec('ln -s /ex/a.jpg /links/a.jpg');
    // Twins that are no media originals: a rendition of each of two copies, and their prints.
    for (const [path, id] of [['/ex/a.jpg', a.id], ['/ex/b.jpg', b.id]]) {
      await client.exec(`mkdir -p ${path}/thumbnails ${path}/metadata`);
      await createFile(`${path}/thumbnails/360.webp`, { size: 10, mimetype: 'image/webp', sha256: HASH_RENDITION, sourceId: id });
      await createFile(`${path}/metadata/chromaprint`, { mimetype: CHROMAPRINT_MIMETYPE });
      await write(`${path}/metadata/chromaprint`, encodeChromaprint(sequence(5, 300)));
    }
    const printHash = (await vfs.get(ADMIN_ACCESS, '/ex/a.jpg/metadata/chromaprint')).attrs.sha256;
    assertEquals((await vfs.get(ADMIN_ACCESS, '/ex/b.jpg/metadata/chromaprint')).attrs.sha256, printHash);

    await t.step('exact: a subtree groups its byte-identical files', async () => {
      const res = await client.execJson<ExactDuplicateScan>('duplicates /ex');
      assertEquals(res.totalGroups, 1);
      assertEquals(res.groups[0].sha256, HASH_A);
      assertEquals(res.groups[0].count, 3);
      assertEquals(res.groups[0].reclaimable, 200);
      assertEquals(res.groups[0].paths, ['/ex/a.jpg', '/ex/b.jpg', '/ex/sub/c.jpg']);
    });

    await t.step('exact: a subtree counts only the copies within it', async () => {
      // `/ex/sub` holds one copy of A; the others are outside it.
      assertEquals((await client.execJson<ExactDuplicateScan>('duplicates /ex/sub')).totalGroups, 0);
    });

    await t.step('exact: the whole store leaves renditions and prints out', async () => {
      const res = await client.execJson<ExactDuplicateScan>('duplicates /');
      const hashes = res.groups.map((group) => group.sha256);
      assert(hashes.includes(HASH_A), JSON.stringify(hashes));
      assertEquals(hashes.includes(HASH_RENDITION), false);
      assertEquals(hashes.includes(String(printHash)), false);
      assertEquals(res.groups.find((group) => group.sha256 === HASH_A)?.paths, ['/ex/a.jpg', '/ex/b.jpg', '/ex/sub/c.jpg', '/library/a.jpg']);
    });

    await t.step('exact: identical documents group, in a subtree and store-wide, but not their transcripts or empty files', async () => {
      const HASH_DOC = '3'.repeat(64);
      const HASH_TEXT = '4'.repeat(64);
      const EMPTY = '0'.repeat(64);
      await client.exec('mkdir -p /docs/sub');
      for (const path of ['/docs/report.pdf', '/docs/sub/report copy.pdf']) {
        await createFile(path, { size: 300, mimetype: 'application/pdf', sha256: HASH_DOC });
        await client.exec(`mkdir -p '${path}/metadata/content'`);
        await createFile(`${path}/metadata/content/text`, { size: 20, mimetype: 'text/plain', sha256: HASH_TEXT });
      }
      await createFile('/docs/empty.txt', { size: 0, mimetype: 'text/plain', sha256: EMPTY });
      await createFile('/docs/sub/empty.txt', { size: 0, mimetype: 'text/plain', sha256: EMPTY });

      const scanned = await client.execJson<ExactDuplicateScan>('duplicates /docs');
      assertEquals(scanned.groups.map((group) => [group.sha256, group.paths]), [[HASH_DOC, ['/docs/report.pdf', '/docs/sub/report copy.pdf']]]);
      const hashes = (await client.execJson<ExactDuplicateScan>('duplicates /')).groups.map((group) => group.sha256);
      assert(hashes.includes(HASH_DOC), JSON.stringify(hashes));
      assertEquals(hashes.includes(HASH_TEXT), false);
      assertEquals(hashes.includes(EMPTY), false);
    });

    await t.step('exact: single file lists its other copies, not itself through a link', async () => {
      const res = await client.execJson<ExactDuplicatesOf>('duplicates /ex/a.jpg');
      assertEquals(res.duplicates, ['/ex/b.jpg', '/ex/sub/c.jpg', '/library/a.jpg']);
      const linked = await client.execJson<ExactDuplicatesOf>('duplicates /links/a.jpg');
      assertEquals(linked.duplicates, ['/ex/b.jpg', '/ex/sub/c.jpg', '/library/a.jpg']);
    });

    await t.step('exact: min-count suppresses smaller groups', async () => {
      const res = await client.execJson<ExactDuplicateScan>('duplicates /ex --min-count 4');
      assertEquals(res.totalGroups, 0);
    });

    await t.step('exact: --against reports only groups spanning both roots and tags every path', async () => {
      const res = await client.execJson<ExactDuplicateScan>('duplicates /ex --against /library');
      assertEquals(res.groups.length, 1);
      assertEquals(res.groups[0].paths as DuplicatePathTag[], [
        { path: '/ex/a.jpg', inScope: true, inAgainst: false },
        { path: '/ex/b.jpg', inScope: true, inAgainst: false },
        { path: '/ex/sub/c.jpg', inScope: true, inAgainst: false },
        { path: '/library/a.jpg', inScope: false, inAgainst: true },
      ]);
      // Against the whole store too, the twins of renditions and prints are no copies.
      const anywhere = await client.execJson<ExactDuplicateScan>('duplicates /ex --against /');
      assertEquals(anywhere.groups.map((group) => group.sha256), [HASH_A]);
      // The whole store as the scope starts from the checksums shared store-wide.
      const everything = await client.execJson<ExactDuplicateScan>('duplicates / --against /library');
      assertEquals(everything.groups.length, 1);
      assertEquals(everything.groups[0].paths as DuplicatePathTag[], [
        { path: '/ex/a.jpg', inScope: true, inAgainst: false },
        { path: '/ex/b.jpg', inScope: true, inAgainst: false },
        { path: '/ex/sub/c.jpg', inScope: true, inAgainst: false },
        { path: '/library/a.jpg', inScope: true, inAgainst: true },
      ]);
    });

    await t.step('exact: more checksums than one lookup takes, and more copies than one page', async () => {
      // 600 checksums take two lookups. A third copy of 200 of them puts more than a page of rows
      // in the first lookup, whichever 500 it holds, so its paging goes on after a cursor.
      await client.exec('mkdir -p /many /many-library/extra');
      const hashOf = (i: number) => `${i.toString(16).padStart(8, '0')}${'e'.repeat(56)}`;
      const tripled = (i: number) => i >= 300 && i < 500;
      for (let i = 0; i < 600; i++) {
        await seedMedia(`/many/m${i}.jpg`, hashOf(i), 10);
        await seedMedia(`/many-library/m${i}.jpg`, hashOf(i), 10);
        if (tripled(i)) await seedMedia(`/many-library/extra/m${i}.jpg`, hashOf(i), 10);
      }
      const copies = (sha256: string) => tripled(Number.parseInt(sha256.slice(0, 8), 16)) ? 3 : 2;
      const scanned = await client.execJson<ExactDuplicateScan>('duplicates /many --against /many-library');
      assertEquals(scanned.totalGroups, 600);
      for (const group of scanned.groups) assertEquals(group.count, copies(group.sha256), group.sha256);
    });

    // --- fuzzy-mode fixtures under /fz and /fz-out (unique checksums so exact never groups them) ---
    const seedFingerprint = async (path: string, vec: number[], sha256: string) => {
      await seedMedia(path, sha256, 10);
      await client.exec(`mkdir -p ${path}/metadata`);
      await client.exec(`mknode -t embedding ${path}/metadata/sscd-image --as embeddingType=sscd-image --an capacity=64`);
      await write(`${path}/metadata/sscd-image`, new TextEncoder().encode(JSON.stringify(vec)));
    };
    await client.exec('mkdir -p /fz /fz-out');
    await seedFingerprint('/fz/a.jpg', VEC_A, 'c'.repeat(64));
    await seedFingerprint('/fz/b.jpg', VEC_B, 'd'.repeat(64));
    await seedFingerprint('/fz/c.jpg', VEC_C, 'e'.repeat(64));
    await seedFingerprint('/fz-out/d.jpg', VEC_D, '5'.repeat(64));
    await seedFingerprint('/fz-out/e.jpg', VEC_E, '6'.repeat(64));
    await seedFingerprint('/fz-out/f.jpg', VEC_F, '8'.repeat(64));
    await client.exec('ln -s /fz/a.jpg /links/fz-a.jpg');
    await client.exec('mkdir -p /chain');
    await seedFingerprint('/chain/g.jpg', VEC_G, '9'.repeat(64));
    await seedFingerprint('/chain/h.jpg', VEC_H, 'f'.repeat(64));
    await seedFingerprint('/chain/i.jpg', VEC_I, '0'.repeat(64));

    await t.step('fuzzy: single file finds its near-duplicates, closest first, not the dissimilar one or itself', async () => {
      const res = await client.execJson<FuzzyDuplicatesOf>('duplicates --fuzzy /fz/a.jpg');
      assertEquals(res.mode, 'fuzzy');
      assertEquals(res.duplicates.map((d) => d.path), ['/fz-out/f.jpg', '/fz/b.jpg']);
      assert(res.duplicates.every((d) => d.similarity > 0.85));
      const linked = await client.execJson<FuzzyDuplicatesOf>('duplicates --fuzzy /links/fz-a.jpg');
      assertEquals(linked.duplicates.map((d) => d.path), ['/fz-out/f.jpg', '/fz/b.jpg']);
    });

    await t.step('fuzzy: a subtree scan keeps only pairs touching the subtree', async () => {
      const res = await client.execJson<FuzzyDuplicateScan>('duplicates --fuzzy /fz');
      assertEquals(res.clusters.map((c) => c.members), [['/fz-out/f.jpg', '/fz/a.jpg', '/fz/b.jpg']]);
      assertEquals(res.clusters[0].topSimilarity, 0.96875);
      const outside = await client.execJson<FuzzyDuplicateScan>('duplicates --fuzzy /fz-out');
      assertEquals(outside.clusters.map((c) => c.members), [['/fz-out/f.jpg', '/fz/a.jpg', '/fz/b.jpg'], ['/fz-out/d.jpg', '/fz-out/e.jpg']]);
    });

    await t.step('fuzzy: the store-wide all-pairs pass finds the clusters a subtree scan does', async () => {
      const all = await client.execJson<FuzzyDuplicateScan>('duplicates --fuzzy');
      const members = all.clusters.map((c) => c.members);
      assert(members.some((m) => JSON.stringify(m) === JSON.stringify(['/fz-out/f.jpg', '/fz/a.jpg', '/fz/b.jpg'])), JSON.stringify(members));
      assert(members.some((m) => JSON.stringify(m) === JSON.stringify(['/fz-out/d.jpg', '/fz-out/e.jpg'])), JSON.stringify(members));
      assert(members.some((m) => JSON.stringify(m) === JSON.stringify(['/chain/h.jpg', '/chain/i.jpg'])), JSON.stringify(members));
      assert(!members.flat().includes('/chain/g.jpg'), JSON.stringify(members));
    });

    await t.step('fuzzy: a chain of retakes is not one cluster', async () => {
      const res = await client.execJson<FuzzyDuplicateScan>('duplicates --fuzzy /chain');
      assertEquals(res.clusters, [{ members: ['/chain/h.jpg', '/chain/i.jpg'], topSimilarity: 0.84375 }]);
    });

    // --- sound: chromaprints as compute-fingerprint stores them, under /au ---
    let print: number[] = [];
    const stub = startStubEms({
      // An empty print stands for a clip too short for chromaprint, which EMS answers with no entry.
      ops: {
        'fingerprint.compute': () => ({
          result: { fingerprints: print.length === 0 ? [] : [{ kind: 'chromaprint', fingerprint: print, label: 'primary' }] },
        }),
      },
    });
    try {
      await client.exec('mkdir -p /au');
      const seedRecording = async (path: string, values: number[], sha256: string) => {
        await createFile(path, { size: 10, mimetype: 'audio/mp4', sha256 });
        print = values;
        const out = await client.exec(`CFG_EMS_URL=${stub.url} compute-fingerprint ${path}`);
        assertEquals(out.success, true, out.error);
      };
      await seedRecording('/au/a.m4a', PRINT_A, '1'.repeat(64));
      await seedRecording('/au/b.m4a', PRINT_B, '2'.repeat(64));
      await seedRecording('/au/c.m4a', PRINT_C, '3'.repeat(64));

      await t.step('sound: compute-fingerprint stores the chromaprint as a file, not a vector', async () => {
        const node = await vfs.get(ADMIN_ACCESS, '/au/a.m4a/metadata/chromaprint');
        assertEquals(node.type, 'file');
        assertEquals(node.attrs.mimetype, 'application/x-chromaprint');
        assertEquals(node.attrs.values, PRINT_A.length);
        assert(typeof node.attrs.computedAt === 'string');
      });

      await t.step('sound: a copy with other audio in front matches; one sharing only the opening does not', async () => {
        const res = await client.execJson<FuzzyDuplicatesOf>('duplicates --fuzzy /au/a.m4a');
        assertEquals(res.duplicates.map((d) => d.path), ['/au/b.m4a']);
        assert(res.duplicates[0].similarity > 0.9);
        const fromC = await client.execJson<FuzzyDuplicatesOf>('duplicates --fuzzy /au/c.m4a');
        assertEquals(fromC.duplicates, []);
      });

      await t.step('sound: a subtree scan clusters the recording with its copy', async () => {
        const res = await client.execJson<FuzzyDuplicateScan>('duplicates --fuzzy /au');
        assertEquals(res.clusters.map((c) => c.members), [['/au/a.m4a', '/au/b.m4a']]);
      });

      await t.step('sound: a clip too short for a print is marked fingerprinted, and not asked again', async () => {
        await seedRecording('/au/short.m4a', [], '4'.repeat(64));
        const file = await vfs.get(ADMIN_ACCESS, '/au/short.m4a');
        assert(typeof file.attrs.fingerprintedAt === 'string');
        assertEquals(await vfs.exists(ADMIN_ACCESS, '/au/short.m4a/metadata/chromaprint'), false);

        const asked = stub.requests.length;
        const again = await client.exec(`CFG_EMS_URL=${stub.url} compute-fingerprint /au/short.m4a`);
        assertEquals(again.success, true, again.error);
        assertEquals(stub.requests.length, asked);

        const res = await client.exec('duplicates --fuzzy /au/short.m4a');
        assertEquals(res.success, false);
        assert(res.error?.includes('too short'), res.error);
      });

      await t.step('sound: a recording with its print is marked fingerprinted too', async () => {
        const file = await vfs.get(ADMIN_ACCESS, '/au/a.m4a');
        assert(typeof file.attrs.fingerprintedAt === 'string');
      });
    } finally {
      await stub.close();
    }

    await t.step('an unknown flag is refused', async () => {
      const res = await client.exec('duplicates --fuzzy --stored /fz/a.jpg');
      assertEquals(res.success, false);
      assert(res.error?.includes('unknown flag'), res.error);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
