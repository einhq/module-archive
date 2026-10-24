/** `person-list`: the named people with their face and voice counts, by name or by count. */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, assertFailure, createTestContext } from '@ein/testing';
import type { PersonListEntry } from '@archive/people/api';
import { REGION_TYPE } from '@archive/media/regions';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'person-list', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const mkperson = (slug: string, attrs: Record<string, unknown>) => vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { props: { mode: 0o755 }, attrs });

  /** `count` face regions on one picture, all assigned to `personId`. */
  const faces = async (picture: string, personId: string, count: number) => {
    await vfs.ensure(ADMIN_ACCESS, 'directory', '/tmp', picture);
    await vfs.ensure(ADMIN_ACCESS, 'directory', `/tmp/${picture}`, 'regions');
    for (let i = 0; i < count; i++) {
      await vfs.create(ADMIN_ACCESS, REGION_TYPE, `/tmp/${picture}/regions`, `face-${i}`, { attrs: { personId } });
    }
  };

  try {
    const anna = await mkperson('anna', { name: 'Anna Andersson', born: '1950-03-01' });
    const bert = await mkperson('bert', { name: 'Bert Berg', died: '2001' });
    await mkperson('placeholder', { name: '? Carlsson' });
    await vfs.ensure(ADMIN_ACCESS, 'directory', PEOPLE_ROOT, 'unknown');
    await faces('a.jpg', anna.id, 2);
    await faces('b.jpg', bert.id, 5);

    await t.step('lists named people by name, placeholder names last', async () => {
      const people = await client.execJson<PersonListEntry[]>('person-list');
      assertEquals(people.map((p) => p.id), ['anna', 'bert', 'placeholder']);
      assertEquals(people[0], { id: 'anna', path: `${PEOPLE_ROOT}/anna`, name: 'Anna Andersson', born: '1950-03-01', holdings: 2 });
      assertEquals(people[2].holdings, 0);
    });

    await t.step('sorts by count and limits', async () => {
      const people = await client.execJson<PersonListEntry[]>('person-list --sort count --limit 2');
      assertEquals(people.map((p) => [p.id, p.holdings]), [['bert', 5], ['anna', 2]]);
    });

    await t.step('leaves out people with fewer than --min holdings', async () => {
      const people = await client.execJson<PersonListEntry[]>('person-list --min 1');
      assertEquals(people.map((p) => p.id), ['anna', 'bert']);
    });

    await t.step('refuses an unknown sort', async () => {
      assertFailure(await client.exec('person-list --sort age'));
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
