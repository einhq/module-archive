/**
 * Device registry commands: list / info / update / owners, and the two that
 * exist because a camera is usually registered *after* its photos were indexed —
 * `device-scan` (which cameras is the archive holding that nothing is registered
 * for) and `device-relink` (go and attach the files a newly registered one took).
 */

import { DEVICES_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { ScanResult } from '@archive/device/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type DeviceSummary = { id: string; name: string; serialNumber?: string; timezone?: string };
type DeviceInfo = { name: string; owners: { name: string; path: string; from?: string; to?: string }[] };
type Relink = { linked: number; retimed: number; skipped: number };
type RelinkAll = Relink & { devices: { device: string; linked: number }[]; unmatchable: number; failed: number };

/** The hand-typed source and the attrs the resolver derives from it. */
type Times = { whenManual?: string; takenAt?: string; takenAtUtc?: string; takenAtSource?: string };

Deno.test({
  name: 'device commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  /** A media file with the exif node the pipeline would have written. */
  const media = async (path: string, exif: Record<string, unknown>) => {
    await client.exec(`echo bytes > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg', ...captureTime('2009-05-01T10:00:00') } });
    await vfs.ensure(ADMIN_ACCESS, 'directory', path, 'metadata');
    await vfs.ensure(ADMIN_ACCESS, 'exif', `${path}/metadata`, 'exif');
    await vfs.update(ADMIN_ACCESS, `${path}/metadata/exif`, { attrs: { indexedAt: '2020-01-01T00:00:00Z', ...exif } });
  };

  try {
    await client.exec(`mkdir -p ${DEVICES_ROOT} && mkdir -p ${PEOPLE_ROOT} && mkdir -p /shots`);

    await t.step('device-create derives its path from the name', async () => {
      await cmd.shouldSucceed('device-create --name "Canon EOS 5D Mark III" --serial SER-1');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`), true);

      const attrs = await client.execJson<{ name: string; serialNumber: string }>(`attrs ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(attrs.name, 'Canon EOS 5D Mark III');
      assertEquals(attrs.serialNumber, 'SER-1');
    });

    await t.step('device-list reads the listing, not a name array', async () => {
      const devices = await client.execJson<DeviceSummary[]>('device-list');
      assertEquals(devices.length, 1);
      assertEquals(devices[0].id, 'Canon_EOS_5D_Mark_III');
      assertEquals(devices[0].serialNumber, 'SER-1');
    });

    await t.step('device-update writes device field names, and --clear removes', async () => {
      await cmd.shouldSucceed(`device-update ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III --timezone Europe/Stockholm --description note`);
      let attrs = await client.execJson<{ timezone?: string; description?: string }>(`attrs ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(attrs.timezone, 'Europe/Stockholm');

      await cmd.shouldSucceed(`device-update ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III --clear timezone --clear description`);
      attrs = await client.execJson<{ timezone?: string; description?: string }>(`attrs ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(attrs.timezone, undefined);
      assertEquals(attrs.description, undefined);
    });

    await t.step('device-update refuses a timezone ICU does not know', async () => {
      await cmd.shouldFail(`device-update ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III --timezone Mars/Olympus`);
    });

    await t.step('an owner is a dated pair, and device-info reports both halves', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna --name Anna`);
      await cmd.shouldSucceed(`device-set-owner ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --from 2012 --to 2015`);

      const info = await client.execJson<DeviceInfo>(`device-info ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(info.owners.length, 1);
      assertEquals(info.owners[0].name, 'Anna');
      assertEquals(info.owners[0].from, '2012');
      assertEquals(info.owners[0].to, '2015');

      // The person half exists too, or the relation is only half written.
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/devices/Canon_EOS_5D_Mark_III`), true);
    });

    await t.step('device-timeline shows each owner getting and giving up the device', async () => {
      type Feed = { name: string; entries: Array<{ kind: string; date: string; title: string; ownerPath?: string; eventType?: string }> };
      const feed = await client.execJson<Feed>(`device-timeline ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III --no-albums`);
      assertEquals(feed.entries.map((e) => e.eventType), ['owned-to', 'owned-from']);
      assertEquals(feed.entries[1].title, `Anna started using ${feed.name}`);
      // Owned by the person, so the card leads to them rather than back here.
      assertEquals(feed.entries[1].ownerPath, `${PEOPLE_ROOT}/anna`);
    });

    await t.step("device-timeline shows an event added to the device, as the page's Add event writes it", async () => {
      const device = `${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`;
      await cmd.shouldSucceed(`person-add-event ${device} --type generic --date 2014-06 --body "Sent in for a new shutter"`);
      type Feed = { entries: Array<{ kind: string; date: string; title: string; ownerPath?: string; description?: string }> };
      const feed = await client.execJson<Feed>(`device-timeline ${device} --no-albums`);
      const event = feed.entries.find((entry) => entry.kind === 'event' && entry.ownerPath === device);
      assertEquals(event?.date, '2014-06');
      assertEquals(event?.description, 'Sent in for a new shutter');
    });

    await t.step('device-set-owner --update rewrites the dates on both halves', async () => {
      await cmd.shouldFail(`device-set-owner ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --from 2013`); // exists
      await cmd.shouldFail(`device-set-owner ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --update --from soon`);
      await cmd.shouldSucceed(`device-set-owner ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --update --from 2013`);

      const info = await client.execJson<DeviceInfo>(`device-info ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(info.owners[0].from, '2013');
      // An omitted end is cleared, which is how an ownership is reopened.
      assertEquals(info.owners[0].to, undefined);

      const peer = await vfs.get<{ relation?: { from?: string; to?: string } }>(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/devices/Canon_EOS_5D_Mark_III`, { follow: false });
      assertEquals(peer.attrs.relation?.from, '2013');
      assertEquals(peer.attrs.relation?.to, undefined);
    });

    await t.step('device-remove-owner takes both halves with it', async () => {
      await cmd.shouldSucceed(`device-remove-owner ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III anna`);

      const info = await client.execJson<DeviceInfo>(`device-info ${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(info.owners.length, 0);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/devices/Canon_EOS_5D_Mark_III`), false);
    });

    await t.step('device-scan proposes only the cameras nothing matches', async () => {
      await media('/shots/a.jpg', { deviceSerialNumber: 'SER-1', deviceinfo: { make: 'Canon', model: 'Canon EOS 5D Mark III' } });
      await media('/shots/b.jpg', { deviceinfo: { make: 'Apple', model: 'iPhone 12' } });
      await media('/shots/c.jpg', { deviceinfo: { make: 'Apple', model: 'iPhone 12' } });
      await media('/shots/d.jpg', { deviceSerialNumber: 'SER-2', deviceinfo: { make: 'Nikon', model: 'D70' } });

      const scan = await client.execJson<ScanResult>('device-scan');
      const names = scan.proposals.map((proposal) => proposal.suggestedName).sort();

      // SER-1 is registered, so its file is matched rather than proposed.
      assertEquals(names, ['Apple iPhone 12', 'Nikon D70']);
      assertEquals(scan.matched, 1);
      assertEquals(scan.proposals.find((p) => p.suggestedName === 'Apple iPhone 12')?.files, 2);
      assertEquals(scan.proposals.find((p) => p.suggestedName === 'Nikon D70')?.serialNumber, 'SER-2');
    });

    await t.step('a proposal naming a registered device points back at it', async () => {
      // The imported-archive case: devices came across with a name and no
      // make/model, so their files are unmatchable and the fix is to give the
      // device the fingerprint, not to register a second copy of the camera.
      await cmd.shouldSucceed('device-create --name "iPhone 12"');

      const scan = await client.execJson<ScanResult>('device-scan');
      const iphone = scan.proposals.find((proposal) => proposal.model === 'iPhone 12');
      assertEquals(iphone?.existingPath, `${DEVICES_ROOT}/iPhone_12`);
      // Adopting changes that device, so the proposal says who may.
      const device = await vfs.get(ADMIN_ACCESS, `${DEVICES_ROOT}/iPhone_12`);
      assertEquals(iphone?.existingOwnership, { mode: device.props.mode, uid: device.props.uid, gid: device.props.gid });
    });

    await t.step('device-relink attaches the media a device was registered too late for', async () => {
      // Registering the camera does nothing to files already indexed: the
      // pipeline linked them (or failed to) when they arrived.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/b.jpg/device'), false);

      await cmd.shouldSucceed(`device-update ${DEVICES_ROOT}/iPhone_12 --make Apple --model "iPhone 12"`);
      const result = await client.execJson<Relink>(`device-relink ${DEVICES_ROOT}/iPhone_12`);
      assertEquals(result.linked, 2);

      const attrs = await client.execJson<{ devicePath: string }>('attrs /shots/b.jpg');
      assertEquals(attrs.devicePath, `${DEVICES_ROOT}/iPhone_12`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/b.jpg/device'), true);

      // Re-running claims nothing new — the files it would link, it already did.
      const again = await client.execJson<Relink>(`device-relink ${DEVICES_ROOT}/iPhone_12`);
      assertEquals(again.linked, 0);
      assertEquals(again.skipped, 2);
    });

    await t.step('digitizer flag clears and restores derived dates without touching a manual override', async () => {
      await media('/shots/scan.jpg', {
        deviceinfo: { make: 'HP', model: 'ScanJet 3500' },
        when: {
          device: { year: '2024', month: '05', day: '01', hour: '11', minute: '37', second: '34' },
        },
      });
      // The hand-typed source, not a derived attr: `whenManual` is what outranks the device
      // date, and the point of this step is that suppressing the scanner's clock never touches it.
      await vfs.update(ADMIN_ACCESS, '/shots/scan.jpg', { attrs: { whenManual: '1983-12-24T10:00:00' } });
      await cmd.shouldSucceed('device-create --name "HP ScanJet 3500" --make HP --model "ScanJet 3500" --digitizer');

      const linked = await client.execJson<Relink>(`device-relink ${DEVICES_ROOT}/HP_ScanJet_3500`);
      assertEquals(linked.linked, 1);
      assertEquals(linked.retimed, 1);
      // The manual time wins over the scanner's clock either way, so `takenAt` stays on it and
      // only the *source* moves — which is the whole reason `takenAtSource` is carried.
      let attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, '1983-12-24T10:00:00');
      assertEquals(attrs.takenAtSource, 'manual');
      assertEquals(attrs.whenManual, '1983-12-24T10:00:00');

      // With the override taken away, the digitizer flag is what decides. The date comes from
      // normalized metadata/exif.when; no exiftool rerun is involved.
      await vfs.update(ADMIN_ACCESS, '/shots/scan.jpg', { attrs: { whenManual: null } });
      await cmd.shouldSucceed(`device-relink ${DEVICES_ROOT}/HP_ScanJet_3500 --reapply`);
      attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, undefined, "a scanner's clock is when it scanned, not when the photograph was taken");

      const restored = await client.execJson<{ relink: Relink }>(`device-update ${DEVICES_ROOT}/HP_ScanJet_3500 --clear digitizer`);
      assertEquals(restored.relink.retimed, 1);
      attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, '2024-05-01T11:37:34');
      assertEquals(attrs.takenAtSource, 'device');

      const suppressed = await client.execJson<{ relink: Relink }>(`device-update ${DEVICES_ROOT}/HP_ScanJet_3500 --digitizer`);
      assertEquals(suppressed.relink.retimed, 1);
      attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, undefined);

      // The link remains a device-page membership even after the scanner's
      // false capture date is correctly suppressed.
      const visible = await client.execJson<{ results: { path: string }[]; cursor: string | null }>(
        `search --subject device:${DEVICES_ROOT}/HP_ScanJet_3500`,
      );
      assertEquals(visible.results.map((hit) => hit.path), ['/shots/scan.jpg']);
      const facets = await client.execJson<{ total: number; years: { year: number; count: number }[] }>(
        `search --subject device:${DEVICES_ROOT}/HP_ScanJet_3500 --facets`,
      );
      assertEquals(facets.total, 1);
      assertEquals(facets.years, []);
    });

    await t.step('a relinked device is then findable by search --device', async () => {
      const found = await client.execJson<{ results: { path: string }[] }>(`search --subject device:${DEVICES_ROOT}/iPhone_12`);
      assertEquals(found.results.map((hit) => hit.path).sort(), ['/shots/b.jpg', '/shots/c.jpg']);
    });

    await t.step('device-relink refuses a device with nothing to match on', async () => {
      await cmd.shouldSucceed('device-create --name "No Fingerprint"');
      await cmd.shouldFail(`device-relink ${DEVICES_ROOT}/No_Fingerprint`);
    });

    await t.step('device-relink --all sweeps the registry and passes over what it cannot key on', async () => {
      // The camera was registered all along but this file was never linked; from the file side
      // that looks like a link that matched nothing, so only a sweep from the registry finds it.
      const before = await client.execJson<{ devicePath?: string }>('attrs /shots/a.jpg');
      assertEquals(before.devicePath, undefined);

      const swept = await client.execJson<RelinkAll>('device-relink --all');

      assertEquals(swept.linked, 1);
      assertEquals(swept.devices.find((d) => d.device === `${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`)?.linked, 1);
      // No_Fingerprint has neither a serial nor a make+model pair. On its own it is an error;
      // in a sweep it is one device passed over, and must not fail the pass for the others.
      assertEquals(swept.unmatchable, 1);
      assertEquals(swept.failed, 0);

      const after = await client.execJson<{ devicePath: string }>('attrs /shots/a.jpg');
      assertEquals(after.devicePath, `${DEVICES_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/a.jpg/device'), true);

      // Nothing left to claim the second time round.
      assertEquals((await client.execJson<RelinkAll>('device-relink --all')).linked, 0);
      // A sweep is over the whole registry by definition, so naming one device as well is a
      // contradiction rather than a narrowing.
      await cmd.shouldFail(`device-relink --all ${DEVICES_ROOT}/iPhone_12`);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
