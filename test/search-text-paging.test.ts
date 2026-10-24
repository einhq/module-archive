/**
 * Cursor paging for the *text* driver.
 *
 * The text driver honours the cursor rather than re-running the providers from
 * the top, so "load more" returns the next page, not page 1 again.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Hit = { path: string; name: string; score: number };
type Results = { results: Hit[]; truncated: boolean; cursor: string | null };

const COUNT = 30;

Deno.test({
  name: 'text search paging',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();

  // `search` spawns each provider with cmd.execute. The provider only returns
  // hits when it sees the invocation-local marker below, which proves the child
  // inherits the calling command's environment rather than the shell's.
  const setup = await testCtx.server.createShellClient();

  const paths: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const path = `/media/t${String(i).padStart(2, '0')}.jpg`;
    paths.push(path);
    await setup.exec(`mkdir -p /media && echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, {
      attrs: { mimetype: 'image/jpeg', ...captureTime(`2001-01-01T00:00:${String(i).padStart(2, '0')}`) },
    });
  }

  // A search provider is a `search-*` executable on PATH that declares its
  // kinds to `--kinds` and writes {results:[{path,channel,score}]} for a query. A
  // third of the scores are deliberately equal, so paging has to survive a tie at
  // a page boundary.
  const hits = paths.map((path, i) => ({ path, channel: 'picture', score: i < 10 ? 0.9 : 1 - i / 100 }));

  await setup.exec('mkdir -p /opt/bin && mkfile /opt/bin/search-fake && chmod 755 /opt/bin/search-fake');
  const handle = await vfs.open(ADMIN_ACCESS, '/opt/bin/search-fake', { mode: 'w' });
  try {
    await handle.write(
      new TextEncoder().encode(
        `[ "$1" = --kinds ] && echo '{"kinds":["photo"]}' && exit 0\n` +
          `[ "$EXEC_CALLER_MARKER" = present ] && echo '${JSON.stringify({ results: hits })}' || echo '{"results":[]}'\n`,
      ),
    );
  } finally {
    await handle.close();
  }
  await setup.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
  setup.close();

  const client = await testCtx.server.createShellClient();
  const search = (args: string) => client.execJson<Results>(`EXEC_CALLER_MARKER=present search ${args}`);

  try {
    await t.step('the provider is discovered and drives the query', async () => {
      const res = await search("'anything' -l 100");
      assertEquals(res.results.length, COUNT);
      assertEquals(res.cursor, null);
    });

    await t.step('paging covers every hit exactly once', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < 20; guard++) {
        const flag: string = cursor ? ` --cursor '${cursor}'` : '';
        const page: Results = await search(`'anything' -l 7${flag}`);
        if (page.results.length === 0) break;
        seen.push(...page.results.map((r) => r.path));
        cursor = page.cursor;
        if (!cursor) break;
      }

      assertEquals(seen.length, COUNT);
      assertEquals(new Set(seen).size, COUNT);
      assertEquals([...seen].sort(), [...paths].sort());
    });

    await t.step('page two shares nothing with page one', async () => {
      const first = await search("'anything' -l 7");
      assertEquals(first.results.length, 7);
      assertEquals(typeof first.cursor, 'string');

      const second = await search(`'anything' -l 7 --cursor '${first.cursor}'`);
      const overlap = second.results.filter((r) => first.results.some((f) => f.path === r.path));
      assertEquals(overlap, []);
    });

    await t.step('ranking is stable across identical calls', async () => {
      // Each page is a fresh fan-out, so two pages only line up if the ranking is
      // reproducible — equal scores included.
      const a = await search("'anything' -l 30 --sort score");
      const b = await search("'anything' -l 30 --sort score");
      assertEquals(a.results.map((r) => r.path), b.results.map((r) => r.path));
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
