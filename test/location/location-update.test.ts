/** location-update edits what is written about a location, and refuses what would lose it. */
import { LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type Attrs = { name?: string; address?: string; description?: string; city?: string; country?: string };

Deno.test({ name: 'location-update', sanitizeResources: false, sanitizeOps: false }, async () => {
  await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const location = `${LOCATIONS_ROOT}/torpet`;

  try {
    await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
    await cmd.shouldSucceed(`mknode -t location ${location} --as name=Torpet --as city=Exempelby`);

    await cmd.shouldSucceed(`location-update ${location} --name 'Stora torpet' --address 'Skogsvägen 1' --description 'A red cottage'`);
    let attrs = await client.execJson<Attrs>(`attrs ${location}`);
    assertEquals(attrs.name, 'Stora torpet');
    assertEquals(attrs.address, 'Skogsvägen 1');
    assertEquals(attrs.description, 'A red cottage');
    assertEquals(attrs.city, 'Exempelby');

    await cmd.shouldSucceed(`location-update ${location} --clear city --clear description`);
    attrs = await client.execJson<Attrs>(`attrs ${location}`);
    assertEquals(attrs.city, undefined);
    assertEquals(attrs.description, undefined);
    assertEquals(attrs.name, 'Stora torpet');

    await cmd.shouldFail(`location-update ${location}`); // nothing to change
    await cmd.shouldFail(`location-update ${location} --city ''`); // empty is not clearing
    await cmd.shouldFail(`location-update ${location} --clear name`);
    await cmd.shouldFail(`location-update ${location} --city X --clear city`);
    await cmd.shouldFail(`location-update ${location} --clear shape`);
    await cmd.shouldFail(`location-update ${LOCATIONS_ROOT}/nowhere --city X`);
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
