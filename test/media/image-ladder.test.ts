import { assertEquals, assertRejects } from '@std/assert';
import type { Command } from '@ein/client';
import { startStubEms } from '@ems/testing';
import { generateImageLadder, renditionTarget, WAVEFORM_STYLE } from '@archive/media/image-ladder';
import { STALE_TEMP_MS } from '@archive/media/staging';

Deno.test('a ladder target is asked for as an AVIF rendition, cover by default', () => {
  assertEquals(
    renditionTarget({ outputPath: '/out/320x320.avif', width: 320, height: 320, quality: 55 }, '/out/.tmp'),
    { output: '/out/.tmp', format: 'avif', quality: 55, box: { width: 320, height: 320 }, fit: 'cover' },
  );
  assertEquals(
    renditionTarget({ outputPath: '/out/800x800.avif', width: 800, height: 800, mode: 'contain' }, '/out/.tmp2'),
    { output: '/out/.tmp2', format: 'avif', box: { width: 800, height: 800 }, fit: 'contain' },
  );
  assertEquals(renditionTarget({ outputPath: '/out/x.avif', width: 100, height: 0, mode: 'fill' }, '/out/.t').box, { width: 100, height: undefined });
  assertEquals(renditionTarget({ outputPath: '/out/x.avif', width: 100, height: 50, mode: 'stretch' }, '/out/.t').fit, 'cover');
});

/**
 * A `Command` over an in-memory node table whose physical paths EMS is "handed". `born` holds
 * creation times; a node without one was created now.
 */
const fakeCommand = (url: string, nodes: Map<string, number>, published: string[], born = new Map<string, number>()) =>
  ({
    access: {},
    env: { CFG_EMS_URL: url, CFG_EMS_CONNECT_RETRY: '0' },
    sys: {
      vfs: {
        create: (_a: unknown, _type: string, parent: string, name: string) => nodes.set(`${parent}/${name}`, 0),
        exists: (_a: unknown, path: string) => Promise.resolve(nodes.has(path)),
        children: (_a: unknown, dir: string) =>
          Promise.resolve(
            [...nodes.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')).map((k) => ({
              name: k.slice(dir.length + 1),
              node: { props: { birthtime: { timestamp: born.get(k) ?? Date.now() } } },
            })),
          ),
        stat: (_a: unknown, path: string) => nodes.has(path) ? Promise.resolve({ path: `/host${path}` }) : Promise.reject(new Error('no node')),
        statX: (_a: unknown, path: string) => Promise.resolve({ size: nodes.get(path), mimetype: 'image/avif' }),
        update: () => Promise.resolve(),
        unlink: (_a: unknown, path: string) => Promise.resolve(nodes.delete(path)),
        rename: (_a: unknown, _dir: string, from: string, _to: string, name: string) => {
          published.push(`${from} -> ${name}`);
          return Promise.resolve();
        },
      },
    },
  }) as unknown as Command;

Deno.test('image ladder asks EMS once per source and dispatches by media type', async () => {
  const nodes = new Map<string, number>([['/albums/a/photo.jpg', 1], ['/albums/a/clip.mp4', 1], ['/albums/a/tape.mp3', 1]]);
  const published: string[] = [];
  const stub = startStubEms({
    ops: {
      'image.renditions': (body) => {
        const targets = body.targets as { output: { path: string } }[];
        for (const t of targets) nodes.set(t.output.path.replace(/^\/host/, ''), 10);
        return { result: { frame: { width: 600, height: 800 }, targets: targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })) }, producer: 'magick/7' };
      },
      'video.poster': (body) => {
        const targets = body.targets as { output: { path: string } }[];
        for (const t of targets) nodes.set(t.output.path.replace(/^\/host/, ''), 10);
        return { result: { frame: { width: 320, height: 240 }, targets: targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })), t: 0 } };
      },
      'audio.waveform': (body) => {
        const targets = body.targets as { output: { path: string } }[];
        for (const t of targets) nodes.set(t.output.path.replace(/^\/host/, ''), 10);
        return { result: { targets: targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })) } };
      },
    },
  });
  try {
    const cmd = fakeCommand(stub.url, nodes, published);
    const targets = [
      { outputPath: '/albums/a/photo.jpg/thumbnails/320x320.avif', width: 320, height: 320, mode: 'cover', quality: 55 },
      { outputPath: '/albums/a/photo.jpg/thumbnails/800x800.avif', width: 800, height: 800, mode: 'contain', quality: 60 },
    ];
    const made = await generateImageLadder(cmd, { path: '/albums/a/photo.jpg', id: 'p', mimetype: 'image/jpeg', angle: 90, mirror: true }, targets);
    assertEquals(made, targets.map((t) => t.outputPath));
    assertEquals(published.length, 2);
    assertEquals(published[0].endsWith('-> 320x320.avif'), true);

    const photo = stub.requests[0];
    assertEquals(photo.op, 'image.renditions');
    assertEquals(photo.body.file, { path: '/host/albums/a/photo.jpg', angle: 90, mirror: true, mimetype: 'image/jpeg' });
    const asked = photo.body.targets as { output: { path: string; format: string; quality: number }; box: unknown; fit: string }[];
    assertEquals(asked.length, 2);
    assertEquals(asked[0].output.path.startsWith('/host/albums/a/photo.jpg/thumbnails/.tmpimage-'), true);
    assertEquals(asked[0].output.format, 'avif');
    assertEquals(asked[0].output.quality, 55);
    assertEquals(asked[0].box, { width: 320, height: 320 });
    assertEquals(asked[0].fit, 'cover');
    assertEquals(asked[1].fit, 'contain');
    // The temps are gone once the finals are in place.
    assertEquals([...nodes.keys()].filter((k) => k.includes('.tmpimage-')), []);

    await generateImageLadder(
      cmd,
      { path: '/albums/a/clip.mp4', id: 'v', mimetype: 'video/mp4', angle: 270, mirror: false },
      [{ outputPath: '/albums/a/clip.mp4/thumbnails/512x512.avif', width: 512, height: 512, mode: 'contain' }],
    );
    const clip = stub.requests[1];
    assertEquals(clip.op, 'video.poster');
    assertEquals(clip.body.at, undefined);
    assertEquals((clip.body.file as { angle: number }).angle, 270);

    await generateImageLadder(
      cmd,
      { path: '/albums/a/tape.mp3', id: 't', mimetype: 'audio/mpeg', angle: 0, mirror: false },
      [{ outputPath: '/albums/a/tape.mp3/thumbnails/320x320.avif', width: 320, height: 320, mode: 'cover' }],
    );
    const tape = stub.requests[2];
    assertEquals(tape.op, 'audio.waveform');
    assertEquals(tape.body.style, WAVEFORM_STYLE);
    assertEquals(tape.body.file, { path: '/host/albums/a/tape.mp3', mimetype: 'audio/mpeg' });
  } finally {
    await stub.close();
  }
});

Deno.test('image ladder validates every output before publication and cleans failed stages', async () => {
  const nodes = new Map<string, number>([['/in/input.jpg', 1], ['/out/one.avif', 101], ['/out/two.avif', 202]]);
  const published: string[] = [];
  const stub = startStubEms({
    ops: {
      // EMS answers as if it wrote both, but only one temp ends up with bytes.
      'image.renditions': (body) => {
        const targets = body.targets as { output: { path: string } }[];
        nodes.set(targets[0].output.path.replace(/^\/host/, ''), 99);
        return { result: { frame: { width: 400, height: 200 }, targets: targets.map(() => ({ path: '', width: 1, height: 1, bytes: 1 })) } };
      },
    },
  });
  try {
    const cmd = fakeCommand(stub.url, nodes, published);
    await assertRejects(
      () =>
        generateImageLadder(cmd, { path: '/in/input.jpg', id: 'source', mimetype: 'image/jpeg', angle: 0, mirror: false }, [
          { outputPath: '/out/one.avif', width: 100, height: 100 },
          { outputPath: '/out/two.avif', width: 200, height: 200 },
        ]),
      Error,
      'wrote no bytes',
    );
    assertEquals(published, []);
    assertEquals([...nodes], [['/in/input.jpg', 1], ['/out/one.avif', 101], ['/out/two.avif', 202]]);
  } finally {
    await stub.close();
  }
});

Deno.test('a refusal from EMS leaves the existing renditions untouched', async () => {
  const nodes = new Map<string, number>([['/in/input.jpg', 1], ['/out/one.avif', 101]]);
  const published: string[] = [];
  const stub = startStubEms({ ops: { 'image.renditions': { error: { code: 'undecodable', message: 'no decode delegate', permanent: true }, status: 422 } } });
  try {
    const cmd = fakeCommand(stub.url, nodes, published);
    await assertRejects(
      () =>
        generateImageLadder(cmd, { path: '/in/input.jpg', id: 's', mimetype: 'image/jpeg', angle: 0, mirror: false }, [{
          outputPath: '/out/one.avif',
          width: 100,
          height: 100,
        }]),
      Error,
      'no decode delegate',
    );
    assertEquals(published, []);
    assertEquals([...nodes], [['/in/input.jpg', 1], ['/out/one.avif', 101]]);
  } finally {
    await stub.close();
  }
});

Deno.test('a ladder run sweeps temps an interrupted run left, not a running one', async () => {
  const old = '/out/.tmpimage-left-by-a-restart.avif';
  const fresh = '/out/.tmpimage-still-being-written.avif';
  const nodes = new Map<string, number>([['/in/input.jpg', 1], [old, 0], [fresh, 0], ['/out/.tmpvideo-left.mp4', 0]]);
  const born = new Map([[old, Date.now() - STALE_TEMP_MS - 1000], ['/out/.tmpvideo-left.mp4', 0]]);
  const stub = startStubEms({
    ops: {
      'image.renditions': (body) => {
        const targets = body.targets as { output: { path: string } }[];
        for (const t of targets) nodes.set(t.output.path.replace(/^\/host/, ''), 10);
        return { result: { frame: { width: 1, height: 1 }, targets: targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })) } };
      },
    },
  });
  try {
    const cmd = fakeCommand(stub.url, nodes, [], born);
    await generateImageLadder(cmd, { path: '/in/input.jpg', id: 's', mimetype: 'image/jpeg', angle: 0, mirror: false }, [
      { outputPath: '/out/one.avif', width: 100, height: 100 },
    ]);
    assertEquals(nodes.has(old), false);
    assertEquals(nodes.has(fresh), true);
    // Another step's temps are its own to sweep.
    assertEquals(nodes.has('/out/.tmpvideo-left.mp4'), true);
  } finally {
    await stub.close();
  }
});
