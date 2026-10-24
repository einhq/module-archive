/**
 * The still-image ladder for a source smaller than it. `contain` never upscales, so the first
 * box the picture fits inside stores it at its own size, and every box above would store the
 * same pixels again under a bigger name. `generate-derivatives` leaves those out, and `--prune`
 * removes the copies an earlier run made. The UI's `availableBoxes` mirrors the rule, so which
 * names land here is a contract, not a detail.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { startStubEms } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-small-source-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

type Report = { created: string[]; pruned: string[]; failed: number };
type Body = { targets: { output: { path: string }; box: { width: number; height: number }; fit: string }[] };

Deno.test({
  name: 'generate-derivatives leaves out the sizes a small source would only copy into',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /** The boxes the last ladder call asked for, in order. */
  let asked: number[] = [];
  const stub = startStubEms({
    ops: {
      'image.renditions': async (raw) => {
        const body = raw as unknown as Body;
        asked = body.targets.map((target) => target.box.width);
        for (const target of body.targets) await Deno.writeTextFile(target.output.path, 'avif-bytes');
        return { result: { frame: { width: 600, height: 400 }, targets: body.targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })) } };
      },
      'video.poster': async (raw) => {
        const body = raw as unknown as Body;
        asked = body.targets.map((target) => target.box.width);
        for (const target of body.targets) await Deno.writeTextFile(target.output.path, 'avif-bytes');
        return { result: { frame: { width: 640, height: 480 }, targets: body.targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })) } };
      },
      'audio.waveform': async (raw) => {
        const body = raw as unknown as Body;
        asked = body.targets.map((target) => target.box.width);
        for (const target of body.targets) await Deno.writeTextFile(target.output.path, 'avif-bytes');
        return { result: { targets: body.targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })) } };
      },
    },
  });
  const env = `CFG_EMS_URL=${stub.url}`;

  const makeFile = async (name: string, attrs: Record<string, unknown>): Promise<string> => {
    const path = `${ALBUMS_ROOT}/s/${name}`;
    await client.exec(`mkfile ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs });
    return path;
  };
  const names = async (path: string) => (await vfs.children(ADMIN_ACCESS, `${path}/thumbnails`)).map((c) => c.name).sort();

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/s`);

    await t.step('a 600x400 photo stops at the 800 box; the 320 crop is always made', async () => {
      const image = await makeFile('small.jpg', { mimetype: 'image/jpeg', width: 600, height: 400 });
      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${image} --only still`);
      assertEquals(report.failed, 0);
      assertEquals(asked, [320, 512, 800]);
      assertEquals(await names(image), ['320x320.avif', '512x512.avif', '800x800.avif']);
    });

    /**
     * The rule is about the picture, not the raster: a 400x1000 portrait stored on its side is a
     * 1000x400 raster with angle 90, and it overflows the 800 box by its long side either way.
     */
    await t.step('rotation and pixel aspect are applied before the comparison', async () => {
      const sideways = await makeFile('sideways.jpg', { mimetype: 'image/jpeg', width: 1000, height: 400, angle: 90 });
      await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${sideways} --only still`);
      assertEquals(asked, [320, 512, 800, 1600]);

      // 1440x1080 with sar 4/3 is a 1920x1080 picture: it overflows the 1600 box.
      const video = await makeFile('wide.mts', { mimetype: 'video/mp2t', width: 1440, height: 1080, sar: 4 / 3, duration: 30 });
      await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${video} --only still`);
      assertEquals(asked, [320, 512, 800, 1600]);
    });

    await t.step('a 640x480 video gets posters up to the 800 box', async () => {
      const video = await makeFile('clip.mp4', { mimetype: 'video/mp4', width: 640, height: 480, duration: 30 });
      await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${video} --only still`);
      assertEquals(asked, [320, 512, 800]);
    });

    await t.step('a file without stored dimensions gets the whole ladder', async () => {
      const image = await makeFile('unmeasured.jpg', { mimetype: 'image/jpeg' });
      await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${image} --only still`);
      assertEquals(asked, [320, 512, 800, 1600, 2560]);
    });

    await t.step('a waveform has no source size and is drawn at every box', async () => {
      const audio = await makeFile('talk.mp3', { mimetype: 'audio/mpeg', duration: 30 });
      await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${audio} --only still`);
      assertEquals(asked, [320, 512, 800, 1600]);
    });

    /**
     * The corpus as it stands: every small photo already carries the copies an earlier run made.
     * They are not in the expected set any more, so `--prune` takes them and leaves the rest.
     */
    await t.step('--prune removes the copies an earlier run made', async () => {
      const image = `${ALBUMS_ROOT}/s/small.jpg`;
      for (const name of ['1600x1600.avif', '2560x2560.avif']) {
        await client.exec(`mkfile ${image}/thumbnails/${name}`);
      }
      assertEquals((await names(image)).length, 5);

      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${image} --prune`);
      assertEquals(report.failed, 0);
      assertEquals(report.created, []);
      assertEquals(report.pruned.sort(), [`${image}/thumbnails/1600x1600.avif`, `${image}/thumbnails/2560x2560.avif`]);
      assertEquals(await names(image), ['320x320.avif', '512x512.avif', '800x800.avif']);
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
