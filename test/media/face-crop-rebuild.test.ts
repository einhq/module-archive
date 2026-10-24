/**
 * What `writeFaceCrop` asks EMS for, per source family.
 *
 * No dimensions travel: the box is a fraction of the display frame, and EMS resolves it against
 * the raster it decodes (a RAW's sensor image, a HEIC libheif has already turned). What the
 * caller owes is the node's orientation and mimetype, so EMS can work out the residual.
 */

import { assertEquals } from '@std/assert';
import type { Command } from '@ein/client';
import { startStubEms } from '@ems/testing';
import { CROP_PADDING, CROP_QUALITY, MAX_CROP_DIMENSION } from '@archive/media/face-crop';
import { MAX_RENDITION_TARGETS } from '@ems/client';
import { rebuildFaceCrops, writeFaceCrop, writeFaceCrops } from '@archive/media/face-crop-rebuild';
import { REGION_TYPE } from '@archive/media/regions';

const BOX = { x: 0.25, y: 0.25, width: 0.25, height: 0.25 };

const fakeCommand = (url: string, synced: string[], updated: Record<string, unknown> = {}) =>
  ({
    access: {},
    env: { CFG_EMS_URL: url, CFG_EMS_CONNECT_RETRY: '0' },
    sys: {
      vfs: {
        stat: (_a: unknown, path: string) => Promise.resolve({ path: `/host${path}` }),
        update: (_a: unknown, path: string, change: { attrs: unknown }) => {
          updated[path] = change.attrs;
          return Promise.resolve();
        },
      },
    },
    execute: (line: string) => {
      synced.push(line);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  }) as unknown as Command;

Deno.test('a crop is asked for in the node frame, with the node orientation, and then synced', async () => {
  const stub = startStubEms({ ops: { 'image.renditions': { result: { frame: { width: 3024, height: 4032 }, targets: [{ path: '', width: 200, height: 200, bytes: 1 }] } } } });
  const synced: string[] = [];
  try {
    const cmd = fakeCommand(stub.url, synced);
    const failure = await writeFaceCrop(cmd, '/albums/a/IMG_1.HEIC', '/albums/a/IMG_1.HEIC/faces/face-0/image.avif', BOX, {
      mimetype: 'image/heic',
      angle: 270,
      mirror: 'true',
    });
    assertEquals(failure, null);
    assertEquals(stub.requests[0].body, {
      file: { path: '/host/albums/a/IMG_1.HEIC', angle: 270, mirror: true, mimetype: 'image/heic' },
      targets: [{
        output: { path: '/host/albums/a/IMG_1.HEIC/faces/face-0/image.avif', format: 'avif', quality: CROP_QUALITY },
        box: { width: MAX_CROP_DIMENSION, height: MAX_CROP_DIMENSION },
        fit: 'contain',
        crop: BOX,
        pad: CROP_PADDING,
      }],
    });
    assertEquals(synced, ["file-sync '/albums/a/IMG_1.HEIC/faces/face-0/image.avif'"]);
  } finally {
    await stub.close();
  }
});

Deno.test('a refused crop is reported, not thrown, and nothing is synced', async () => {
  const stub = startStubEms({ ops: { 'image.renditions': { error: { code: 'undecodable', message: 'no decode delegate', permanent: true }, status: 422 } } });
  const synced: string[] = [];
  try {
    const failure = await writeFaceCrop(fakeCommand(stub.url, synced), '/albums/a/x.raf', '/albums/a/x.raf/faces/face-0/image.avif', BOX, {
      mimetype: 'image/x-fujifilm-raf',
    });
    assertEquals(failure, 'ems: image.renditions: no decode delegate (undecodable)');
    assertEquals(synced, []);
  } finally {
    await stub.close();
  }
});

Deno.test('every crop of an image is one call, and one decode', async () => {
  const stub = startStubEms({
    ops: {
      'image.renditions': (body) => ({
        result: { frame: { width: 3456, height: 2304 }, targets: (body.targets as unknown[]).map((_, i) => ({ path: '', width: 300 + i, height: 384, bytes: 1 })) },
      }),
    },
  });
  const synced: string[] = [];
  const updated: Record<string, unknown> = {};
  try {
    const failure = await writeFaceCrops(fakeCommand(stub.url, synced, updated), '/albums/a/IMG_8197.JPG', [
      { output: '/albums/a/IMG_8197.JPG/faces/face-0/image.avif', box: BOX },
      { output: '/albums/a/IMG_8197.JPG/faces/manual-0/image.avif', box: { x: 0.2, y: 0.3, width: 0.4, height: 0.6 } },
    ], { mimetype: 'image/jpeg' });
    assertEquals(failure, null);
    assertEquals(stub.requests.length, 1);
    const targets = stub.requests[0].body.targets as { output: { path: string }; crop: unknown }[];
    assertEquals(targets.map((t) => t.output.path), ['/host/albums/a/IMG_8197.JPG/faces/face-0/image.avif', '/host/albums/a/IMG_8197.JPG/faces/manual-0/image.avif']);
    assertEquals(targets[1].crop, { x: 0.2, y: 0.3, width: 0.4, height: 0.6 });
    assertEquals(synced.length, 2);
    // The encoded size lands on each crop node, so a grid can lay the crops out before they load.
    assertEquals(updated, {
      '/albums/a/IMG_8197.JPG/faces/face-0/image.avif': { width: 300, height: 384 },
      '/albums/a/IMG_8197.JPG/faces/manual-0/image.avif': { width: 301, height: 384 },
    });
    assertEquals(await writeFaceCrops(fakeCommand(stub.url, synced), '/albums/a/x.jpg', [], {}), null);
    assertEquals(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

Deno.test('more faces than one call takes are cut in calls EMS accepts', async () => {
  const stub = startStubEms({
    ops: {
      'image.renditions': (body) => {
        const targets = body.targets as unknown[];
        if (targets.length > MAX_RENDITION_TARGETS) return { error: { code: 'invalid_request', message: 'too many targets' }, status: 400 };
        return { result: { frame: { width: 6000, height: 4000 }, targets: targets.map(() => ({ path: '', width: 100, height: 120, bytes: 1 })) } };
      },
    },
  });
  const synced: string[] = [];
  const faces = Array.from({ length: 45 }, (_, i) => ({ name: `face-${i}`, node: { type: REGION_TYPE, attrs: { faceBox: BOX } } }));
  const cmd = fakeCommand(stub.url, synced);
  Object.assign(cmd.sys.vfs, {
    children: () => Promise.resolve(faces),
    get: () => Promise.resolve({ attrs: { size: 0 } }),
  });
  try {
    const result = await rebuildFaceCrops(cmd, { source: '/albums/a/group.jpg', sourceId: 'id', attrs: { mimetype: 'image/jpeg' } });
    assertEquals(result.failed, []);
    assertEquals(result.written.length, 45);
    assertEquals(stub.requests.map((r) => (r.body.targets as unknown[]).length), [32, 13]);
    assertEquals(synced.length, 45);
  } finally {
    await stub.close();
  }
});

Deno.test('a video crop is cut from the frame its face was seen in, one call a frame', async () => {
  const stub = startStubEms({
    ops: {
      'video.poster': (body) => ({
        result: { frame: { width: 1920, height: 1080 }, t: body.at, targets: (body.targets as unknown[]).map(() => ({ path: '', width: 200, height: 220, bytes: 1 })) },
      }),
    },
  });
  const synced: string[] = [];
  const updated: Record<string, unknown> = {};
  try {
    const failure = await writeFaceCrops(fakeCommand(stub.url, synced, updated), '/albums/a/MVI_1.MP4', [
      { output: '/albums/a/MVI_1.MP4/regions/face-0/image.avif', box: BOX, at: 12.5 },
      { output: '/albums/a/MVI_1.MP4/regions/face-1/image.avif', box: BOX, at: 40 },
      { output: '/albums/a/MVI_1.MP4/regions/face-2/image.avif', box: { x: 0.6, y: 0.2, width: 0.1, height: 0.2 }, at: 12.5 },
    ], { mimetype: 'video/mp4', angle: 90 });
    assertEquals(failure, null);
    assertEquals(stub.requests.map((r) => [r.op, r.body.at, (r.body.targets as unknown[]).length]), [['video.poster', 12.5, 2], ['video.poster', 40, 1]]);
    assertEquals(stub.requests[0].body.file, { path: '/host/albums/a/MVI_1.MP4', angle: 90, mirror: false, mimetype: 'video/mp4' });
    assertEquals(synced.length, 3);
    assertEquals(updated['/albums/a/MVI_1.MP4/regions/face-1/image.avif'], { width: 200, height: 220 });
  } finally {
    await stub.close();
  }
});

Deno.test('a rebuilt video crop is cut at the second its region records', async () => {
  const stub = startStubEms({
    ops: { 'video.poster': (body) => ({ result: { frame: { width: 1920, height: 1080 }, t: body.at, targets: [{ path: '', width: 100, height: 120, bytes: 1 }] } }) },
  });
  const synced: string[] = [];
  const cmd = fakeCommand(stub.url, synced);
  Object.assign(cmd.sys.vfs, {
    children: () => Promise.resolve([{ name: 'face-0', node: { type: REGION_TYPE, attrs: { faceBox: BOX, atSeconds: 7.25 } } }]),
    get: () => Promise.resolve({ attrs: { size: 0 } }),
  });
  try {
    const result = await rebuildFaceCrops(cmd, { source: '/albums/a/MVI_1.MP4', sourceId: 'id', attrs: { mimetype: 'video/mp4' } });
    assertEquals(result.written, ['/albums/a/MVI_1.MP4/regions/face-0/image.avif']);
    assertEquals(stub.requests[0].body.at, 7.25);
  } finally {
    await stub.close();
  }
});
