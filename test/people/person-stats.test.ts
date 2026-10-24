/** `person-stats`: life events folded into calendar months, partial dates counted apart. */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext } from '@ein/testing';
import type { LifeEventStats } from '@archive/people/api';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'person-stats', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();

  const mkperson = (slug: string, attrs: Record<string, unknown>) => vfs.create(ADMIN_ACCESS, 'person', PEOPLE_ROOT, slug, { props: { mode: 0o755 }, attrs });
  const mkevent = async (owner: string, slug: string, eventType: string, date: string) => {
    await vfs.ensure(ADMIN_ACCESS, 'directory', owner, 'events', { props: { mode: 0o775 } });
    return await vfs.create(ADMIN_ACCESS, 'file', `${owner}/events`, slug, {
      props: { mode: 0o644, tier: 'db' },
      attrs: { eventType, date, mimetype: 'text/markdown', size: 0 },
    });
  };

  try {
    await t.step('answers twelve empty months on an empty archive', async () => {
      const stats = await client.execJson<LifeEventStats>('person-stats');
      assertEquals(stats.months.length, 12);
      assertEquals(stats.totals, { births: 0, engagements: 0, marriages: 0, deaths: 0 });
    });

    await mkperson('january', { born: '1980-01-12', died: '2020-01' });
    await mkperson('summer', { born: '1985-07-02' });
    await mkperson('partial', { born: '1901', died: '1975' });
    await mkevent(`${PEOPLE_ROOT}/january`, 'engaged', 'engagement', '2001-02-14');
    await mkevent(`${PEOPLE_ROOT}/january`, 'married', 'marriage', '2002-07-20T14:00');
    await mkevent(`${PEOPLE_ROOT}/summer`, 'unknown-wedding-month', 'marriage', '1950');
    await mkevent(`${PEOPLE_ROOT}/summer`, 'other', 'generic', '2002-07-20');

    await t.step('folds dated life events into all twelve months', async () => {
      const stats = await client.execJson<LifeEventStats>('person-stats');
      const [jan, feb, jul] = [stats.months[0], stats.months[1], stats.months[6]];

      assertEquals(jan.births, 1);
      assertEquals(jan.deaths, 1);
      assertEquals(feb.engagements, 1);
      assertEquals(jul.births, 1);
      assertEquals(jul.marriages, 1);
      assertEquals(stats.totals, { births: 3, engagements: 1, marriages: 2, deaths: 2 });
      assertEquals(stats.withoutMonth, { births: 1, engagements: 0, marriages: 1, deaths: 1 });
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
