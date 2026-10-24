/**
 * A text search narrowed by a subject ranks inside the subject's pictures.
 *
 * Testing the subject against one page of the providers' best hits would miss a picture of the
 * subject that ranks below the page. A provider that declares `within` is handed the subject's
 * file ids (`--within <file>`) and ranks inside them; one that does not is asked for its best
 * hits as usual.
 */

import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { LOCATIONS_ROOT } from '@archive/paths';
import { captureTime, createTestContext } from '@ein/testing';

const testCtx = createTestContext({ boot: true, modules: ['archive'] });

type Results = { results: { path: string }[] };

Deno.test({
  name: 'text search within a subject',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const setup = await testCtx.server.createShellClient();

  // Three pictures the text ranks first, and one on the beach it ranks nowhere near them.
  const top = ['/media/top1.jpg', '/media/top2.jpg', '/media/top3.jpg'];
  // Its name says nothing of a boat, so the real providers archive brings do not find it either.
  const beach = '/media/beach.jpg';
  await setup.exec(`mkdir -p /media ${LOCATIONS_ROOT}`);
  for (const path of [...top, beach]) {
    await setup.exec(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...captureTime('2001-01-01T00:00:00') } });
  }
  await vfs.create(ADMIN_ACCESS, 'location', LOCATIONS_ROOT, 'beach');
  await vfs.create(ADMIN_ACCESS, 'softlink', beach, 'location', {
    props: { uid: ADMIN_ACCESS.uid, gid: ADMIN_ACCESS.gid, mode: 0o777, softlink: `${LOCATIONS_ROOT}/beach` },
  });
  const beachId = (await vfs.get(ADMIN_ACCESS, beach)).id;

  // search-ranked ranks inside a set: handed one, it keeps a copy and answers from it.
  // search-plain does not, and fails if it is ever handed one.
  const write = async (path: string, script: string) => {
    await setup.exec(`mkfile ${path} && chmod 755 ${path}`);
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(script));
    } finally {
      await handle.close();
    }
  };
  await setup.exec('mkdir -p /opt/bin /seen');
  await write(
    '/opt/bin/search-ranked',
    `[ "$1" = --kinds ] && echo '{"kinds":["photo"],"within":true}' && exit 0\n` +
      `if [ "$4" = --within ]; then cat "$5" > /seen/within.json; echo '${JSON.stringify({ results: [{ path: beach, channel: 'picture', score: 0.4 }] })}'; ` +
      `else echo '${JSON.stringify({ results: top.map((path) => ({ path, channel: 'picture', score: 0.9 })) })}'; fi\n`,
  );
  await write(
    '/opt/bin/search-plain',
    `[ "$1" = --kinds ] && echo '{"kinds":["photo"]}' && exit 0\n` +
      `[ -n "$4" ] && exit 1\n` +
      `echo '{"results":[]}'\n`,
  );
  await setup.exec(`echo 'export PATH="$PATH:/opt/bin"' >> /etc/bashrc`);
  setup.close();

  const client = await testCtx.server.createShellClient();
  const names = async (args: string) => (await client.execJson<Results>(`search ${args}`)).results.map((hit) => hit.path).sort();

  try {
    await t.step('alone, the text answers with its own best', async () => {
      assertEquals(await names("'boat'"), top);
    });

    await t.step('with a location, the text ranks inside the location — the picture below the page is found', async () => {
      assertEquals(await names("'boat' --subject location:beach"), [beach]);
      // Handed exactly the location's pictures, and the file was removed afterwards.
      assertEquals(await client.execJson<string[]>('cat /seen/within.json'), [beachId]);
      assertEquals((await vfs.children(ADMIN_ACCESS, '/tmp')).filter((entry) => entry.name.startsWith('search-ids-')), []);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
