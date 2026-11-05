/**
 * `renditions-scan` finds the files whose renditions are not those the rendition table names now,
 * by their marker, in every tree: one with no marker or another table's, and one with a rendition
 * refused under a CPU budget EMS no longer runs. It passes over a file marked by the table in
 * force, a rendition, a file nothing can decode, one not read yet, an empty one, one in a trash,
 * and one in a folder that wants no renditions; `--limit` stops it.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import { readRenditionTable } from '@ein/client';
import { startStubEms } from '@ems/testing';
import type { RenditionsScanAnswer } from '@archive/media/api';
import { renditionSignature } from '@archive/media/rendition-marker';

const testCtx = createTestContext({ modules: ['archive'] });

const BUDGET = '4000/170/64';

Deno.test({ name: 'renditions-scan announces the files whose renditions are not current', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const stub = startStubEms({ capabilities: { encode: { video_encoder: 'libsvtav1', cpu_budget: BUDGET } } });
  const env = `CFG_EMS_URL=${stub.url}`;

  /** A media file with bytes; `read` gives it the metadata a read leaves. */
  const media = async (path: string, attrs: Record<string, unknown>, read = true) => {
    await client.exec(`mkdir -p ${path.slice(0, path.lastIndexOf('/'))} && printf x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs });
    if (!read) return;
    await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.ensure(ADMIN_ACCESS, 'file', `${path}/metadata`, 'exif');
    await vfs.update(ADMIN_ACCESS, `${path}/metadata/exif`, { attrs: { indexedAt: '2026-11-05T20:00:00Z' } });
  };
  const scan = (flags: string) => client.execJson<RenditionsScanAnswer>(`${env} renditions-scan ${flags}`);

  try {
    const table = (await readRenditionTable(vfs)).table;
    const photo = await renditionSignature(table, 'photo');
    const video = await renditionSignature(table, 'video');
    const dir = `${ALBUMS_ROOT}/r`;

    await media(`${dir}/current.jpg`, { mimetype: 'image/jpeg', renditionsFor: photo });
    await media(`${dir}/other-table.jpg`, { mimetype: 'image/jpeg', renditionsFor: 'another-table' });
    await media(`${dir}/never.mp4`, { mimetype: 'video/mp4' });
    await media(`${dir}/never.mp4/thumbnails/320x320.avif`, { mimetype: 'image/avif', sourceId: 'x' }, false);
    await media(`${dir}/unread.jpg`, { mimetype: 'image/jpeg' }, false);
    await media(`${dir}/broken.mov`, { mimetype: 'video/quicktime', undecodable: 'moov atom not found' });
    await media(`${dir}/refused-before.mp4`, {
      mimetype: 'video/mp4',
      renditionsFor: video,
      transcodeRefused: { '1920x1080.mp4': { reason: 'too long', budget: '2000/170/64', at: 1 } },
    });
    await media(`${dir}/refused-now.mp4`, {
      mimetype: 'video/mp4',
      renditionsFor: video,
      transcodeRefused: { '1920x1080.mp4': { reason: 'too long', budget: BUDGET, at: 1 } },
    });
    await client.exec(`mkfile ${dir}/empty.jpg`);
    await vfs.update(ADMIN_ACCESS, `${dir}/empty.jpg`, { attrs: { mimetype: 'image/jpeg' } });
    // Outside the archive: a folder that wants renditions only, one that wants nothing, and a trash.
    await media('/home/sam/screens/shot.png', { mimetype: 'image/png' });
    await vfs.update(ADMIN_ACCESS, '/home/sam/screens', { attrs: { processing: ['renditions'] } });
    await media('/home/sam/scans/page.jpg', { mimetype: 'image/jpeg' });
    await vfs.update(ADMIN_ACCESS, '/home/sam/scans', { attrs: { processing: [] } });
    await media('/home/sam/.trash/1/gone.jpg', { mimetype: 'image/jpeg' });

    const announced = [`${dir}/never.mp4`, `${dir}/other-table.jpg`, `${dir}/refused-before.mp4`, '/home/sam/screens/shot.png'].sort();

    await t.step('the files with no marker, another table, or a refusal under another budget, in every tree', async () => {
      const dry = await scan('-n -v');
      assertEquals([...(dry.paths ?? [])].sort(), announced);
      assertEquals([dry.announced, dry.limited, dry.waiting, dry.unchecked], [4, false, false, []]);
    });

    await t.step('a path keeps it to that tree', async () => {
      assertEquals((await scan(`-n -v ${dir}`)).paths?.sort(), announced.filter((path) => path.startsWith(dir)));
    });

    await t.step('--limit stops the run', async () => {
      const limited = await scan('-n --limit 1');
      assertEquals([limited.announced, limited.limited], [1, true]);
    });

    await t.step('the facts are written', async () => {
      await client.exec('mkdir -p /dev && ([ -e /dev/events ] || mknode -t router --as routingKey=system.events /dev/events)');
      assertEquals((await scan('--limit 0')).announced, 4);
    });

    await t.step('without EMS a refusal is not checked, and says so', async () => {
      const blind = await client.execJson<RenditionsScanAnswer>('CFG_EMS_URL=http://127.0.0.1:9 CFG_EMS_CONNECT_RETRY=0 renditions-scan -n -v');
      assertEquals([...(blind.paths ?? [])].sort(), announced.filter((path) => !path.endsWith('refused-before.mp4')));
      assertEquals(blind.unchecked, ['refusals']);
    });
  } finally {
    client.close();
    await stub.close();
    await testCtx.teardown();
  }
});
