/** person-update: a person's profile fields, validated, and cleared when given empty. */

import { PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({ name: 'person-update', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const anna = `${PEOPLE_ROOT}/Anna_Andersson`;
  const attrs = () => client.execJson<Record<string, unknown>>(`attrs ${anna}`);

  try {
    await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT} && mknode -t person ${anna} --as name='Anna Andersson'`);

    await t.step('sets what it is given and leaves the rest', async () => {
      await cmd.shouldSucceed(`person-update ${anna} --born=1970-01-02 --gender=female --contact='[{"type":"email","data":" anna@example.com "}]'`);
      const now = await attrs();
      assertEquals([now.name, now.born, now.gender], ['Anna Andersson', '1970-01-02', 'female']);
      assertEquals(now.contact, [{ type: 'email', data: 'anna@example.com' }]);
    });

    await t.step('an empty value clears the field', async () => {
      await cmd.shouldSucceed(`person-update ${anna} --born= --contact=`);
      const now = await attrs();
      assertEquals([now.born, now.contact], [undefined, undefined]);
    });

    await t.step('refuses what is not a person profile', async () => {
      await cmd.shouldFail(`person-update ${anna} --born=last-spring`);
      await cmd.shouldFail(`person-update ${anna} --gender=cat`);
      await cmd.shouldFail(`person-update ${anna} --name=`);
      await cmd.shouldFail(`person-update ${anna} --contact='[{"type":"email"}]'`);
      await cmd.shouldFail(`person-update ${anna}`);
      assertEquals((await attrs()).gender, 'female');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
