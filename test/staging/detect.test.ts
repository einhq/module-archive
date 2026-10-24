/**
 * `staging detect`: each source's rule on invented trees, one that has its marks and one that only
 * looks alike; the suggested category; the folders newly arrived in the default category; and the
 * bound on what a folder costs to read, however large its tree.
 */
import type { StagingDetectAnswer, StagingDetection } from '@archive/staging/api';
import { BODY_READS, DETECT_SAMPLE, EXIF_READS, FOLDERS_PER_LEVEL, gather, LISTING_LEVELS, LISTING_PAGE } from '@archive/staging/detect';
import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const TREES = '/home/anna/trees';
const INBOX = '/home/anna/staging/files/inbox';

const MIMETYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  heic: 'image/heic',
  png: 'image/png',
  tif: 'image/tiff',
  mp4: 'video/mp4',
  nef: 'image/x-nikon-nef',
  json: 'application/json',
};

/** A node to make, as `createTree` takes it. */
type Spec = { type: 'file' | 'directory' | 'exif'; name: string; attrs?: Record<string, unknown>; children?: Spec[] };

/** One invented file: its path below the tree, and what an index would have read of it. */
type Entry = { path: string; attrs?: Record<string, unknown>; device?: { make?: string; model?: string } | null };

/** `entries` as nested specs: folders made from the paths, files with a mimetype by extension and, with `device`, an EXIF record. */
const specs = (entries: Entry[]): Spec[] => {
  const root: Spec[] = [];
  for (const entry of entries) {
    const segments = entry.path.split('/');
    let level = root;
    for (const folder of segments.slice(0, -1)) {
      let dir = level.find((spec) => spec.name === folder && spec.type === 'directory');
      if (!dir) level.push(dir = { type: 'directory', name: folder, children: [] });
      level = dir.children!;
    }
    const name = segments[segments.length - 1];
    const extension = name.split('.').pop()!.toLowerCase();
    const indexed = entry.device !== undefined ? { indexedAt: '2026-10-18T00:00:00Z' } : {};
    level.push({
      type: 'file',
      name,
      attrs: { mimetype: MIMETYPES[extension] ?? 'application/octet-stream', size: 10, ...indexed, ...entry.attrs },
      ...(entry.device !== undefined
        ? {
          children: [{
            type: 'directory',
            name: 'metadata',
            children: [{ type: 'exif', name: 'exif', attrs: { indexedAt: '2026-10-18T00:00:00Z', deviceinfo: entry.device } }],
          }],
        }
        : {}),
    });
  }
  return root;
};

/** `count` names made by `name` from 1 up. */
const run = (count: number, name: (n: number) => string, extra: Omit<Entry, 'path'> = {}): Entry[] =>
  Array.from({ length: count }, (_, i) => ({ path: name(i + 1), ...extra }));
const pad = (n: number, width = 4) => String(n).padStart(width, '0');

Deno.test({ name: 'staging detect', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A tree of `entries` at `TREES/<name>`. */
  const tree = async (name: string, entries: Entry[]): Promise<string> => {
    await cmd.shouldSucceed(`mkdir -p '${TREES}/${name}'`);
    await vfs.createTree(ADMIN_ACCESS, `${TREES}/${name}`, specs(entries) as Parameters<typeof vfs.createTree>[2]);
    return `${TREES}/${name}`;
  };
  const write = async (path: string, body: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(body));
    } finally {
      await handle.close();
    }
  };
  const detect = async (path: string): Promise<StagingDetection> => {
    const answer = await client.execJson<StagingDetectAnswer>(`staging detect --user anna '${path}'`);
    assertEquals(answer.detections.length, 1);
    return answer.detections[0];
  };
  const kindOf = async (path: string) => {
    const found = await detect(path);
    return [found.kind, found.confidence];
  };

  try {
    await cmd.shouldSucceed('user-create anna --uid 3610');
    await cmd.shouldSucceed('staging init --user anna');
    await cmd.shouldSucceed('staging category export --user anna --create --kind google-photos --label "Family export"');

    await t.step('a Takeout tree is Google Photos, and names the category of that kind', async () => {
      const path = await tree('takeout-001', [
        ...run(6, (n) => `Takeout/Google Photos/Photos from 2019/IMG_${pad(n)}.jpg`),
        ...run(6, (n) => `Takeout/Google Photos/Photos from 2019/IMG_${pad(n)}.jpg.supplemental-metadata.json`),
        { path: 'Takeout/Google Photos/Lake trip/metadata.json' },
      ]);
      const found = await detect(path);
      assertEquals([found.kind, found.confidence], ['google-photos', 'high']);
      assertEquals(found.category, { name: 'export', label: 'Family export', path: '/home/anna/staging/files/export' });
      assertEquals(found.evidence[0], 'a Takeout/Google Photos folder');
      assert(found.evidence.some((line) => line.startsWith('6 JSON names like ') && line.endsWith('.jpg.supplemental-metadata.json')), found.evidence.join('; '));
      assertEquals(found.seen.files, 13);
    });

    await t.step("Google's JSON alone, by its keys, is Google Photos; other JSON is not", async () => {
      const google = await tree('export-copy', [{ path: 'a.jpg' }, { path: 'a.jpg.json' }, { path: 'b.jpg' }, { path: 'b.jpg.json' }]);
      for (const name of ['a', 'b']) {
        await write(`${google}/${name}.jpg.json`, JSON.stringify({ title: `${name}.jpg`, photoTakenTime: { timestamp: '1559392496' } }));
      }
      const found = await detect(google);
      assertEquals([found.kind, found.confidence], ['google-photos', 'high']);
      assert(found.evidence.some((line) => line.includes("JSON sidecars read are Google Photos'")), found.evidence.join('; '));

      const notes = await tree('notes', [{ path: 'holiday-1.jpg' }, { path: 'holiday-2.jpg' }, { path: 'list.json' }, { path: 'plan.json' }]);
      await write(`${notes}/list.json`, JSON.stringify({ name: 'packing', items: ['a sailboat'] }));
      await write(`${notes}/plan.json`, JSON.stringify({ name: 'plan' }));
      assertEquals((await detect(notes)).kind, 'generic');
    });

    await t.step('TIFFs named by a scanner with no camera in their EXIF are scans; so is what a scanner names', async () => {
      const box = await tree('Box 3', run(8, (n) => `scan${pad(n)}.tif`, { attrs: { width: 3000, height: 2000 }, device: null }));
      const found = await detect(box);
      assertEquals([found.kind, found.confidence], ['scans', 'high']);
      assert(found.evidence.some((line) => line.includes('TIFF')), found.evidence.join('; '));
      assert(found.evidence.some((line) => line.startsWith('no device in the EXIF')), found.evidence.join('; '));

      const epson = await tree('prints', run(6, (n) => `IMG_20190601_${pad(n)}.jpg`, { device: { make: 'EPSON', model: 'Perfection V600' } }));
      assertEquals(await kindOf(epson), ['scans', 'high']);
      // A folder whose name only holds the letters is no scans.
      assertEquals((await detect(await tree('Scandinavia 2019', run(6, (n) => `holiday-${n}.jpg`)))).kind, 'generic');
    });

    await t.step("a phone's camera roll is a phone, and its dated names are no scanner's", async () => {
      assertEquals(await kindOf(await tree('pixel', run(6, (n) => `DCIM/Camera/PXL_20190601_10345${n}789.jpg`))), ['phone', 'high']);
      assertEquals(await kindOf(await tree('android', run(6, (n) => `IMG_20190601_12345${n}.jpg`))), ['phone', 'high']);
      assertEquals(await kindOf(await tree('iphone', run(6, (n) => `IMG_${pad(n)}.HEIC`))), ['phone', 'high']);
    });

    await t.step('WhatsApp folders and names are messaging', async () => {
      assertEquals(await kindOf(await tree('chats', run(6, (n) => `WhatsApp Images/IMG-20190601-WA${pad(n)}.jpg`))), ['messaging', 'high']);
      assertEquals(await kindOf(await tree('signal', run(6, (n) => `signal-2019-06-01-12345${n}.jpg`))), ['messaging', 'high']);
    });

    await t.step('screenshot names are screenshots', async () => {
      assertEquals(await kindOf(await tree('shots', run(6, (n) => `Screenshot_20190601-12345${n}.png`))), ['screenshots', 'high']);
    });

    await t.step("a camera's card is a camera; a running number alone says nothing", async () => {
      assertEquals(await kindOf(await tree('card', run(6, (n) => `DCIM/100NIKON/DSC_${pad(n)}.JPG`))), ['camera', 'high']);
      const canon = await tree('canon', run(6, (n) => `IMG_${pad(n)}.JPG`, { device: { make: 'Canon', model: 'Canon EOS 80D' } }));
      const found = await detect(canon);
      assertEquals([found.kind, found.confidence], ['camera', 'high']);
      assertEquals(found.category, null);
      assertEquals((await detect(await tree('numbers', run(6, (n) => `IMG_${pad(n)}.JPG`)))).kind, 'generic');
    });

    await t.step('a folder with no source’s marks is generic, and so is an empty one', async () => {
      const found = await detect(await tree('Summer', run(6, (n) => `holiday-${pad(n, 3)}.jpg`)));
      assertEquals([found.kind, found.category], ['generic', null]);
      await cmd.shouldSucceed(`mkdir -p ${TREES}/empty`);
      assertEquals(await detect(`${TREES}/empty`), {
        path: `${TREES}/empty`,
        dismissed: false,
        kind: 'generic',
        confidence: 'low',
        evidence: ['no files within'],
        category: null,
        seen: { files: 0, sampled: 0, folders: 0 },
      });
    });

    await t.step('without a folder, the folders newly arrived in the default category are detected, upload folders looked into', async () => {
      await cmd.shouldSucceed(`mkdir -p '${INBOX}/upload-2026-10-17/Phone dump' '${INBOX}/upload-2026-10-18' '${INBOX}/from-sftp'`);
      await vfs.createTree(
        ADMIN_ACCESS,
        `${INBOX}/upload-2026-10-17/Phone dump`,
        specs(run(4, (n) => `DCIM/Camera/PXL_20190601_10345${n}789.jpg`)) as Parameters<typeof vfs.createTree>[2],
      );
      await vfs.createTree(ADMIN_ACCESS, `${INBOX}/upload-2026-10-18`, specs(run(3, (n) => `loose-${n}.jpg`)) as Parameters<typeof vfs.createTree>[2]);
      await vfs.createTree(ADMIN_ACCESS, `${INBOX}/from-sftp`, specs(run(4, (n) => `Screenshot_20190601-12345${n}.png`)) as Parameters<typeof vfs.createTree>[2]);
      const answer = await client.execJson<StagingDetectAnswer>('staging detect --user anna');
      assertEquals(answer.more, false);
      assertEquals(answer.detections.map((each) => [each.path, each.kind, each.category]).toSorted(), [
        [`${INBOX}/from-sftp`, 'screenshots', null],
        [`${INBOX}/upload-2026-10-17/Phone dump`, 'phone', null],
      ]);

      await cmd.shouldSucceed('staging category phone --user anna --create --kind phone');
      const again = await client.execJson<StagingDetectAnswer>('staging detect --user anna');
      assertEquals(again.detections.find((each) => each.kind === 'phone')?.category?.name, 'phone');
      const text = await client.execString('staging detect --user anna', { json: false });
      assert(text.includes(`${INBOX}/upload-2026-10-17/Phone dump: phone (high; category phone)`), text);
    });

    await t.step('a dismissed folder is left out of the arrivals, and says so when named', async () => {
      await cmd.shouldSucceed(`attrs -J detectDismissed=true '${INBOX}/from-sftp'`);
      const answer = await client.execJson<StagingDetectAnswer>('staging detect --user anna');
      assertEquals(answer.detections.map((each) => [each.path, each.dismissed]), [[`${INBOX}/upload-2026-10-17/Phone dump`, false]]);
      assertEquals((await detect(`${INBOX}/from-sftp`)).dismissed, true);
      await cmd.shouldSucceed(`attrs -d detectDismissed '${INBOX}/from-sftp'`);
      assertEquals((await client.execJson<StagingDetectAnswer>('staging detect --user anna')).detections.length, 2);
    });

    await t.step('a folder costs a bounded number of reads, however large its tree', async () => {
      // 3,000 files in 10 × 10 folders three levels down, and each of them holding more.
      const entries: Entry[] = [];
      for (let a = 0; a < 10; a++) {
        for (let b = 0; b < 10; b++) {
          entries.push(...run(30, (n) => `a${a}/b${b}/c${n % 3}/IMG_${pad(a * 1000 + b * 100 + n)}.JPG`, { device: { make: 'NIKON', model: 'D750' } }));
        }
      }
      const big = await tree('big', entries);
      const calls: { method: string; args: unknown[] }[] = [];
      const counted = new Proxy(vfs, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls.push({ method: String(property), args });
            return value.apply(target, args);
          };
        },
      });
      const seen = await gather(counted as typeof vfs, ADMIN_ACCESS, big);
      const of = (method: string) => calls.filter((call) => call.method === method);

      assertEquals(seen.files, 3000);
      assertEquals(seen.media.length, DETECT_SAMPLE);
      assertEquals(of('query').length, 1);
      assertEquals((of('query')[0].args[1] as { limit: number }).limit, DETECT_SAMPLE);
      assertEquals(of('aggregate').length, 1);
      const listings = of('children');
      assert(listings.length <= 1 + FOLDERS_PER_LEVEL * (LISTING_LEVELS - 1), `${listings.length} listings`);
      for (const listing of listings) assertEquals((listing.args[2] as { page?: { limit: number } }).page?.limit, LISTING_PAGE);
      // The folder itself, the paired sidecars asked of a few photos, and their EXIF.
      assert(of('get').length <= 1 + BODY_READS + EXIF_READS, `${of('get').length} reads`);
      assertEquals(seen.devices.length, EXIF_READS);
      assertEquals(of('open').length, 0);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
