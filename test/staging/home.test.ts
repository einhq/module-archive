/**
 * Home per year for an inbox: the owner's residence that year, else the inbox's own densest cell
 * that year, else the year before's, else none. The flag overrides all of it.
 */
import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { homesByYear } from '../../lib/staging/home.ts';

const testCtx = createTestContext({ modules: ['archive'] });

const TOWN = { lat: 59.85, lng: 17.64 };
const VILLAGE = { lat: 58.41, lng: 15.62 };
const COAST = { lat: 57.7, lng: 11.97 };

Deno.test({ name: 'homesByYear', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await cmd.shouldSucceed('user-create mover --uid 3300');
    await cmd.shouldSucceed('user-create stranger --uid 3301');
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT} ${LOCATIONS_ROOT}`);
    for (const [slug, at] of [['town', TOWN], ['village', VILLAGE]] as const) {
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/${slug}`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/${slug}/position --lat=${at.lat} --lng=${at.lng}`);
    }
    // Anna Andersson lived in the town until June 2015, then in the village.
    await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna-andersson --name 'Anna Andersson'`);
    await cmd.shouldSucceed(`person-set-home --from 2010 --to 2015-06 ${PEOPLE_ROOT}/anna-andersson ${LOCATIONS_ROOT}/town`);
    await cmd.shouldSucceed(`person-set-home --from 2015-06 ${PEOPLE_ROOT}/anna-andersson ${LOCATIONS_ROOT}/village`);
    await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/anna-andersson /etc/users/mover/person`);

    await t.step("the residence that covers most of the year is that year's home", async () => {
      const homes = await homesByYear(vfs, ADMIN_ACCESS, { user: 'mover', years: ['2012', '2015', '2016'], pointsByYear: new Map([['2016', [COAST, COAST]]]) });
      assertEquals(homes.get('2012'), { ...TOWN, source: 'residence', location: `${LOCATIONS_ROOT}/town` });
      // Moved in June: a little over half of the year in the village.
      assertEquals(homes.get('2015')?.location, `${LOCATIONS_ROOT}/village`);
      // A residence wins over where the photos were.
      assertEquals(homes.get('2016')?.location, `${LOCATIONS_ROOT}/village`);
    });

    await t.step("without a residence, the inbox's densest cell, when it holds a quarter of the year's points", async () => {
      const spread = [0, 1, 2, 3, 4].map((n) => ({ lat: 50 + n, lng: 10 + n }));
      const homes = await homesByYear(vfs, ADMIN_ACCESS, {
        user: 'stranger',
        years: ['2018', '2019', '2020', '2019'],
        pointsByYear: new Map([['2019', [COAST, COAST, COAST, TOWN]], ['2020', spread]]),
      });
      // Nothing before the first year with a home.
      assertEquals(homes.has('2018'), false);
      assertEquals(homes.get('2019')?.source, 'inbox');
      assertEquals(Math.abs(homes.get('2019')!.lat - COAST.lat) < 1e-9, true);
      // Five points in five places: no place stands out, so the year before's home holds.
      assertEquals(homes.get('2020')?.source, 'previous');
      assertEquals(homes.get('2020')?.lat, homes.get('2019')?.lat);
    });

    await t.step('the flag is home every year', async () => {
      const homes = await homesByYear(vfs, ADMIN_ACCESS, { user: 'mover', years: ['2012', '2016'], pointsByYear: new Map(), flag: COAST });
      assertEquals([...homes.values()], [{ ...COAST, source: 'flag' }, { ...COAST, source: 'flag' }]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
