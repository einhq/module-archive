/** `listedRows`: a lookup without the rows in the unlisted trees, refilled until the library fills it. */

import { assertEquals } from '@std/assert';
import type { Command } from '@ein/client';
import { listedRows } from '@archive/search/listed';

const STAGING = '/home/anna/staging';

/** Row `n` lies in staging for the first `staged` rows, in the library after. */
const corpus = (staged: number, library: number) =>
  new Map([
    ...Array.from({ length: staged }, (_, n) => [`s${n}`, `${STAGING}/files/inbox/boat-${n}.jpg/metadata/picture/v`] as const),
    ...Array.from({ length: library }, (_, n) => [`l${n}`, `/archive/albums/harbour/boat-${n}.jpg/metadata/picture/v`] as const),
  ]);

/** A command whose VFS resolves ids by `paths`, and a lookup that answers the first rows of it, counting what it was asked. */
const fixture = (paths: Map<string, string>) => {
  const asked: number[] = [];
  const cmd = { access: {}, sys: { vfs: { resolveIdPaths: (_access: unknown, ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, [paths.get(id)!]]))) } } };
  const lookup = (n: number) => {
    asked.push(n);
    return Promise.resolve([...paths.keys()].slice(0, n).map((id) => ({ id })));
  };
  return { cmd: cmd as unknown as Pick<Command, 'sys' | 'access'>, asked, lookup };
};

Deno.test('listedRows asks again while the unlisted trees take the places', async () => {
  const { cmd, asked, lookup } = fixture(corpus(30, 10));
  const { rows, paths, full } = await listedRows(cmd, [STAGING], 5, lookup);
  assertEquals(rows.map((row) => row.id), ['l0', 'l1', 'l2', 'l3', 'l4']);
  assertEquals(paths.get('l0'), ['/archive/albums/harbour/boat-0.jpg/metadata/picture/v']);
  assertEquals(asked, [5, 20, 80]);
  assertEquals(full, true);
});

Deno.test('listedRows stops when the lookup runs out, and says it is not full', async () => {
  const { cmd, lookup } = fixture(corpus(30, 2));
  const { rows, full } = await listedRows(cmd, [STAGING], 5, lookup);
  assertEquals([rows.map((row) => row.id), full], [['l0', 'l1'], false]);
});

Deno.test('listedRows asks once without unlisted trees', async () => {
  const { cmd, asked, lookup } = fixture(corpus(3, 10));
  const { rows, full } = await listedRows(cmd, [], 5, lookup);
  assertEquals([rows.map((row) => row.id), asked, full], [['s0', 's1', 's2', 'l0', 'l1'], [5], true]);
});
