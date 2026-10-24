import { DEVICES_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'device-link applies digitizer capture-date policy while linking new media',
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await client.exec(`mkdir -p ${DEVICES_ROOT} && mkdir -p /shots`);
    await cmd.shouldSucceed('device-create --name "ENVY Inspire 7200" --make HP --model "ENVY Inspire 7200" --digitizer');
    await client.exec('echo bytes > /shots/scan.jpg');
    await vfs.update(ADMIN_ACCESS, '/shots/scan.jpg', {
      attrs: { mimetype: 'image/jpeg', takenAt: '2024-05-01T11:37:34' },
    });
    await vfs.ensure(ADMIN_ACCESS, 'directory', '/shots/scan.jpg', 'metadata');
    await vfs.ensure(ADMIN_ACCESS, 'exif', '/shots/scan.jpg/metadata', 'exif');
    await vfs.update(ADMIN_ACCESS, '/shots/scan.jpg/metadata/exif', {
      attrs: {
        deviceinfo: { make: 'HP', model: 'ENVY Inspire 7200' },
        when: {
          device: { year: '2024', month: '05', day: '01', hour: '11', minute: '37', second: '34' },
        },
      },
    });

    await cmd.shouldSucceed('device-link /shots/scan.jpg');
    const attrs = await client.execJson<{ devicePath?: string; takenAt?: string }>('attrs /shots/scan.jpg');
    assertEquals(attrs.devicePath, `${DEVICES_ROOT}/ENVY_Inspire_7200`);
    assertEquals(attrs.takenAt, undefined);
  } finally {
    client.close();
    await testCtx.teardown();
  }
});

const handCtx = createTestContext({ modules: ['archive'] });

Deno.test({
  name: 'device-link --device links files exif cannot match, and quicktime-utc reads their video times as UTC',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await handCtx.setup();
  const client: ShellClient = await handCtx.server.createShellClient();
  const cmd = testCommands(client);
  const device = `${DEVICES_ROOT}/Old_Phone`;

  try {
    await client.exec(`mkdir -p ${DEVICES_ROOT} && mkdir -p /clips`);
    await cmd.shouldSucceed('device-create --name "Old Phone" --timezone Europe/London --quicktime-utc');
    for (const name of ['a.mp4', 'b.mp4']) {
      const path = `/clips/${name}`;
      await client.exec(`echo bytes > ${path}`);
      await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'video/mp4' } });
      await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'metadata');
      await vfs.ensure(ADMIN_ACCESS, 'exif', `${path}/metadata`, 'exif');
      await vfs.update(ADMIN_ACCESS, `${path}/metadata/exif`, {
        attrs: { when: { device: { year: '2023', month: '06', day: '02', hour: '17', minute: '48', second: '23', quicktime: true } } },
      });
    }

    await t.step('a directory links every file in it, and the UTC reading gets the device zone', async () => {
      await cmd.shouldSucceed(`device-link --device ${device} /clips`);
      for (const name of ['a.mp4', 'b.mp4']) {
        const attrs = await client.execJson<{ devicePath?: string; takenAt?: string; takenAtUtc?: string }>(`attrs /clips/${name}`);
        assertEquals(attrs.devicePath, device);
        assertEquals(attrs.takenAt, '2023-06-02T18:48:23+01:00');
        assertEquals(attrs.takenAtUtc, '2023-06-02T17:48:23Z');
      }
    });

    await t.step('clearing the setting re-dates the linked files as wall clocks', async () => {
      await cmd.shouldSucceed(`device-update ${device} --clear quicktime-utc`);
      const attrs = await client.execJson<{ takenAt?: string; takenAtUtc?: string }>('attrs /clips/a.mp4');
      assertEquals(attrs.takenAt, '2023-06-02T17:48:23+01:00');
      assertEquals(attrs.takenAtUtc, '2023-06-02T16:48:23Z');
    });

    await t.step('setting it again restores the UTC reading', async () => {
      await cmd.shouldSucceed(`device-update ${device} --quicktime-utc`);
      const attrs = await client.execJson<{ takenAt?: string }>('attrs /clips/b.mp4');
      assertEquals(attrs.takenAt, '2023-06-02T18:48:23+01:00');
    });

    await t.step('a device path that is not a device is refused', async () => {
      await cmd.shouldFail('device-link --device /clips /clips/a.mp4');
    });
  } finally {
    client.close();
    await handCtx.teardown();
  }
});
