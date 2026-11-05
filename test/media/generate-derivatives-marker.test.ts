/**
 * The marker `generate-derivatives` writes on a file once it has every rendition the table owes
 * it: `renditionsFor`, the signature of the table's entries for the file's kind, and
 * `renditionsAt`. Written by whichever run completes the set, with a refused rendition and a
 * storyboard of a refused playback accounted for; a run that finds everything in place writes
 * nothing, and a run with a failure marks nothing. The signature changes only for the kinds a
 * changed table changes.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals, assertNotEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { readRenditionTable } from '@ein/client';
import type { RenditionTable } from '@ein/api';
import { startStubEms, type StubAnswer } from '@ems/testing';
import { RENDITIONS_AT_ATTR, RENDITIONS_FOR_ATTR, renditionSignature } from '@archive/media/rendition-marker';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-rendition-marker-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

type Report = { created: string[]; pruned: string[]; failed: number; marked: boolean };
type Targets = { targets: { output: { path: string } }[] };

Deno.test({
  name: 'generate-derivatives marks a file once it has every rendition the table owes it',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /** Every still asked for is written; a picture ladder fails while `stillsFail` is set. */
  let stillsFail = false;
  const stills = async (raw: Record<string, unknown>): Promise<StubAnswer> => {
    if (stillsFail) return { error: { code: 'tool_failed', message: 'decode failed', permanent: false }, status: 500 };
    const body = raw as unknown as Targets;
    for (const target of body.targets) await Deno.writeTextFile(target.output.path, 'avif-bytes');
    return { result: { frame: { width: 1920, height: 1080 }, targets: body.targets.map(() => ({ path: '', width: 1, height: 1, bytes: 10 })), t: 1 } };
  };
  const stub = startStubEms({
    ops: {
      'image.renditions': stills,
      'video.poster': stills,
      // The full rendition is over this box's budget; the hover clip is made.
      'video.transcode': async (body) => {
        if ((body.video as { box: { width: number } }).box.width === 1920) {
          return { error: { code: 'refused', message: 'a CPU decode would need 6 windows', permanent: true }, status: 422 };
        }
        await Deno.writeTextFile((body.output as { path: string }).path, 'mp4-bytes');
        return { result: { path: '', width: 480, height: 270, duration: 20, bytes: 9, video_codec: 'av1', audio_codec: null }, producer: 'ffmpeg/9/libsvtav1' };
      },
    },
    capabilities: { encode: { video_encoder: 'libsvtav1', cpu_budget: '4000/170/64' } },
  });
  const env = `CFG_EMS_URL=${stub.url}`;
  const run = (path: string, flags = '') => client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${path} ${flags}`);
  const makeFile = async (name: string, attrs: Record<string, unknown>): Promise<string> => {
    const path = `${ALBUMS_ROOT}/m/${name}`;
    await client.exec(`mkfile ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs });
    return path;
  };
  const marker = async (path: string) => {
    const attrs = (await vfs.get(ADMIN_ACCESS, path)).attrs;
    return { for: attrs[RENDITIONS_FOR_ATTR], at: attrs[RENDITIONS_AT_ATTR] };
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/m`);
    const table = (await readRenditionTable(vfs)).table;

    await t.step('a photo is marked once its pictures are made, and a run that makes nothing writes nothing', async () => {
      const photo = await makeFile('photo.jpg', { mimetype: 'image/jpeg', width: 4000, height: 3000 });
      const first = await run(photo, '--only still');
      assertEquals([first.failed, first.marked], [0, true]);
      const made = await marker(photo);
      assertEquals(made.for, await renditionSignature(table, 'photo'));
      assertEquals(typeof made.at, 'string');

      const again = await run(photo, '--only still');
      assertEquals([again.created, again.marked], [[], false]);
      assertEquals(await marker(photo), made);
    });

    await t.step('a run with a failure marks nothing', async () => {
      const photo = await makeFile('broken.jpg', { mimetype: 'image/jpeg', width: 4000, height: 3000 });
      stillsFail = true;
      try {
        const result = await client.exec(`${env} JSON_OUTPUT=1 generate-derivatives ${photo} --only still`);
        assertEquals(result.success, false);
      } finally {
        stillsFail = false;
      }
      assertEquals(await marker(photo), { for: undefined, at: undefined });
    });

    await t.step('a video is marked by the run that completes it, its refused rendition and that storyboard accounted for', async () => {
      const video = await makeFile('clip.mp4', { mimetype: 'video/mp4', width: 1920, height: 1080, duration: 60 });
      assertEquals((await run(video, '--only still')).marked, false);
      // The full rendition is refused, so its storyboard is never owed; the hover clip is not made yet.
      assertEquals((await run(video, '--only transcode')).marked, false);
      assertEquals((await run(video, '--only storyboard')).marked, false);
      const clip = await run(video, '--only preview');
      assertEquals([clip.created, clip.marked], [[`${video}/thumbnails/480x480.mp4`], true]);
      assertEquals((await marker(video)).for, await renditionSignature(table, 'video'));
    });

    await t.step('a run that makes a rendition writes the marker again', async () => {
      const photo = `${ALBUMS_ROOT}/m/photo.jpg`;
      const before = await marker(photo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const forced = await run(photo, '--only still -f');
      assertEquals(forced.marked, true);
      const after = await marker(photo);
      assertEquals(after.for, before.for);
      assertNotEquals(after.at, before.at);
    });
  } finally {
    client.close();
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test('a changed table changes the signature of the kinds it changed, and no other', async () => {
  const table: RenditionTable = {
    image: {
      thumb: { width: 320, height: 320, fit: 'cover', quality: 55, kinds: ['photo', 'video', 'audio'] },
      large: { width: 2560, height: 2560, fit: 'contain', quality: 60, kinds: ['photo'] },
    },
    video: { playback: { width: 1920, height: 1080, crf: 32, preset: 8, audioBitrate: '128k' } },
    audio: { playback: { bitrate: '128k', sampleRate: 44100 } },
  };
  const signatures = async (changed: RenditionTable) =>
    await Promise.all((['photo', 'video', 'audio'] as const).map(async (kind) => (await renditionSignature(changed, kind)) === (await renditionSignature(table, kind))));

  assertEquals(await signatures(structuredClone(table)), [true, true, true]);
  assertEquals(await signatures({ ...table, audio: { playback: { bitrate: '96k', sampleRate: 44100 } } }), [true, true, false]);
  assertEquals(await signatures({ ...table, image: { ...table.image, large: { ...table.image.large, quality: 70 } } }), [false, true, true]);
  assertEquals(await signatures({ ...table, image: { ...table.image, thumb: { ...table.image.thumb, width: 400 } } }), [false, false, false]);
  // The same table written with its keys in another order is the same table.
  assertEquals(await signatures({ audio: table.audio, video: table.video, image: { large: table.image.large, thumb: table.image.thumb } }), [true, true, true]);
});
