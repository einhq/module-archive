/**
 * The archive's command lines, judged by their own specs the way the assistant judges them before
 * running one: a read runs at once, a write is shown to the user first.
 */

import { assertEquals } from '@std/assert';
import { type CmdSpec, judgeLine } from '@ein/client';
import { createTestContext } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: "the archive's lines are judged by their specs", sanitizeResources: false, sanitizeOps: false }, async () => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  try {
    const cases: [string, 'read' | 'write'][] = [
      ['person info /archive/people/anna-exempel', 'read'],
      ['person set-parent /archive/people/anna-exempel /archive/people/bo-exempel', 'write'],
      ['album info /archive/albums/Exempelalbum_2019', 'read'],
      ['album create /archive/albums/Nytt', 'write'],
      ['person-fixup --dry-run', 'read'],
      ['media-scan -n /archive/albums', 'read'],
    ];
    // Every command on PATH: a line's first word may be a group whose subcommand is a command of its own.
    const specs = new Map<string, CmdSpec>();
    const path = `${(await client.exec('echo $PATH')).data}`.trim();
    for (const dir of new Set(path.split(':').filter(Boolean))) {
      const listing = await client.execJson<{ name: string }[] | string[]>(`ls ${dir}`).catch(() => []);
      for (const entry of listing) {
        const name = typeof entry === 'string' ? entry : entry.name;
        specs.set(name, await client.execJson<CmdSpec>(`${name} --help`));
      }
    }
    for (const [line, effect] of cases) assertEquals((await judgeLine(line, (name) => specs.get(name))).effect, effect, line);
  } finally {
    await testCtx.teardown();
  }
});
