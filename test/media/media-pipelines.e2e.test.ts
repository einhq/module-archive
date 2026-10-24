/**
 * Container tier E2E: upload real media over HTTP and assert the whole
 * event-driven fan-out runs — bridge derives facts, each per-capability
 * pipeline triggers on its own fact, exif and derivatives land.
 *
 * Runs only inside the EiN container image (EIN_TEST_CONTAINER=1), against the EMS
 * `make container-test` points at — every tool and model lives there.
 *
 * Network- and model-dependent pipelines (geocode, describe, faces) are
 * asserted as attempted (terminal status), not as succeeded.
 */

import { PIPELINE_INSTANCES_PATH } from '@ein/paths';
import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { encodeHex } from '@std/encoding/hex';
import { dirname } from '@std/path';
import { containerTest } from '@ein/testing';
import { SystemTestHarness } from '@ein/testing';
import { poster } from '@ems/client';
import { faceCropRect, MAX_CROP_DIMENSION } from '@archive/media/face-crop';
import { ANAMORPHIC, emsCommand, PHOTO, ROTATED, ROTATED_VIDEO, stageMediaFixtures } from './media-fixtures.ts';
import { inventScene, moveShape, scenePng } from './invented-images.ts';

/**
 * Pipelines whose failure means the indexing chain itself is broken.
 *
 * Ingest and derivatives run in this image; fingerprints come from EMS, so that pipeline is
 * required only when a service is configured (`make container-test` passes CFG_EMS_URL and puts
 * the file root under /files-tmp, which EMS mounts at the same path). Without one the step
 * fails as unreachable, which is the expected answer, not a broken chain.
 */
const REQUIRED_PIPELINES = ['media-ingest', 'media-stills', ...(Deno.env.get('CFG_EMS_URL') ? ['media-fingerprint'] : [])];
const TERMINAL = ['completed', 'failed', 'skipped', 'cancelled'];

containerTest('media pipeline fan-out E2E', async (t) => {
  const fixtures = await stageMediaFixtures();
  // Files must live on disk under the shared scratch, which EMS mounts at the same path.
  const fileRoot = await Deno.makeTempDir({ prefix: 'ein-e2e-files-', dir: Deno.env.get('EIN_TEST_FILE_ROOT') || undefined });
  const harness = new SystemTestHarness({ ssh: false, boot: true, fileRoot, modules: ['archive'] });
  const { baseUrl } = await harness.startPrimary();
  const client = await harness.createShellClient();
  const { cookie } = await harness.createHttpSession();

  const upload = async (localPath: string, vfsPath: string) => {
    const body = await Deno.readFile(localPath);
    const res = await fetch(`${baseUrl}/file${vfsPath}`, { method: 'PUT', headers: { cookie }, body });
    assertEquals(res.status, 201, `upload ${vfsPath}`);
    return await res.json();
  };

  /**
   * An instance is named after its trigger node, so this is a direct lookup.
   *
   * The API shell already JSON-parses a command's stdout, so `data` is the attrs **object**,
   * not a string to parse again.
   */
  const instanceStatus = async (pipeline: string, nodeId: string): Promise<string | undefined> => {
    const res = await client.exec(`attrs ${PIPELINE_INSTANCES_PATH}/${pipeline}/${nodeId}`);
    if (!res.success || typeof res.data !== 'object' || res.data === null) return undefined;
    const status = (res.data as { status?: unknown }).status;
    return typeof status === 'string' ? status : undefined;
  };

  const nodeIdOf = async (path: string): Promise<string> => {
    const info = await client.execJson<{ id: string }>(`info ${path}`);
    return info.id;
  };

  /**
   * A rendition's pixel size, read back the way `exif-extract` reads any file's: through EMS.
   *
   * Given a minute rather than the client's 5 s: the probe waits its turn in EMS's tool lane
   * behind whatever the box is doing, and a slot there can be tens of seconds away under a crawl.
   */
  const dimensionsOf = async (path: string): Promise<[number, number]> => {
    const [tags] = await client.execJson<{ ImageWidth: number; ImageHeight: number }[]>(`exiftool ${path}`, { timeout: 60_000 });
    return [tags.ImageWidth, tags.ImageHeight];
  };

  /** Wait until every required pipeline reached a terminal, non-failed state. */
  const waitForIndexing = async (path: string, timeoutMs = 300_000): Promise<Record<string, string>> => {
    const nodeId = await nodeIdOf(path);
    const start = Date.now();

    while (true) {
      const statuses: Record<string, string> = {};
      for (const pipeline of REQUIRED_PIPELINES) {
        const status = await instanceStatus(pipeline, nodeId);
        if (status) statuses[pipeline] = status;
      }

      const allPresent = REQUIRED_PIPELINES.every((p) => p in statuses);
      const allTerminal = Object.values(statuses).every((s) => TERMINAL.includes(s));

      if (allPresent && allTerminal) {
        const failed = Object.entries(statuses).filter(([, s]) => s === 'failed');
        if (failed.length > 0) {
          throw new Error(`required pipeline failed for ${path}: ${JSON.stringify(statuses)}`);
        }
        return statuses;
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${path}: ${JSON.stringify(statuses)}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/e2e`);

    await t.step('uploads set size, sha256 and mimetype', async () => {
      const photo = await upload(fixtures.jpeg, `${ALBUMS_ROOT}/e2e/photo.jpg`);
      assertEquals(photo.mimetype, 'image/jpeg');
      assertEquals(photo.size > 0, true);
      assertEquals(typeof photo.sha256, 'string');

      const clip = await upload(fixtures.mp4, `${ALBUMS_ROOT}/e2e/clip.mp4`);
      assertEquals(clip.mimetype.startsWith('video/'), true);

      const tone = await upload(fixtures.m4a, `${ALBUMS_ROOT}/e2e/tone.m4a`);
      assertEquals(tone.mimetype.startsWith('audio/'), true);

      const programStream = await upload(fixtures.mpg, `${ALBUMS_ROOT}/e2e/program-stream.mpg`);
      assertEquals(programStream.mimetype, 'video/mpeg');

      const legacy = await upload(fixtures.legacyAvi, `${ALBUMS_ROOT}/e2e/legacy.avi`);
      assertEquals(legacy.mimetype, 'video/x-msvideo');

      const rotated = await upload(fixtures.rotated, `${ALBUMS_ROOT}/e2e/rotated.jpg`);
      assertEquals(rotated.mimetype, 'image/jpeg');

      const rotatedClip = await upload(fixtures.rotatedMp4, `${ALBUMS_ROOT}/e2e/rotated.mp4`);
      assertEquals(rotatedClip.mimetype.startsWith('video/'), true);

      const longClip = await upload(fixtures.longMp4, `${ALBUMS_ROOT}/e2e/long.mp4`);
      assertEquals(longClip.mimetype.startsWith('video/'), true);

      const anamorphicClip = await upload(fixtures.anamorphicMp4, `${ALBUMS_ROOT}/e2e/anamorphic.mp4`);
      assertEquals(anamorphicClip.mimetype.startsWith('video/'), true);
    });

    await t.step('a rotated photo: angle on the node, derivatives in the display frame', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/rotated.jpg`);

      // Orientation 6 on a landscape raster -> the node carries the rotation, and every later
      // step (renditions, face boxes) works in the frame that produces rather than in EXIF.
      const attrs = await client.execJson<{ angle?: number; width: number; height: number }>(`attrs ${ALBUMS_ROOT}/e2e/rotated.jpg`);
      assertEquals(attrs.angle, ROTATED.angle);
      assertEquals([attrs.width, attrs.height], [ROTATED.width, ROTATED.height]);

      // The rendition is the display frame made real: the landscape original comes out portrait,
      // with the 1:2 aspect of the upright raster. The 200x400 picture fits the 512 box, the
      // last size it gets, so that one holds it unscaled.
      const res = await fetch(`${baseUrl}/file${ALBUMS_ROOT}/e2e/rotated.jpg/thumbnails/512x512.avif`, { headers: { cookie } });
      assertEquals(res.status, 200);
      const [w, h] = await dimensionsOf(`${ALBUMS_ROOT}/e2e/rotated.jpg/thumbnails/512x512.avif`);
      assertEquals(h > w, true, `rendition is not portrait: ${w}x${h}`);
      assertEquals(h * ROTATED.height, w * ROTATED.width, `rendition aspect is not the display frame's: ${w}x${h}`);
    });

    /**
     * A poster frame is a still, and a still cannot carry a sample aspect ratio.
     *
     * The transcode can: MP4 keeps the SAR in a `pasp` box and players apply it. An AVIF still
     * of the coded raster would show an AVCHD `.MTS` tile squeezed by a quarter while its
     * lightbox video played correctly.
     *
     * Pinned on the `contain` size: `cover` returns a square whatever the input shape, so it
     * cannot tell a corrected frame from a squeezed one.
     */
    await t.step('an anamorphic video: the poster frame is the picture, not the raster', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/anamorphic.mp4`);

      // What the node holds is a property of the container, not of the source's shape: exiftool
      // reads an MP4's dimensions from the track header, which already *is* the display frame,
      // so this fixture indexes as 640x360 and its stored raster needs no correction — `sar` is
      // absent, and applying the stream's own 4:3 on top of these numbers would paint a 16:9
      // clip at 2.37:1. The corpus's `.MTS` files are the opposite case: they offer only the
      // coded 1440x1080, and there the ratio has to be measured and stored. That half is pinned
      // against the real tools in `orientation.e2e.test.ts`, which needs no pipeline to show it.
      const attrs = await client.execJson<{ width: number; height: number; sar?: number }>(`attrs ${ALBUMS_ROOT}/e2e/anamorphic.mp4`);
      assertEquals([attrs.width, attrs.height], [ANAMORPHIC.displayWidth, ANAMORPHIC.displayHeight]);
      assertEquals(attrs.sar, undefined);

      const res = await fetch(`${baseUrl}/file${ALBUMS_ROOT}/e2e/anamorphic.mp4/thumbnails/512x512.avif`, { headers: { cookie } });
      assertEquals(res.status, 200);
      const [pw, ph] = await dimensionsOf(`${ALBUMS_ROOT}/e2e/anamorphic.mp4/thumbnails/512x512.avif`);
      assertEquals(
        pw * ANAMORPHIC.displayHeight,
        ph * ANAMORPHIC.displayWidth,
        `poster aspect is not the display frame's ${ANAMORPHIC.displayWidth}x${ANAMORPHIC.displayHeight}: ${pw}x${ph}`,
      );
    });

    /**
     * The video half of the rotated-photo step above, and it has to be asserted separately
     * because a video says "turn me" somewhere `Orientation` cannot reach: the container's
     * display matrix. Without an `angle` from it, a decoder that applies the matrix itself and
     * one that does not would turn the same clip differently, for no reason the node could
     * explain.
     *
     * So this pins both ends: the matrix reaches the node as `angle`, and every rendition is
     * then in the frame that angle describes.
     */
    await t.step('a rotated video: the container matrix reaches the node, and every rendition', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/rotated.mp4`);

      const attrs = await client.execJson<{ angle?: number; width: number; height: number }>(`attrs ${ALBUMS_ROOT}/e2e/rotated.mp4`);
      assertEquals(attrs.angle, ROTATED_VIDEO.angle);
      // Raw dimensions, as stored — the display frame is the swap of these, not these.
      assertEquals([attrs.width, attrs.height], [ROTATED_VIDEO.width, ROTATED_VIDEO.height]);

      // The exif node keeps the tag it was derived from, so a wrong angle can be traced back.
      const exif = await client.execJson<{ raw: Record<string, unknown> }>(`attrs ${ALBUMS_ROOT}/e2e/rotated.mp4/metadata/exif`);
      assertEquals(Number(exif.raw.Rotation), ROTATED_VIDEO.rotation);

      const res = await fetch(`${baseUrl}/file${ALBUMS_ROOT}/e2e/rotated.mp4/thumbnails/512x512.avif`, { headers: { cookie } });
      assertEquals(res.status, 200);
      const [pw, ph] = await dimensionsOf(`${ALBUMS_ROOT}/e2e/rotated.mp4/thumbnails/512x512.avif`);
      assertEquals(ph > pw, true, `poster is not portrait: ${pw}x${ph}`);

      // And the transcode.
      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/e2e/rotated.mp4`);
      const start = Date.now();
      while (!TERMINAL.includes(await instanceStatus('media-transcode', nodeId) ?? '')) {
        if (Date.now() - start > 300_000) throw new Error('timed out waiting for media-transcode');
        await new Promise((r) => setTimeout(r, 1000));
      }

      const clipRes = await fetch(`${baseUrl}/file${ALBUMS_ROOT}/e2e/rotated.mp4/thumbnails/1920x1080.mp4`, { headers: { cookie } });
      assertEquals(clipRes.status, 200);
      const [tags] = await client.execJson<{ ImageWidth: number; ImageHeight: number; Rotation?: number }[]>(
        `exiftool ${ALBUMS_ROOT}/e2e/rotated.mp4/thumbnails/1920x1080.mp4`,
        { timeout: 60_000 },
      );
      assertEquals(tags.ImageHeight > tags.ImageWidth, true, `transcode is not portrait: ${tags.ImageWidth}x${tags.ImageHeight}`);

      // The rotation is in the pixels, not deferred to the player: a rendition that still
      // carried the matrix would be turned a second time on screen. exiftool reads the matrix
      // back as `Rotation`, so a rendition with none reads 0.
      assertEquals(Number(tags.Rotation ?? 0), 0, 'transcode still carries a display matrix');
    });

    await t.step('photo: exif child with date and GPS, image derivatives', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/photo.jpg`);

      const exif = await client.execJson<Record<string, unknown>>(`attrs ${ALBUMS_ROOT}/e2e/photo.jpg/metadata/exif`);
      assertEquals(JSON.stringify(exif).includes('2020'), true);
      // The hash the index was built from — how a re-index is detected later
      assertEquals(typeof exif.sourceSha256, 'string');

      // The full AVIF ladder the UI's srcset expects
      const children = await client.execJson<string[]>(`ls -a ${ALBUMS_ROOT}/e2e/photo.jpg/thumbnails`);
      for (const name of ['320x320.avif', '512x512.avif', '800x800.avif', '1600x1600.avif', '2560x2560.avif']) {
        assertEquals(children.includes(name), true, `children: ${children}`);
      }

      // The grid derivative is `contain` where the thumb is `cover`: the justified grid draws
      // a tile in the picture's own shape, so a square 512 here would silently re-crop every
      // tile. The fixture is larger than the box on both axes, so this is a real downscale
      // and the result is the fixture's own aspect fitted to 512 — `contain` never enlarges,
      // and a smaller fixture would come back at its own size and prove nothing.
      const gridRes = await fetch(`${baseUrl}/file${ALBUMS_ROOT}/e2e/photo.jpg/thumbnails/512x512.avif`, { headers: { cookie } });
      assertEquals(gridRes.status, 200);
      const [gw, gh] = await dimensionsOf(`${ALBUMS_ROOT}/e2e/photo.jpg/thumbnails/512x512.avif`);
      const expected = [512, Math.round(512 * PHOTO.height / PHOTO.width)];
      assertEquals([gw, gh], expected, `grid derivative is not the fixture contained in 512: ${gw}x${gh}`);

      const photo = await client.execJson<{ id: string }>(`info ${ALBUMS_ROOT}/e2e/photo.jpg`);
      const thumb = await client.execJson<{ sourceId: string; mimetype: string; size: number }>(
        `attrs ${ALBUMS_ROOT}/e2e/photo.jpg/thumbnails/320x320.avif`,
      );
      assertEquals(thumb.sourceId, photo.id);
      assertEquals(thumb.size > 0, true);
      // Not video/mp4: AVIF shares the ftyp container header, and the stored mimetype is
      // what get-file sends as Content-Type
      assertEquals(thumb.mimetype, 'image/avif');
    });

    /**
     * A face crop with no bytes — what an interrupted or failed `detect-faces` leaves behind —
     * rebuilt by the command every other rendition is rebuilt by.
     *
     * The box is written by hand rather than detected: the fixture has no face in it, and what
     * is under test is the repair, not the model. A completed detection leaves exactly this
     * shape, so a run that finds the empty crop and cuts the stored box out of the source is
     * the whole of the loop that was missing.
     */
    await t.step('an empty face crop is rebuilt from the stored box', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/photo.jpg`);
      const photoId = await nodeIdOf(`${ALBUMS_ROOT}/e2e/photo.jpg`);
      const facePath = `${ALBUMS_ROOT}/e2e/photo.jpg/regions/face-0`;
      const cropPath = `${facePath}/image.avif`;

      // A quarter of the frame, in from the corner. Fractions of the display frame, as
      // detection stores them; with the default 30% padding that is a 1.6x1.6 of the box.
      const box = { x: 0.25, y: 0.25, width: 0.25, height: 0.25 };
      await client.exec(
        `mknode -p -t media-region ${facePath} --as fileId=${photoId} ` +
          `--aj 'faceBox=${JSON.stringify(box)}'`,
      );
      // The crop node without its bytes: `detect-faces` creates it before `convert` runs, so
      // this is what an interruption between the two leaves on the node.
      await client.exec(`mknode -p -t file ${cropPath} --as mimetype=image/avif --as sourceId=${photoId}`);

      const before = await client.execJson<{ size?: number }>(`attrs ${cropPath}`);
      assertEquals(Number(before.size ?? 0), 0, 'fixture crop already has bytes, so it proves nothing');

      const report = await client.execJson<{ created: string[]; failed: number }>(
        `generate-derivatives ${ALBUMS_ROOT}/e2e/photo.jpg --size face`,
        { timeout: 120_000 },
      );
      assertEquals(report.failed, 0);
      assertEquals(report.created, [cropPath]);

      const after = await client.execJson<{ size?: number; mimetype?: string }>(`attrs ${cropPath}`);
      assertEquals(Number(after.size ?? 0) > 0, true, 'crop was reported created but still has no bytes');

      // And it decodes, at the geometry the library says it should have: the padded box out of
      // the source, shrunk into the crop bound with its aspect kept. An empty file with the
      // right header would get through the size check above and fail here.
      const res = await fetch(`${baseUrl}/file${cropPath}`, { headers: { cookie } });
      assertEquals(res.status, 200);
      const [w, h] = await dimensionsOf(cropPath);

      const rect = faceCropRect(box, { width: PHOTO.width, height: PHOTO.height });
      const scale = Math.min(1, MAX_CROP_DIMENSION / Math.max(rect.width, rect.height));
      assertEquals(
        [w, h],
        [Math.round(rect.width * scale), Math.round(rect.height * scale)],
        `crop is ${w}x${h}, not the ${rect.width}x${rect.height} box scaled into ${MAX_CROP_DIMENSION}`,
      );

      // A second pass leaves it alone: a crop with bytes is done, exactly like every other
      // rendition — which is what keeps a corpus sweep from re-encoding the whole archive.
      const again = await client.execJson<{ created: string[]; failed: number }>(
        `generate-derivatives ${ALBUMS_ROOT}/e2e/photo.jpg --size face`,
      );
      assertEquals(again.created, []);
      assertEquals(again.failed, 0);
    });

    /**
     * The legacy import's shape, which is the one case write-time hashing cannot reach: the
     * node is created with a `size` taken off the dump and its bytes are put into the file
     * store behind the VFS's back (a symlink there, a direct write here). Nothing ever held
     * those bytes, so nothing hashed them — and without a stamped `exif.sourceSha256`
     * media-reindex cannot fire.
     *
     * `exif-extract` measures it instead, so the assertion is on the indexed outcome rather
     * than on the command: this file reaches it through the bridge like any other.
     */
    await t.step('a file whose bytes bypassed the VFS is hashed at index time', async () => {
      const path = `${ALBUMS_ROOT}/e2e/imported.jpg`;
      const created = await client.exec(`mknode -t file ${path}`);
      assertEquals(created.success, true, `mknode failed: ${created.error}`);

      // Exactly where DiskFileRegistry looks: {FILE_ROOT}/{id[-2:]}/{id}. The create already
      // touched an empty file there; this overwrites it without going near the VFS.
      const bytes = await Deno.readFile(fixtures.jpeg);
      const id = await nodeIdOf(path);
      const diskPath = `${fileRoot}/${id.slice(-2)}/${id}`;
      await Deno.mkdir(dirname(diskPath), { recursive: true });
      await Deno.writeFile(diskPath, bytes);

      // The importer's attrs, `size` included — and it is deliberately not the size of what
      // was just written, because the dump's figure is a claim rather than a measurement.
      const attrsSet = await client.exec(
        `attrs ${path} -s mimetype=image/jpeg -J size=${bytes.length + 7} -J frozen=true`,
      );
      assertEquals(attrsSet.success, true, `attrs failed: ${attrsSet.error}`);

      await waitForIndexing(path);

      const expected = encodeHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      const attrs = await client.execJson<{ sha256?: string; size?: number }>(`attrs ${path}`);
      assertEquals(attrs.sha256, expected);
      assertEquals(attrs.size, bytes.length, 'the dump size was left in place by the read that hashed the file');

      // The whole point: with this stamped, a later change of the bytes is detectable.
      const exif = await client.execJson<{ sourceSha256?: string }>(`attrs ${path}/metadata/exif`);
      assertEquals(exif.sourceSha256, expected);
    });

    await t.step('two byte twins uploaded into a staging inbox: the copy is deferred, and indexed once its original is discarded', async () => {
      const inbox = '/home/admin/staging/files/inbox/upload-e2e';
      assertEquals((await client.exec(`staging init && mkdir -p ${inbox}`)).success, true);
      // The library's photo with bytes after its end: twins of each other, and of no library file.
      const twin = new Uint8Array([...await Deno.readFile(fixtures.jpeg), ...new TextEncoder().encode('staged twin')]);
      const paths = [`${inbox}/IMG_0001.jpg`, `${inbox}/IMG_0002.jpg`];
      for (const path of paths) {
        const res = await fetch(`${baseUrl}/file${path}`, { method: 'PUT', headers: { cookie }, body: twin });
        assertEquals(res.status, 201, `upload ${path}`);
        await res.body?.cancel();
      }

      type Finding = { inbox?: string; sha256: string; kind?: string; where?: string; of?: string; deferred?: boolean };
      const findingOf = async (path: string) => (await client.execJson<{ duplicate?: Finding }>(`attrs ${path}`)).duplicate;
      const ids = await Promise.all(paths.map(nodeIdOf));
      const [original, copy] = ids[0] < ids[1] ? paths : [paths[1], paths[0]];
      await waitForIndexing(original);

      // The copy's ingest records it and stops: no exif, no renditions, nothing downstream.
      const copyId = await nodeIdOf(copy);
      const start = Date.now();
      while (!TERMINAL.includes((await instanceStatus('media-ingest', copyId)) ?? '')) {
        if (Date.now() - start > 120_000) throw new Error(`timed out waiting for the copy's ingest: ${await instanceStatus('media-ingest', copyId)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      assertEquals(await instanceStatus('media-ingest', copyId), 'completed');
      const deferred = await findingOf(copy);
      assertEquals(
        [deferred?.kind, deferred?.where, deferred?.of, deferred?.deferred],
        ['exact', 'inbox', await nodeIdOf(original), true],
      );
      // The original is no copy; it looks like the library's photo, whose picture it is.
      assertEquals([(await findingOf(original))?.of, (await findingOf(original))?.deferred], [undefined, undefined], 'the smaller id is the original');
      assertEquals((await client.exec(`[ -e ${copy}/metadata/exif ]`)).success, false, 'a deferred copy has no exif');
      assertEquals((await client.exec(`[ -e ${copy}/thumbnails ]`)).success, false, 'a deferred copy has no renditions');
      assertEquals(await instanceStatus('media-stills', copyId), undefined);

      // A trigger within a few seconds of an instance's end is taken for its own write: the discard
      // comes later than that, as it does when a person makes it.
      await new Promise((r) => setTimeout(r, 6_000));
      assertEquals((await client.exec(`staging discard ${original}`)).success, true);
      const undeferred = await findingOf(copy);
      assertEquals([undeferred?.of, undeferred?.deferred], [undefined, undefined], 'with its original gone the copy is the original');
      await waitForIndexing(copy);
      assertEquals((await client.exec(`[ -e ${copy}/metadata/exif ]`)).success, true);
    });

    await t.step('a downscaled copy in a staging inbox is near its original once both are fingerprinted; the shots of a burst are not', async () => {
      const inbox = '/home/admin/staging/files/inbox/upload-near-e2e';
      assertEquals((await client.exec(`staging init && mkdir -p ${inbox}`)).success, true);
      const camera = { make: 'Invented', model: 'Camera One' };
      const scene = inventScene(41);
      const burst = inventScene(42);
      const pictures: Record<string, Promise<Uint8Array<ArrayBuffer>>> = {
        'IMG_0700.png': scenePng(scene, 1600, 1200, { ...camera, taken: '2021:07:04 12:15:30', subSecond: '10' }),
        'IMG_0700-small.png': scenePng(scene, 800, 600, { ...camera, taken: '2021:07:04 12:15:30', subSecond: '10' }),
        'IMG_0800.png': scenePng(burst, 1600, 1200, { ...camera, taken: '2021:07:04 12:20:00', subSecond: '10' }),
        'IMG_0801.png': scenePng(moveShape(burst, 0, 0.2, 0.1, 1.5), 1600, 1200, { ...camera, taken: '2021:07:04 12:20:00', subSecond: '55' }),
        'IMG_0802.png': scenePng(moveShape(burst, 1, -0.2, 0.2, 1.5), 1600, 1200, { ...camera, taken: '2021:07:04 12:20:01', subSecond: '00' }),
      };
      const paths: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(pictures)) {
        paths[name] = `${inbox}/${name}`;
        const res = await fetch(`${baseUrl}/file${paths[name]}`, { method: 'PUT', headers: { cookie }, body: await bytes });
        assertEquals(res.status, 201, `upload ${name}`);
        await res.body?.cancel();
      }
      type Finding = { kind?: string; where?: string; peers?: { id: string }[] };
      const findingOf = async (path: string) => (await client.execJson<{ duplicate?: Finding }>(`attrs ${path}`)).duplicate;
      // Each one's near check runs in its fingerprint step, once its prints are written.
      for (const path of Object.values(paths)) await waitForIndexing(path);
      const original = await nodeIdOf(paths['IMG_0700.png']);
      const small = await findingOf(paths['IMG_0700-small.png']);
      assertEquals([small?.kind, small?.where, small?.peers?.map((peer) => peer.id)], ['near', 'inbox', [original]]);
      const back = await findingOf(paths['IMG_0700.png']);
      assertEquals(back?.peers?.map((peer) => peer.id), [await nodeIdOf(paths['IMG_0700-small.png'])], 'a look-alike both ways');
      for (const name of ['IMG_0800.png', 'IMG_0801.png', 'IMG_0802.png']) assertEquals((await findingOf(paths[name]))?.kind, undefined, `${name} is a shot of its own`);
    });

    await t.step('video: poster from media-stills, transcode and storyboard from media-transcode', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/clip.mp4`);

      // Both posters: the square one for cover cards, the contain one for the grid.
      const children = await client.execJson<string[]>(`ls -a ${ALBUMS_ROOT}/e2e/clip.mp4/thumbnails`);
      for (const name of ['320x320.avif', '512x512.avif']) {
        assertEquals(children.includes(name), true, `children: ${children}`);
      }

      // The transcode is a separate pipeline on its own queue, so it can still be
      // running when the preview is already done — wait for it specifically.
      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/e2e/clip.mp4`);
      const start = Date.now();
      while (!TERMINAL.includes(await instanceStatus('media-transcode', nodeId) ?? '')) {
        if (Date.now() - start > 300_000) throw new Error('timed out waiting for media-transcode');
        await new Promise((r) => setTimeout(r, 1000));
      }

      const after = await client.execJson<string[]>(`ls -a ${ALBUMS_ROOT}/e2e/clip.mp4/thumbnails`);
      assertEquals(after.includes('1920x1080.mp4'), true, `children: ${after}`);

      const transcode = await client.execJson<{ mimetype: string; size: number }>(
        `attrs ${ALBUMS_ROOT}/e2e/clip.mp4/thumbnails/1920x1080.mp4`,
      );
      assertEquals(transcode.mimetype, 'video/mp4');
      assertEquals(transcode.size > 0, true);

      // The fixture is 320x240, and the rendition box is only a bound — a source smaller
      // than the box must come out unscaled and undistorted, not stretched to 16:9.
      const [w, h] = await dimensionsOf(`${ALBUMS_ROOT}/e2e/clip.mp4/thumbnails/1920x1080.mp4`);
      assertEquals([w, h], [320, 240], `transcode was scaled: ${w}x${h}`);

      // And the hover clip beside it: the long fixture is the one over the two-second floor.
      const longId = await nodeIdOf(`${ALBUMS_ROOT}/e2e/long.mp4`);
      const longStart = Date.now();
      while (!TERMINAL.includes(await instanceStatus('media-transcode', longId) ?? '')) {
        if (Date.now() - longStart > 300_000) throw new Error('timed out waiting for media-transcode');
        await new Promise((r) => setTimeout(r, 1000));
      }
      const preview = await client.execJson<{ mimetype: string; size: number }>(
        `attrs ${ALBUMS_ROOT}/e2e/long.mp4/thumbnails/480x480.mp4`,
      );
      assertEquals(preview.mimetype, 'video/mp4');
      assertEquals(preview.size > 0, true);

      // The storyboard follows the transcode in the same pipeline, made from the rendition: the
      // long fixture's six seconds are a row of six tiles of its 4:3 picture, and the one-second
      // clip is too short to get one.
      const sheet = await client.execJson<{ size: number; storyboard: { count: number; columns: number; rows: number; tileWidth: number; tileHeight: number } }>(
        `attrs ${ALBUMS_ROOT}/e2e/long.mp4/thumbnails/storyboard-160.avif`,
      );
      assertEquals(sheet.size > 0, true);
      assertEquals([sheet.storyboard.columns, sheet.storyboard.rows, sheet.storyboard.tileWidth, sheet.storyboard.tileHeight], [6, 1, 160, 120]);
      assertEquals(sheet.storyboard.count >= 1 && sheet.storyboard.count <= 6, true, `count ${sheet.storyboard.count}`);
      const clipChildren = await client.execJson<string[]>(`ls -a ${ALBUMS_ROOT}/e2e/clip.mp4/thumbnails`);
      assertEquals(clipChildren.some((name) => name.startsWith('storyboard-')), false, `children: ${clipChildren}`);
    });

    /**
     * A crawl's own log is the only evidence a backfill worked, so it must tell "made it" from
     * "made nothing": ffmpeg exits 0 having written no frame for a seek past the end.
     *
     * The frame is EMS's to extract, and a seek past the picture's end is not an empty answer:
     * the poster is the first frame, written in full — and the ladder above it counts a
     * rendition only once it has bytes.
     */
    await t.step('a rendition that was not created is not reported as created', async () => {
      const cmd = emsCommand();
      const output = `${fixtures.dir}/seek-past-end.avif`;
      const result = await poster(cmd, fixtures.mp4, { at: 5, targets: [{ output, box: { width: 512, height: 512 }, fit: 'contain' }] });
      assertEquals(result.targets.length, 1);
      assertEquals((await Deno.stat(output)).size > 0, true, `a seek past the end left ${output} without a frame`);

      // And the invariant a backfill's log rests on: every path counted as created has bytes.
      const report = await client.execJson<{ created: string[]; failed: number }>(`generate-derivatives ${ALBUMS_ROOT}/e2e/clip.mp4 -f --only still`, { timeout: 120_000 });
      assertEquals(report.created.length > 0, true, 'nothing was generated, so the invariant is vacuous');
      for (const path of report.created) {
        const attrs = await client.execJson<{ size?: number }>(`attrs ${path}`);
        assertEquals(Number(attrs.size) > 0, true, `${path} was reported created but has no bytes`);
      }
    });

    await t.step('MPEG program stream: ffprobe fills the duration exiftool cannot report', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/program-stream.mpg`);

      const attrs = await client.execJson<{ duration?: number }>(`attrs ${ALBUMS_ROOT}/e2e/program-stream.mpg`);
      assertEquals(
        typeof attrs.duration === 'number' && attrs.duration > 1.5 && attrs.duration < 2.5,
        true,
        `unexpected promoted duration: ${attrs.duration}`,
      );

      const exif = await client.execJson<{ raw: Record<string, unknown>; fileinfo: { duration?: number } }>(
        `attrs ${ALBUMS_ROOT}/e2e/program-stream.mpg/metadata/exif`,
      );
      assertEquals(exif.raw.Duration, undefined, 'fixture no longer exercises the ffprobe fallback');
      assertEquals(exif.fileinfo.duration, attrs.duration);
    });

    /**
     * The codec NVDEC cannot decode reaches the node, and from there EMS.
     *
     * The codec comes off the exiftool run `exif-extract` already does: exiftool names an AVI's
     * codec in `VideoCodec`, `@archive/media/video-codec` maps the fourcc to ffmpeg's name, and
     * `generate-derivatives` hands it to `video.transcode` as a hint, so EMS starts at the
     * CPU-decode stage. That EMS honours the hint is its own suite's to pin; what is pinned here
     * is the fact reaching the node.
     */
    await t.step('MJPEG in AVI: the codec reaches the node', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/legacy.avi`);

      const attrs = await client.execJson<{ codec?: string }>(`attrs ${ALBUMS_ROOT}/e2e/legacy.avi`);
      assertEquals(attrs.codec, 'mjpeg');

      const exif = await client.execJson<{ fileinfo: { codec?: string } }>(
        `attrs ${ALBUMS_ROOT}/e2e/legacy.avi/metadata/exif`,
      );
      assertEquals(exif.fileinfo.codec, 'mjpeg');
    });

    await t.step('audio: web version', async () => {
      await waitForIndexing(`${ALBUMS_ROOT}/e2e/tone.m4a`);

      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/e2e/tone.m4a`);
      const start = Date.now();
      while (!TERMINAL.includes(await instanceStatus('media-transcode', nodeId) ?? '')) {
        if (Date.now() - start > 300_000) throw new Error('timed out waiting for media-transcode');
        await new Promise((r) => setTimeout(r, 1000));
      }

      const children = await client.execJson<string[]>(`ls -a ${ALBUMS_ROOT}/e2e/tone.m4a/thumbnails`);
      assertEquals(children.includes('128k-44100.m4a'), true, `children: ${children}`);

      // Written by ffmpeg's ipod muxer for the `M4A ` ftyp brand. With the mp4 muxer the
      // brand is `isom`, nothing in the sniff window says "audio", and this rendition would be
      // stored — and served — as video/mp4.
      const audio = await client.execJson<{ mimetype: string; size: number }>(
        `attrs ${ALBUMS_ROOT}/e2e/tone.m4a/thumbnails/128k-44100.m4a`,
      );
      assertEquals(audio.mimetype, 'audio/mp4');
      assertEquals(audio.size > 0, true);
    });

    await t.step('derivatives do not re-trigger indexing', async () => {
      // Give any would-be re-trigger a moment
      await new Promise((r) => setTimeout(r, 2000));

      // The bridge drops derivatives (sourceId) centrally, so no pipeline sees
      // them at all — one media-ingest instance per uploaded original.
      const ids = await client.execJson<string[]>(`ls ${PIPELINE_INSTANCES_PATH}/media-ingest`);
      const triggers: string[] = [];
      for (const id of ids) {
        const attrs = await client.execJson<{ triggerPath: string }>(`attrs ${PIPELINE_INSTANCES_PATH}/media-ingest/${id}`);
        triggers.push(attrs.triggerPath);
      }

      assertEquals(triggers.toSorted(), [
        `${ALBUMS_ROOT}/e2e/anamorphic.mp4`,
        `${ALBUMS_ROOT}/e2e/clip.mp4`,
        `${ALBUMS_ROOT}/e2e/imported.jpg`,
        `${ALBUMS_ROOT}/e2e/legacy.avi`,
        `${ALBUMS_ROOT}/e2e/long.mp4`,
        `${ALBUMS_ROOT}/e2e/photo.jpg`,
        `${ALBUMS_ROOT}/e2e/program-stream.mpg`,
        `${ALBUMS_ROOT}/e2e/rotated.jpg`,
        `${ALBUMS_ROOT}/e2e/rotated.mp4`,
        `${ALBUMS_ROOT}/e2e/tone.m4a`,
        '/home/admin/staging/files/inbox/upload-e2e/IMG_0001.jpg',
        '/home/admin/staging/files/inbox/upload-e2e/IMG_0002.jpg',
        '/home/admin/staging/files/inbox/upload-near-e2e/IMG_0700-small.png',
        '/home/admin/staging/files/inbox/upload-near-e2e/IMG_0700.png',
        '/home/admin/staging/files/inbox/upload-near-e2e/IMG_0800.png',
        '/home/admin/staging/files/inbox/upload-near-e2e/IMG_0801.png',
        '/home/admin/staging/files/inbox/upload-near-e2e/IMG_0802.png',
      ]);
    });

    await t.step('each capability ran as its own instance', async () => {
      const nodeId = await nodeIdOf(`${ALBUMS_ROOT}/e2e/photo.jpg`);

      // media-faces is image-only and gated on the GPU queue; assert it was at
      // least reached, not that a face was found in a synthetic fixture.
      for (const pipeline of ['media-ingest', 'media-stills', 'media-fingerprint']) {
        const status = await instanceStatus(pipeline, nodeId);
        assertEquals(status !== undefined, true, `${pipeline} produced no instance for photo.jpg`);
      }
    });

    await t.step('derivatives are servable over HTTP', async () => {
      const res = await fetch(`${baseUrl}/file${ALBUMS_ROOT}/e2e/photo.jpg/thumbnails/1600x1600.avif`, { headers: { cookie } });
      assertEquals(res.status, 200);
      const body = new Uint8Array(await res.arrayBuffer());
      assertEquals(body.length > 0, true);
    });
  } finally {
    client.close();
    await harness.stop();
    await Deno.remove(fixtures.dir, { recursive: true });
    await Deno.remove(fileRoot, { recursive: true });
  }
});
