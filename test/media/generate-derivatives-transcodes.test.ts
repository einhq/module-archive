/**
 * The transcoded renditions as `generate-derivatives` makes them through EMS: the node is
 * staged, EMS writes the bytes, the size is checked and the temp is swapped in — and a
 * refusal is recorded on the file node with EMS's budget signature, then cleared the moment
 * the rendition is made. The encoding itself is EMS's; this is about what lands on the nodes.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { TRANSCODE_REFUSED_ATTR, type TranscodeRefusal } from '@archive/media/event-rules';
import { startStubEms, type StubAnswer } from '@ems/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-transcodes-' });
const testCtx = createTestContext({ modules: ['archive'], fileRoot });

type Report = { created: string[]; pruned: string[]; failed: number };

Deno.test({
  name: 'generate-derivatives makes the transcodes through EMS',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /** What the stub answers a transcode with; `write` puts bytes at the output EMS was handed. */
  let answer: (op: string, body: Record<string, unknown>) => Promise<StubAnswer>;
  const written = async (body: Record<string, unknown>, bytes: string) => {
    const output = (body.output as { path: string }).path;
    await Deno.writeTextFile(output, bytes);
  };
  const stub = startStubEms({
    ops: {
      'video.transcode': (body) => answer('video.transcode', body),
      'audio.transcode': (body) => answer('audio.transcode', body),
    },
    capabilities: { encode: { video_encoder: 'libsvtav1', cpu_budget: '4000/170/64' } },
  });
  const env = `CFG_EMS_URL=${stub.url}`;

  const makeVideo = async (name: string, duration: number): Promise<string> => {
    const path = `${ALBUMS_ROOT}/t/${name}`;
    await client.exec(`mkfile ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'video/quicktime', width: 720, height: 576, duration, codec: 'dvvideo', angle: 90 } });
    return path;
  };

  try {
    await client.exec(`mkdir -p ${ALBUMS_ROOT}/t`);

    await t.step('a refused rendition is recorded with the budget EMS reports, and the rest still made', async () => {
      const video = await makeVideo('tape.mov', 5040);
      const asked: Record<string, unknown>[] = [];
      answer = async (_op, body) => {
        asked.push(body);
        const box = (body.video as { box: { width: number } }).box;
        if (box.width === 1920) {
          return { error: { code: 'refused', message: 'a CPU decode of 126000 frames would need 6 windows', permanent: true }, status: 422 };
        }
        await written(body, 'mp4-bytes');
        return { result: { path: '', width: 480, height: 360, duration: 20, bytes: 9, video_codec: 'av1', audio_codec: null }, producer: 'ffmpeg/9/libsvtav1' };
      };

      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${video} --only transcode`);
      assertEquals(report.failed, 0);
      assertEquals(report.created, [`${video}/thumbnails/480x480.mp4`]);

      // What EMS was asked: the node's orientation and codec travel as facts, the hover clip is
      // clipped and muted, the full rendition carries its audio.
      const full = asked.find((b) => (b.video as { box: { width: number } }).box.width === 1920)!;
      const preview = asked.find((b) => (b.video as { box: { width: number } }).box.width === 480)!;
      assertEquals((full.file as { angle: number }).angle, 90);
      assertEquals(full.hints, { source_codec: 'dvvideo' });
      assertEquals(full.audio, { bitrate: '128k' });
      assertEquals(full.clip, undefined);
      assertEquals(preview.audio, null);
      assertEquals(preview.clip, { start: 1, duration: 20 });
      // EMS is handed the physical file of the temp sibling under the disk root, never a VFS path.
      assertEquals(String((preview.output as { path: string }).path).startsWith(fileRoot), true, `EMS was handed ${(preview.output as { path: string }).path}`);

      const node = await vfs.get(ADMIN_ACCESS, video);
      const refusals = node.attrs[TRANSCODE_REFUSED_ATTR] as Record<string, TranscodeRefusal>;
      assertEquals(Object.keys(refusals), ['1920x1080.mp4']);
      assertEquals(refusals['1920x1080.mp4'].reason, 'a CPU decode of 126000 frames would need 6 windows');
      assertEquals(refusals['1920x1080.mp4'].budget, '4000/170/64');

      // The preview is published with its bytes, and no temp is left beside it.
      const made = await vfs.get(ADMIN_ACCESS, `${video}/thumbnails/480x480.mp4`);
      assertEquals(Number(made.attrs.size), 9);
      assertEquals((await vfs.children(ADMIN_ACCESS, `${video}/thumbnails`)).map((c) => c.name), ['480x480.mp4']);
    });

    await t.step('a rendition made after all clears its refusal', async () => {
      const video = `${ALBUMS_ROOT}/t/tape.mov`;
      answer = async (_op, body) => {
        await written(body, 'mp4-bytes-now');
        return { result: { path: '', width: 1920, height: 1080, duration: 5040, bytes: 13, video_codec: 'av1', audio_codec: 'aac' }, producer: 'ffmpeg/9/av1_nvenc/upload' };
      };

      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${video} --only transcode`);
      assertEquals(report.failed, 0);
      assertEquals(report.created, [`${video}/thumbnails/1920x1080.mp4`]);

      const node = await vfs.get(ADMIN_ACCESS, video);
      assertEquals(node.attrs[TRANSCODE_REFUSED_ATTR], undefined);
    });

    await t.step('a failed encode counts as failed and leaves the old rendition in place', async () => {
      const video = `${ALBUMS_ROOT}/t/tape.mov`;
      answer = async () => ({ error: { code: 'tool_failed', message: 'encoding failed: exit 1', permanent: false }, status: 500 });

      const result = await client.exec(`${env} JSON_OUTPUT=1 generate-derivatives ${video} --only transcode -f`);
      assertEquals(result.success, false, 'a failed encode must fail the step');
      assertEquals(String(result.error).includes('encoding failed'), true, `expected the encode failure, got ${result.error}`);
      const made = await vfs.get(ADMIN_ACCESS, `${video}/thumbnails/1920x1080.mp4`);
      assertEquals(Number(made.attrs.size), 13, 'the old rendition must survive a failed re-encode');
      assertEquals((await vfs.children(ADMIN_ACCESS, `${video}/thumbnails`)).map((c) => c.name).sort(), ['1920x1080.mp4', '480x480.mp4']);
    });

    await t.step('an audio file gets its m4a with the ceilings from sizes.yaml', async () => {
      const audio = `${ALBUMS_ROOT}/t/tape.mp3`;
      await client.exec(`mkfile ${audio}`);
      await vfs.update(ADMIN_ACCESS, audio, { attrs: { mimetype: 'audio/mpeg', duration: 2756 } });
      let askedBody: Record<string, unknown> | undefined;
      answer = async (op, body) => {
        assertEquals(op, 'audio.transcode');
        askedBody = body;
        await written(body, 'm4a-bytes');
        return { result: { path: '', duration: 2756, bytes: 9, bitrate: 64000, sample_rate: 44100, channels: 1, remuxed: false }, producer: 'ffmpeg/9/aac' };
      };

      const report = await client.execJson<Report>(`${env} JSON_OUTPUT=1 generate-derivatives ${audio} --only transcode`);
      assertEquals(report.failed, 0);
      assertEquals(report.created, [`${audio}/thumbnails/128k-44100.m4a`]);
      assertEquals(askedBody?.audio, { bitrate: '128k', sample_rate: 44100 });
      assertEquals((askedBody?.output as { format: string }).format, 'm4a');
    });
  } finally {
    await stub.close();
    await testCtx.teardown();
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
