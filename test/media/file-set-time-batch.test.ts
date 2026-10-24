/**
 * `file-set-time` over many files writes them together: one `updateEach` for the whole call and
 * no `update` per file, as many calls for 40 files as for 4, and a single file answers as it
 * always has. The files are invented.
 */

import type { FileSetTimeAnswer } from '@archive/media/api';
import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });
const DIR = `${ALBUMS_ROOT}/lake-trip-2019/files`;

Deno.test({ name: 'file-set-time batches its writes', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  /** The VFS writes a call makes to the files under `DIR`: `update`s, and `updateEach` calls with how many changes each. */
  let writes: { update: number; updateEach: number[] } | undefined;
  const ours = (ref: unknown) => typeof ref === 'string' && ref.startsWith(`${DIR}/`);
  const update = vfs.update.bind(vfs);
  const updateEach = vfs.updateEach.bind(vfs);
  vfs.update = ((access, ref, opts) => {
    if (writes && ours(ref)) writes.update++;
    return update(access, ref, opts);
  }) as typeof vfs.update;
  vfs.updateEach = ((access, changes, opts) => {
    if (writes && changes.some((change) => ours(change.ref))) writes.updateEach.push(changes.length);
    return updateEach(access, changes, opts);
  }) as typeof vfs.updateEach;
  const writesDuring = async (line: string) => {
    writes = { update: 0, updateEach: [] };
    try {
      await client.execJson(line);
      return writes;
    } finally {
      writes = undefined;
    }
  };
  const pairs = (names: string[], day: string) => names.map((name, i) => `${DIR}/${name} ${day}T09:${String(i).padStart(2, '0')}:00`).join(' ');

  try {
    const names = Array.from({ length: 40 }, (_, i) => `IMG_${1000 + i}.jpg`);
    await client.exec(`mkdir -p ${DIR} && ${names.map((name) => `mkfile ${DIR}/${name}`).join(' && ')}`);

    await t.step('many files are one batched write, however many there are', async () => {
      assertEquals(await writesDuring(`file-set-time ${pairs(names.slice(0, 4), '2019-06-14')}`), { update: 0, updateEach: [4] });
      assertEquals(await writesDuring(`file-set-time ${pairs(names, '2019-06-15')}`), { update: 0, updateEach: [40] });
      const attrs = await client.execJson<{ takenAt?: string; whenManual?: string }>(`attrs ${DIR}/${names[39]}`);
      assertEquals([attrs.whenManual, attrs.takenAt], ['2019-06-15T09:39:00', '2019-06-15T09:39:00']);
    });

    await t.step('one file answers as before, its note written with it', async () => {
      const line = `file-set-time ${DIR}/${names[0]} 1975 --note 'from the album sleeve'`;
      assertEquals(await writesDuring(line), { update: 0, updateEach: [1] });
      const answer = await client.execJson<FileSetTimeAnswer>(line);
      assertEquals(answer, { ok: true, updated: 1, files: [{ path: `${DIR}/${names[0]}`, takenAt: '1975', source: 'manual' }] });
      const attrs = await client.execJson<{ takenAtNote?: string }>(`attrs ${DIR}/${names[0]}`);
      assertEquals(attrs.takenAtNote, 'from the album sleeve');
    });

    await t.step('a missing file writes nothing', async () => {
      const before = await client.execJson<{ takenAt?: string }>(`attrs ${DIR}/${names[1]}`);
      writes = { update: 0, updateEach: [] };
      const result = await client.exec(`file-set-time ${DIR}/${names[1]} 2001-01-01 ${DIR}/gone.jpg 2001-01-02`);
      assertEquals([result.success, writes], [false, { update: 0, updateEach: [] }]);
      writes = undefined;
      assertEquals(await client.execJson<{ takenAt?: string }>(`attrs ${DIR}/${names[1]}`), before);
    });

    await t.step('--clear takes the times off together', async () => {
      assertEquals(await writesDuring(`file-set-time --clear ${names.slice(0, 3).map((name) => `${DIR}/${name}`).join(' ')}`), { update: 0, updateEach: [3] });
      const attrs = await client.execJson<{ takenAt?: string; whenManual?: string; takenAtNote?: string }>(`attrs ${DIR}/${names[0]}`);
      assertEquals([attrs.whenManual, attrs.takenAt, attrs.takenAtNote], [undefined, undefined, undefined]);
    });
  } finally {
    vfs.update = update;
    vfs.updateEach = updateEach;
    client.close();
    await testCtx.teardown();
  }
});
