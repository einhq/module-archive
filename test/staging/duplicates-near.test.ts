/**
 * Near findings on staged media (`@archive/staging/duplicates`): a staged picture's look-alikes in
 * the library and in its inbox, found by fingerprint and kept apart from a burst's frames; a
 * recording's, found by chromaprint among those as long; the cascade that makes a look-alike one
 * both ways; the reverse check a library file's fingerprints start; `compute-fingerprint`
 * deciding a finding as its prints land; `staging separate`, which a recheck never undoes; the hub
 * guard; and reading, resolving and counting the sets (`staging duplicates`, `staging dedupe`),
 * for a folder, a suggested group and files named one by one.
 *
 * The files are invented photos with invented fingerprints: a random direction per scene, and a
 * copy or a burst frame a little or more turned away from it; and invented recordings, their
 * chromaprints pseudo-random values.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { CHROMAPRINT_MIMETYPE, encodeChromaprint } from '@archive/media/chromaprint';
import type { DuplicateCounts, DuplicateFinding, DuplicatePage, DuplicateResolveResult, DuplicateSeparateResult } from '@archive/media/api';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from '@ems/testing';
import { makeGroup } from './decisions-fixture.ts';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-staged-near-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

const INBOX = '/home/admin/staging/files/inbox';
const UPLOAD = `${INBOX}/upload-2026-10-01`;
const LAKE = `${ALBUMS_ROOT}/lake`;
const DIMENSIONS = 64;

/** A seeded generator, so every run invents the same fingerprints. */
const random = (() => {
  let seed = 7;
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
})();

const unit = (vector: number[]) => {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
};

/** A scene: a random direction. */
const scene = () => unit(Array.from({ length: DIMENSIONS }, random));

/** A fingerprint `similarity` alike to `base`: turned away from it towards a random direction. */
const alike = (base: number[], similarity: number) => {
  const noise = scene();
  const dot = noise.reduce((sum, value, i) => sum + value * base[i], 0);
  const orthogonal = unit(noise.map((value, i) => value - dot * base[i]));
  return base.map((value, i) => similarity * value + Math.sqrt(1 - similarity * similarity) * orthogonal[i]);
};

/** Pseudo-random uint32s (xorshift32), standing in for a recording's chromaprint. */
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

/** A finding without the time it was computed at, for comparing. */
const timeless = (finding: DuplicateFinding | undefined) => {
  if (!finding) return undefined;
  const { at: _at, ...rest } = finding;
  return rest;
};

let checksum = 0;

Deno.test({ name: 'staged near findings', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const idOf = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).id;
  const finding = async (path: string) => (await vfs.get(ADMIN_ACCESS, path)).attrs.duplicate as DuplicateFinding | undefined;
  const fingerprint = async (path: string, vector: number[]) => {
    await cmd.shouldSucceed(`mkdir -p ${path}/metadata`);
    await cmd.shouldSucceed(`mknode -t embedding ${path}/metadata/sscd-image --as embeddingType=sscd-image --an capacity=${DIMENSIONS}`);
    const handle = await vfs.open(ADMIN_ACCESS, `${path}/metadata/sscd-image`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
    } finally {
      await handle.close();
    }
    await vfs.update(ADMIN_ACCESS, path, { attrs: { fingerprintedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } });
  };
  /** An invented photo at `path`, its own bytes, fingerprinted with `vector` unless it is null. */
  const photo = async (path: string, vector: number[] | null, attrs: Record<string, unknown> = {}) => {
    const slash = path.lastIndexOf('/');
    await cmd.shouldSucceed(`mkdir -p ${path.slice(0, slash)}`);
    await vfs.createTree(ADMIN_ACCESS, path.slice(0, slash), [{
      type: 'file',
      name: path.slice(slash + 1),
      props: { uid: 0, gid: 0, mode: 0o640 },
      attrs: {
        mimetype: 'image/jpeg',
        size: 2_000_000,
        sha256: (++checksum).toString(16).padStart(64, '0'),
        width: 4000,
        height: 3000,
        takenAtUtc: '2021-07-04T10:15:30Z',
        takenAtSource: 'device',
        devicePath: '/devices/camera-a',
        ...attrs,
      },
    }]);
    if (vector) await fingerprint(path, vector);
    return path;
  };
  /** An invented recording at `path`, its own bytes, `duration` seconds long, with `print` as its chromaprint. */
  const recording = async (path: string, print: number[], duration: number) => {
    const slash = path.lastIndexOf('/');
    await cmd.shouldSucceed(`mkdir -p ${path.slice(0, slash)}`);
    await vfs.createTree(ADMIN_ACCESS, path.slice(0, slash), [{
      type: 'file',
      name: path.slice(slash + 1),
      props: { uid: 0, gid: 0, mode: 0o640 },
      attrs: { mimetype: 'audio/mp4', size: 300_000, sha256: (++checksum).toString(16).padStart(64, '0'), duration },
    }]);
    await cmd.shouldSucceed(`mkdir -p ${path}/metadata && mknode -t file ${path}/metadata/chromaprint --as mimetype=${CHROMAPRINT_MIMETYPE}`);
    const handle = await vfs.open(ADMIN_ACCESS, `${path}/metadata/chromaprint`, { mode: 'w' });
    try {
      await handle.write(encodeChromaprint(print));
    } finally {
      await handle.close();
    }
    await vfs.update(ADMIN_ACCESS, path, { attrs: { fingerprintedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } });
    return path;
  };
  const record = (...paths: string[]) => cmd.shouldSucceed(`duplicates --record ${paths.join(' ')}`);
  const peersOf = async (path: string) => (await finding(path))?.peers?.map((peer) => peer.id) ?? [];

  try {
    await cmd.shouldSucceed('staging init');
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && mknode -t album ${LAKE} --as name=Lake && chmod 755 ${ALBUMS_ROOT} ${LAKE}`);

    const lake = scene();
    const library = await photo(`${LAKE}/IMG_0001.jpg`, lake);
    const smaller = await photo(`${UPLOAD}/IMG_0001-small.jpg`, alike(lake, 0.97), { width: 2000, height: 1500, size: 400_000 });
    const pier = scene();
    const first = await photo(`${UPLOAD}/IMG_0100.jpg`, pier);
    const second = await photo(`${UPLOAD}/IMG_0101.jpg`, alike(pier, 0.9));
    const later = await photo(`${UPLOAD}/IMG_0102.jpg`, alike(pier, 0.99), { takenAtUtc: '2021-07-04T10:15:33Z' });

    await t.step('a downscaled re-encode of a library photo is near it; a burst of distinct shots is not', async () => {
      await record(UPLOAD);
      assertEquals(timeless(await finding(smaller)), {
        inbox: 'admin',
        sha256: (await vfs.get(ADMIN_ACCESS, smaller)).attrs.sha256 as string,
        kind: 'near',
        where: 'library',
        peers: [{ id: await idOf(library), method: 'sscd', score: 0.97 }],
      });
      // One size, one camera, one second, alike but not a re-save: two frames of a burst.
      assertEquals([(await finding(first))?.kind, (await finding(second))?.kind], [undefined, undefined]);
      // Three seconds on, by the camera's clock: another shot, however alike.
      assertEquals((await finding(later))?.kind, undefined);
      assertEquals((await vfs.get(ADMIN_ACCESS, library)).attrs.duplicate, undefined, 'a library file never carries a finding');
    });

    const bay = scene();
    const a = await photo(`${UPLOAD}/IMG_0200.jpg`, bay, { takenAtSource: 'name' });
    const b = await photo(`${UPLOAD}/IMG_0201.jpg`, null, { takenAtSource: 'name', width: 1600, height: 1200 });

    await t.step('the cascade makes a look-alike one both ways when only one side finds the other', async () => {
      await record(a, b);
      assertEquals(await peersOf(a), [], 'its look-alike had no fingerprint yet');
      await fingerprint(b, alike(bay, 0.95));
      await record(b);
      assertEquals(await peersOf(b), [await idOf(a)]);
      assertEquals(await peersOf(a), [await idOf(b)], 'checked again with the one that found it');
      assertEquals((await finding(a))?.where, 'inbox');
    });

    await t.step('a library file fingerprinted after its staged look-alike rechecks it', async () => {
      const harbour = scene();
      const staged = await photo(`${UPLOAD}/IMG_0300.jpg`, alike(harbour, 0.96), { width: 1024, height: 768, takenAtSource: 'name' });
      await record(staged);
      assertEquals((await finding(staged))?.kind, undefined);
      const filed = await photo(`${LAKE}/IMG_0300.jpg`, harbour, { takenAtSource: 'name' });
      const answer = await client.execJson<{ recorded: number }>(`duplicates --record ${filed}`);
      assertEquals(answer.recorded, 1, 'the library file counts as recorded: its look-alike was');
      assertEquals([(await finding(staged))?.kind, (await finding(staged))?.where, await peersOf(staged)], ['near', 'library', [await idOf(filed)]]);
    });

    await t.step('separate keeps two look-alikes apart on both sides, through any recheck, until undone', async () => {
      const answer = await client.execJson<DuplicateSeparateResult>(`staging separate ${a} ${b}`);
      assertEquals(answer, { ok: true, pairs: 1, undone: false });
      assertEquals((await vfs.get(ADMIN_ACCESS, a)).attrs.duplicateDecision, { separate: [await idOf(b)] });
      assertEquals((await vfs.get(ADMIN_ACCESS, b)).attrs.duplicateDecision, { separate: [await idOf(a)] });
      assertEquals([await peersOf(a), await peersOf(b)], [[], []]);
      await record(a, b);
      assertEquals([await peersOf(a), await peersOf(b)], [[], []], 'a recheck never pairs them again');
      await client.execJson<DuplicateSeparateResult>(`staging separate ${a} ${b} --off`);
      assertEquals((await vfs.get(ADMIN_ACCESS, a)).attrs.duplicateDecision, undefined);
      assertEquals([await peersOf(a), await peersOf(b)], [[await idOf(b)], [await idOf(a)]]);
      // Byte twins are copies, whatever a person says.
      const twin = await photo(`${UPLOAD}/IMG_0200-copy.jpg`, null, { sha256: (await vfs.get(ADMIN_ACCESS, a)).attrs.sha256 });
      assert(!(await client.exec(`staging separate ${a} ${twin}`)).success);
      await cmd.shouldSucceed(`rm ${twin}`);
      await record(a);
    });

    await t.step('a chain A~B~C reads as one set at its smallest id; the rest shows once that is resolved', async () => {
      const page = await client.execJson<DuplicatePage>(`staging duplicates inbox --near --where inbox`);
      assertEquals(page.sets.map((set) => set.key), [`near:${await idOf(a)}`]);
      const [set] = page.sets;
      assertEquals([set.keep, set.discard, set.reasons[0].rule, set.bulk, set.blocked], [await idOf(a), [await idOf(b)], 'pixels', false, 'needs-review']);
      assertEquals(set.staged.find((member) => member.id === set.discard[0])?.score, 0.95);
    });

    await t.step('reading copies of library photos: the library file is kept, and a smaller staged one resolves unasked', async () => {
      const page = await client.execJson<DuplicatePage>(`staging duplicates inbox --near --where library`);
      const key = `near:${await idOf(smaller)}`;
      const set = page.sets.find((each) => each.key === key)!;
      assertEquals([set.keep, set.discard, set.reasons[0].rule, set.bulk, set.flags], [await idOf(library), [await idOf(smaller)], 'library', true, []]);
      assertEquals(set.existing.map((member) => member.path), [library]);
      // Equal pixels against the library: for a person to look at.
      const same = await photo(`${UPLOAD}/IMG_0400.jpg`, null, { takenAtSource: 'name' });
      const field = await photo(`${LAKE}/IMG_0400.jpg`, null, { takenAtSource: 'name' });
      const meadow = scene();
      await fingerprint(field, meadow);
      await fingerprint(same, alike(meadow, 0.9));
      await record(same);
      const sameKey = `near:${await idOf(same)}`;
      const equal = (await client.execJson<DuplicatePage>(`staging duplicates inbox --near --where library`)).sets.find((each) => each.key === sameKey)!;
      assertEquals([equal.bulk, equal.blocked], [false, 'needs-review']);
      // Smaller but only somewhat alike, as a burst frame saved smaller is: also for a person.
      const pond = scene();
      const shore = await photo(`${LAKE}/IMG_0500.jpg`, null, { takenAtSource: 'name' });
      const frame = await photo(`${UPLOAD}/IMG_0500-2.jpg`, null, { takenAtSource: 'name', width: 2000, height: 1500, size: 400_000 });
      await fingerprint(shore, pond);
      await fingerprint(frame, alike(pond, 0.85));
      await record(frame);
      const frameKey = `near:${await idOf(frame)}`;
      const frameSet = (await client.execJson<DuplicatePage>(`staging duplicates inbox --near --where library`)).sets.find((each) => each.key === frameKey)!;
      assertEquals([frameSet.keep, frameSet.bulk, frameSet.blocked], [await idOf(shore), false, 'needs-review']);
      const counts = await client.execJson<DuplicateCounts>('staging duplicates inbox --counts');
      assertEquals(counts.near, { library: 4, inbox: 2 });
      const applied = await client.execJson<DuplicateResolveResult>('staging dedupe inbox --apply --near --where library --dry-run');
      assertEquals([applied.resolved, applied.discarded, applied.skipped.map((skip) => skip.reason).sort()], [2, 2, ['needs-review', 'needs-review']]);
    });

    await t.step('staged files named one by one read the sets they belong to, in the whole inbox', async () => {
      const copy = await photo(`${UPLOAD}/IMG_0001-copy.jpg`, null, { sha256: (await vfs.get(ADMIN_ACCESS, library)).attrs.sha256 });
      await record(copy);
      const page = await client.execJson<DuplicatePage>(`staging duplicates ${copy} ${smaller} ${first}`);
      assertEquals(page.scope, '/home/admin/staging/files');
      assertEquals(page.cursor, null);
      assertEquals(page.sets.map((set) => set.key).sort(), [`exact:${await idOf(library)}`, `near:${await idOf(smaller)}`].sort());
      assertEquals((await client.execJson<DuplicatePage>(`staging duplicates ${first}`)).sets, [], 'a file with no copy and no look-alike is in no set');
      assert(!(await client.exec(`staging duplicates ${library}`)).success, 'a library file is not staged');
      assert(!(await client.exec(`staging duplicates ${copy} ${smaller} --limit 5`)).success, 'files are read whole');
      await cmd.shouldSucceed(`rm ${copy}`);
    });

    await t.step('a suggested group reads the sets of its members; a set resolved keeps the one chosen', async () => {
      const group = '/home/admin/staging/albums/inbox/2021-07-04';
      await makeGroup(vfs, group, 'Bay', [a, b, smaller], { uid: 0, gid: 0 });
      const page = await client.execJson<DuplicatePage>(`staging duplicates ${group}`);
      assertEquals(page.cursor, null);
      assertEquals(page.sets.map((set) => set.key).sort(), [`near:${await idOf(a)}`, `near:${await idOf(smaller)}`].sort());
      const resolved = await client.execJson<DuplicateResolveResult>(`staging dedupe ${group} near:${await idOf(a)} --keep ${await idOf(b)}`);
      assertEquals([resolved.resolved, resolved.discarded], [1, 1]);
      assert(!(await vfs.exists(ADMIN_ACCESS, a)), 'the file not kept went to the trash');
      assertEquals(await peersOf(b), [], 'its look-alike in the trash is no longer named');
      assertEquals((await client.execJson<DuplicatePage>(`staging duplicates ${group}`)).sets.map((set) => set.key), [`near:${await idOf(smaller)}`]);
    });

    await t.step('a picture alike to thirty files or more is a hub, alike to none', async () => {
      const chart = scene();
      for (let i = 0; i < 30; i++) await photo(`${LAKE}/chart/IMG_${1000 + i}.jpg`, alike(chart, 0.98), { takenAtSource: 'name' });
      const staged = await photo(`${UPLOAD}/IMG_0500.jpg`, chart, { takenAtSource: 'name' });
      await record(staged);
      assertEquals([(await finding(staged))?.kind, (await finding(staged))?.hub, (await finding(staged))?.peers], [undefined, 'many', undefined]);
    });

    await t.step('a staged recording is near a library one as long whose chromaprint matches; not one as long that does not, nor one far longer', async () => {
      const memo = sequence(7, 300);
      const kept = await recording(`${LAKE}/memo.m4a`, memo, 37.2);
      // Re-encoded: the same sound with bit noise throughout.
      const reencoded = await recording(`${UPLOAD}/memo.m4a`, memo.map((value, i) => (i % 4 === 0 ? (value ^ 3) >>> 0 : value)), 37.0);
      const other = await recording(`${UPLOAD}/other.m4a`, sequence(13, 300), 37.2);
      const longer = await recording(`${UPLOAD}/longer.m4a`, [...memo, ...sequence(21, 300)], 74.4);
      await record(reencoded, other, longer);
      const found = await finding(reencoded);
      assertEquals([found?.kind, found?.where, found?.peers?.map((peer) => [peer.id, peer.method])], ['near', 'library', [[await idOf(kept), 'chromaprint']]]);
      assert((found?.peers?.[0].score ?? 0) > 0.9);
      assertEquals([(await finding(other))?.kind, (await finding(longer))?.kind], [undefined, undefined]);
    });

    await t.step("compute-fingerprint decides a staged file's look-alikes as its prints land", async () => {
      const dune = scene();
      const filed = await photo(`${LAKE}/IMG_0600.jpg`, dune, { takenAtSource: 'name' });
      const staged = await photo(`${UPLOAD}/IMG_0600-small.jpg`, null, { takenAtSource: 'name', width: 2000, height: 1500 });
      await record(staged);
      assertEquals((await finding(staged))?.kind, undefined);
      const stub = startStubEms({
        ops: {
          'fingerprint.compute': () => ({
            result: { fingerprints: [{ kind: 'sscd-image', dimension: DIMENSIONS, vector: alike(dune, 0.98), label: 'primary' }] },
            producer: 'sscd_disc_mixup',
          }),
        },
      });
      try {
        await cmd.shouldSucceed(`CFG_EMS_URL=${stub.url} compute-fingerprint ${staged}`);
      } finally {
        await stub.close();
      }
      assertEquals([(await finding(staged))?.kind, (await finding(staged))?.where, await peersOf(staged)], ['near', 'library', [await idOf(filed)]]);
    });

    await t.step('discarding an original that looks like a library photo makes its byte copy the original', async () => {
      const reef = scene();
      await photo(`${LAKE}/IMG_0700.jpg`, reef, { takenAtSource: 'name' });
      const original = await photo(`${UPLOAD}/IMG_0700-small.jpg`, alike(reef, 0.97), { takenAtSource: 'name', width: 2000, height: 1500 });
      const copy = await photo(`${UPLOAD}/IMG_0700-small-copy.jpg`, null, { takenAtSource: 'name', sha256: (await vfs.get(ADMIN_ACCESS, original)).attrs.sha256 });
      await record(original, copy);
      assertEquals([(await finding(original))?.kind, (await finding(copy))?.of], ['near', await idOf(original)]);
      await cmd.shouldSucceed(`staging discard ${original}`);
      assertEquals((await finding(copy))?.of, undefined);
      await cmd.shouldSucceed(`rm ${copy}`);
    });

    await t.step('a refresh announces a file whose finding is older than its fingerprints, and counts the fingerprinted', async () => {
      const refresh = await client.execJson<{ examined: number; withPrints: number; emitted: number }>('staging duplicates --refresh --dry-run');
      assertEquals(refresh.emitted, 0, 'every near check was stamped after the prints it compared');
      assertEquals(refresh.withPrints, refresh.examined, 'every staged photo here has fingerprints');
      // Fingerprinted again, after its last check.
      await vfs.update(ADMIN_ACCESS, smaller, { attrs: { fingerprintedAt: '2099-01-01T00:00:00Z' } });
      assertEquals((await client.execJson<{ emitted: number }>('staging duplicates --refresh --dry-run')).emitted, 1);
    });
  } finally {
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
