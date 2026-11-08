/**
 * Camera registry commands: list / info / update / owners, and the two that
 * exist because a camera is usually registered *after* its photos were indexed —
 * `camera-scan` (which cameras is the archive holding that nothing is registered
 * for) and `camera-relink` (go and attach the files a newly registered one took).
 */

import { CAMERAS_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { CameraHomes, ScanResult } from '@archive/camera/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { captureTime, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

type CameraSummary = { id: string; name: string; serialNumber?: string; timezone?: string };
type CameraInfo = { name: string; owners: { name: string; path: string; from?: string; to?: string }[] };
type Relink = { linked: number; retimed: number; skipped: number };
type RelinkAll = Relink & { cameras: { camera: string; linked: number }[]; unmatchable: number; failed: number };

/** The hand-typed source and the attrs the resolver derives from it. */
type Times = { whenManual?: string; takenAt?: string; takenAtUtc?: string; takenAtSource?: string };

Deno.test({
  name: 'camera commands',
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
    await client.exec(`mkdir -p ${CAMERAS_ROOT} && mkdir -p ${PEOPLE_ROOT} && mkdir -p /shots`);

    await t.step('camera-create derives its path from the name', async () => {
      await cmd.shouldSucceed('camera-create --name "Canon EOS 5D Mark III" --serial SER-1');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`), true);

      const attrs = await client.execJson<{ name: string; serialNumber: string }>(`attrs ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(attrs.name, 'Canon EOS 5D Mark III');
      assertEquals(attrs.serialNumber, 'SER-1');
    });

    await t.step('camera-list reads the listing, not a name array', async () => {
      const cameras = await client.execJson<CameraSummary[]>('camera-list');
      assertEquals(cameras.length, 1);
      assertEquals(cameras[0].id, 'Canon_EOS_5D_Mark_III');
      assertEquals(cameras[0].serialNumber, 'SER-1');
    });

    await t.step('camera-update writes camera field names, and --clear removes', async () => {
      await cmd.shouldSucceed(`camera-update ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III --timezone Europe/Stockholm --description note`);
      let attrs = await client.execJson<{ timezone?: string; description?: string }>(`attrs ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(attrs.timezone, 'Europe/Stockholm');

      await cmd.shouldSucceed(`camera-update ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III --clear timezone --clear description`);
      attrs = await client.execJson<{ timezone?: string; description?: string }>(`attrs ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(attrs.timezone, undefined);
      assertEquals(attrs.description, undefined);
    });

    await t.step('camera-update refuses a timezone ICU does not know', async () => {
      await cmd.shouldFail(`camera-update ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III --timezone Mars/Olympus`);
    });

    await t.step('camera-create refuses a timezone ICU does not know, and makes nothing', async () => {
      await cmd.shouldFailWith('camera-create --name "Mars Rover" --timezone Mars/Olympus', 'unknown timezone');
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${CAMERAS_ROOT}/Mars_Rover`), false);
    });

    await t.step('an owner is a dated pair, and camera-info reports both halves', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna --name Anna`);
      await cmd.shouldSucceed(`camera-set-owner ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --from 2012 --to 2015`);

      const info = await client.execJson<CameraInfo>(`camera-info ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(info.owners.length, 1);
      assertEquals(info.owners[0].name, 'Anna');
      assertEquals(info.owners[0].from, '2012');
      assertEquals(info.owners[0].to, '2015');

      // The person half exists too, or the relation is only half written.
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/cameras/Canon_EOS_5D_Mark_III`), true);
    });

    await t.step('camera-timeline shows each owner getting and giving up the camera', async () => {
      type Feed = { name: string; entries: Array<{ kind: string; date: string; title: string; ownerPath?: string; eventType?: string }> };
      const feed = await client.execJson<Feed>(`camera-timeline ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III --no-albums`);
      assertEquals(feed.entries.map((e) => e.eventType), ['owned-to', 'owned-from']);
      assertEquals(feed.entries[1].title, `Anna started using ${feed.name}`);
      // Owned by the person, so the card leads to them rather than back here.
      assertEquals(feed.entries[1].ownerPath, `${PEOPLE_ROOT}/anna`);
    });

    await t.step("camera-timeline shows an event added to the camera, as the page's Add event writes it", async () => {
      const camera = `${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`;
      await cmd.shouldSucceed(`person-add-event ${camera} --type generic --date 2014-06 --body "Sent in for a new shutter"`);
      type Feed = { entries: Array<{ kind: string; date: string; title: string; ownerPath?: string; description?: string }> };
      const feed = await client.execJson<Feed>(`camera-timeline ${camera} --no-albums`);
      const event = feed.entries.find((entry) => entry.kind === 'event' && entry.ownerPath === camera);
      assertEquals(event?.date, '2014-06');
      assertEquals(event?.description, 'Sent in for a new shutter');
    });

    await t.step('camera-set-owner --update rewrites the dates on both halves', async () => {
      await cmd.shouldFail(`camera-set-owner ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --from 2013`); // exists
      await cmd.shouldFail(`camera-set-owner ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --update --from soon`);
      await cmd.shouldSucceed(`camera-set-owner ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III ${PEOPLE_ROOT}/anna --update --from 2013`);

      const info = await client.execJson<CameraInfo>(`camera-info ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(info.owners[0].from, '2013');
      // An omitted end is cleared, which is how an ownership is reopened.
      assertEquals(info.owners[0].to, undefined);

      const peer = await vfs.get<{ relation?: { from?: string; to?: string } }>(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/cameras/Canon_EOS_5D_Mark_III`, { follow: false });
      assertEquals(peer.attrs.relation?.from, '2013');
      assertEquals(peer.attrs.relation?.to, undefined);
    });

    await t.step('camera-remove-owner takes both halves with it', async () => {
      await cmd.shouldSucceed(`camera-remove-owner ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III anna`);

      const info = await client.execJson<CameraInfo>(`camera-info ${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(info.owners.length, 0);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${PEOPLE_ROOT}/anna/cameras/Canon_EOS_5D_Mark_III`), false);
    });

    await t.step('camera-scan proposes only the cameras nothing matches', async () => {
      await media('/shots/a.jpg', { deviceSerialNumber: 'SER-1', deviceinfo: { make: 'Canon', model: 'Canon EOS 5D Mark III' } });
      await media('/shots/b.jpg', { deviceinfo: { make: 'Apple', model: 'iPhone 12' } });
      await media('/shots/c.jpg', { deviceinfo: { make: 'Apple', model: 'iPhone 12' } });
      await media('/shots/d.jpg', { deviceSerialNumber: 'SER-2', deviceinfo: { make: 'Nikon', model: 'D70' } });

      const scan = await client.execJson<ScanResult>('camera-scan');
      const names = scan.proposals.map((proposal) => proposal.suggestedName).sort();

      // SER-1 is registered, so its file is matched rather than proposed.
      assertEquals(names, ['Apple iPhone 12', 'Nikon D70']);
      assertEquals(scan.matched, 1);
      assertEquals(scan.proposals.find((p) => p.suggestedName === 'Apple iPhone 12')?.files, 2);
      assertEquals(scan.proposals.find((p) => p.suggestedName === 'Nikon D70')?.serialNumber, 'SER-2');
      assertEquals(scan.truncated, false);

      // One serial is within the limit, but two proposals are not: the answer says it was cut short.
      const one = await client.execJson<ScanResult>('camera-scan --limit 1');
      assertEquals(one.proposals.length, 1);
      assertEquals(one.truncated, true);
    });

    await t.step('a proposal naming a registered camera points back at it', async () => {
      // The imported-archive case: cameras came across with a name and no
      // make/model, so their files are unmatchable and the fix is to give the
      // camera the fingerprint, not to register a second copy of the camera.
      await cmd.shouldSucceed('camera-create --name "iPhone 12"');

      const scan = await client.execJson<ScanResult>('camera-scan');
      const iphone = scan.proposals.find((proposal) => proposal.model === 'iPhone 12');
      assertEquals(iphone?.existingPath, `${CAMERAS_ROOT}/iPhone_12`);
      // Adopting changes that camera, so the proposal says who may.
      const camera = await vfs.get(ADMIN_ACCESS, `${CAMERAS_ROOT}/iPhone_12`);
      assertEquals(iphone?.existingOwnership, { mode: camera.props.mode, uid: camera.props.uid, gid: camera.props.gid });
    });

    await t.step('giving a camera its fingerprint links the media already carrying it', async () => {
      // Registered without one, the camera matched nothing when its files were indexed.
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/b.jpg/camera'), false);

      // Half a fingerprint matches nothing yet, and is no error.
      const half = await client.execJson<{ relink?: Relink }>(`camera-update ${CAMERAS_ROOT}/iPhone_12 --make Apple`);
      assertEquals(half.relink, undefined);

      const updated = await client.execJson<{ relink: Relink }>(`camera-update ${CAMERAS_ROOT}/iPhone_12 --model "iPhone 12"`);
      assertEquals(updated.relink.linked, 2);

      const attrs = await client.execJson<{ cameraPath: string }>('attrs /shots/b.jpg');
      assertEquals(attrs.cameraPath, `${CAMERAS_ROOT}/iPhone_12`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/b.jpg/camera'), true);

      // Re-running claims nothing new — the files it would link, it already did.
      const again = await client.execJson<Relink>(`camera-relink ${CAMERAS_ROOT}/iPhone_12`);
      assertEquals(again.linked, 0);
      assertEquals(again.skipped, 2);

      // A file another camera owns is left alone, and taken only with `--force`.
      await vfs.update(ADMIN_ACCESS, '/shots/b.jpg', { attrs: { cameraPath: `${CAMERAS_ROOT}/Other` } });
      const owned = await client.execJson<Relink>(`camera-relink ${CAMERAS_ROOT}/iPhone_12`);
      assertEquals([owned.linked, owned.skipped], [0, 2]);
      const forced = await client.execJson<Relink>(`camera-relink ${CAMERAS_ROOT}/iPhone_12 --force`);
      assertEquals([forced.linked, forced.skipped], [1, 1]);
      assertEquals((await client.execJson<{ cameraPath: string }>('attrs /shots/b.jpg')).cameraPath, `${CAMERAS_ROOT}/iPhone_12`);
    });

    await t.step('digitizer flag clears and restores derived dates without touching a manual override', async () => {
      await media('/shots/scan.jpg', {
        deviceinfo: { make: 'HP', model: 'ScanJet 3500' },
        when: {
          device: { year: '2024', month: '05', day: '01', hour: '11', minute: '37', second: '34' },
        },
      });
      // The hand-typed source, not a derived attr: `whenManual` is what outranks the camera
      // date, and the point of this step is that suppressing the scanner's clock never touches it.
      await vfs.update(ADMIN_ACCESS, '/shots/scan.jpg', { attrs: { whenManual: '1983-12-24T10:00:00' } });
      const created = await client.execJson<{ relink: Relink }>(
        'camera-create --name "HP ScanJet 3500" --make HP --model "ScanJet 3500" --digitizer',
      );
      assertEquals(created.relink.linked, 1);
      assertEquals(created.relink.retimed, 1);
      // The manual time wins over the scanner's clock either way, so `takenAt` stays on it and
      // only the *source* moves — which is the whole reason `takenAtSource` is carried.
      let attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, '1983-12-24T10:00:00');
      assertEquals(attrs.takenAtSource, 'manual');
      assertEquals(attrs.whenManual, '1983-12-24T10:00:00');

      // With the override taken away, the digitizer flag is what decides. The date comes from
      // normalized metadata/exif.when; no exiftool rerun is involved.
      await vfs.update(ADMIN_ACCESS, '/shots/scan.jpg', { attrs: { whenManual: null } });
      await cmd.shouldSucceed(`camera-relink ${CAMERAS_ROOT}/HP_ScanJet_3500 --reapply`);
      attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, undefined, "a scanner's clock is when it scanned, not when the photograph was taken");

      const restored = await client.execJson<{ relink: Relink }>(`camera-update ${CAMERAS_ROOT}/HP_ScanJet_3500 --clear digitizer`);
      assertEquals(restored.relink.retimed, 1);
      attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, '2024-05-01T11:37:34');
      assertEquals(attrs.takenAtSource, 'camera');

      const suppressed = await client.execJson<{ relink: Relink }>(`camera-update ${CAMERAS_ROOT}/HP_ScanJet_3500 --digitizer`);
      assertEquals(suppressed.relink.retimed, 1);
      attrs = await client.execJson<Times>('attrs /shots/scan.jpg');
      assertEquals(attrs.takenAt, undefined);

      // The link remains a camera-page membership even after the scanner's
      // false capture date is correctly suppressed.
      const visible = await client.execJson<{ results: { path: string }[]; cursor: string | null }>(
        `search --subject camera:${CAMERAS_ROOT}/HP_ScanJet_3500`,
      );
      assertEquals(visible.results.map((hit) => hit.path), ['/shots/scan.jpg']);
      const facets = await client.execJson<{ total: number; years: { year: number; count: number }[] }>(
        `search --subject camera:${CAMERAS_ROOT}/HP_ScanJet_3500 --facets`,
      );
      assertEquals(facets.total, 1);
      assertEquals(facets.years, []);
    });

    await t.step('a relinked camera is then findable by search --camera', async () => {
      const found = await client.execJson<{ results: { path: string }[] }>(`search --subject camera:${CAMERAS_ROOT}/iPhone_12`);
      assertEquals(found.results.map((hit) => hit.path).sort(), ['/shots/b.jpg', '/shots/c.jpg']);
    });

    await t.step('registering a scanned camera links the media it took', async () => {
      // What the cameras page does with a proposal: camera-create with the fingerprint the scan
      // found. The file was indexed before the camera was registered.
      const created = await client.execJson<{ path: string; relink: Relink }>('camera-create --name "Nikon D70" --make Nikon --model D70 --serial SER-2');
      assertEquals(created.relink.linked, 1);

      const attrs = await client.execJson<{ cameraPath: string }>('attrs /shots/d.jpg');
      assertEquals(attrs.cameraPath, created.path);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/d.jpg/camera'), true);
    });

    await t.step('camera-relink refuses a camera with nothing to match on', async () => {
      await cmd.shouldSucceed('camera-create --name "No Fingerprint"');
      await cmd.shouldFail(`camera-relink ${CAMERAS_ROOT}/No_Fingerprint`);
    });

    await t.step('camera-relink --all sweeps the registry and passes over what it cannot key on', async () => {
      // The camera was registered all along but this file was never linked; from the file side
      // that looks like a link that matched nothing, so only a sweep from the registry finds it.
      const before = await client.execJson<{ cameraPath?: string }>('attrs /shots/a.jpg');
      assertEquals(before.cameraPath, undefined);

      const swept = await client.execJson<RelinkAll>('camera-relink --all');

      assertEquals(swept.linked, 1);
      assertEquals(swept.cameras.find((d) => d.camera === `${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`)?.linked, 1);
      // No_Fingerprint has neither a serial nor a make+model pair. On its own it is an error;
      // in a sweep it is one camera passed over, and must not fail the pass for the others.
      assertEquals(swept.unmatchable, 1);
      assertEquals(swept.failed, 0);

      const after = await client.execJson<{ cameraPath: string }>('attrs /shots/a.jpg');
      assertEquals(after.cameraPath, `${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, '/shots/a.jpg/camera'), true);

      // Nothing left to claim the second time round.
      assertEquals((await client.execJson<RelinkAll>('camera-relink --all')).linked, 0);
      // A sweep is over the whole registry by definition, so naming one camera as well is a
      // contradiction rather than a narrowing.
      await cmd.shouldFail(`camera-relink --all ${CAMERAS_ROOT}/iPhone_12`);
    });

    await t.step('camera-relink links what ingest would: a serial no camera has falls to the make and model', async () => {
      // A second body of the same model line, whose serial is registered to nothing.
      await media('/shots/e.jpg', { deviceSerialNumber: 'SER-9', deviceinfo: { make: 'Apple', model: 'iPhone 12' } });
      // A serial that is registered wins over the make and model, as at ingest.
      await media('/shots/f.jpg', { deviceSerialNumber: 'SER-2', deviceinfo: { make: 'Apple', model: 'iPhone 12' } });

      const relinked = await client.execJson<Relink>(`camera-relink ${CAMERAS_ROOT}/iPhone_12`);
      assertEquals(relinked.linked, 1);
      assertEquals((await client.execJson<{ cameraPath: string }>('attrs /shots/e.jpg')).cameraPath, `${CAMERAS_ROOT}/iPhone_12`);
      assertEquals((await client.execJson<{ cameraPath?: string }>('attrs /shots/f.jpg')).cameraPath, undefined);

      const nikon = await client.execJson<Relink>(`camera-relink ${CAMERAS_ROOT}/Nikon_D70`);
      assertEquals(nikon.linked, 1);
      assertEquals((await client.execJson<{ cameraPath: string }>('attrs /shots/f.jpg')).cameraPath, `${CAMERAS_ROOT}/Nikon_D70`);

      // A camera with a serial takes its model line's files whose serial no camera has, as camera-match gives them to it.
      await media('/shots/g.jpg', { deviceSerialNumber: 'SER-8', deviceinfo: { make: 'Nikon', model: 'D70' } });
      assertEquals((await client.execJson<{ path: string }>('camera-match --serial SER-8 --make Nikon --model D70')).path, `${CAMERAS_ROOT}/Nikon_D70`);
      assertEquals((await client.execJson<Relink>(`camera-relink ${CAMERAS_ROOT}/Nikon_D70`)).linked, 1);
      assertEquals((await client.execJson<{ cameraPath: string }>('attrs /shots/g.jpg')).cameraPath, `${CAMERAS_ROOT}/Nikon_D70`);
    });
    await t.step('camera-update sets a kind, refuses one it does not know, and --clear removes it', async () => {
      const camera = `${CAMERAS_ROOT}/Canon_EOS_5D_Mark_III`;
      await cmd.shouldSucceed(`camera-update ${camera} --kind boat`);
      assertEquals((await client.execJson<{ kind?: string }>(`camera-info ${camera}`)).kind, 'boat');
      await cmd.shouldFail(`camera-update ${camera} --kind submarine`);
      await cmd.shouldSucceed(`camera-update ${camera} --clear kind`);
      assertEquals((await client.execJson<{ kind?: string }>(`attrs ${camera}`)).kind, undefined);
    });

    await t.step("camera-home lists its own home bases, and its owners' homes while it has none", async () => {
      const boat = `${CAMERAS_ROOT}/Exempelbaten`;
      await cmd.shouldSucceed('camera-create --name Exempelbaten');
      await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/hamnen --as name=Hamnen`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/hamnen/position --lat=57.5 --lng=11.9`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/huset --as name=Huset`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/torpet --as name=Torpet`);
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/berit --name Berit`);
      await cmd.shouldSucceed(`camera-set-owner ${boat} ${PEOPLE_ROOT}/berit --from 2010 --to 2020`);
      await cmd.shouldSucceed(`person-set-home ${PEOPLE_ROOT}/berit ${LOCATIONS_ROOT}/huset --from 2005`);
      await cmd.shouldSucceed(`person-set-home ${PEOPLE_ROOT}/berit ${LOCATIONS_ROOT}/torpet --from 1990 --to 2000`);

      // Only the residence that overlaps the ownership counts, and only for the overlap.
      let homes = await client.execJson<CameraHomes>(`camera-home ${boat} list`);
      assertEquals(homes.homes.map((home) => [home.source, home.name, home.from, home.to]), [['owner', 'Huset', '2010', '2020']]);
      assertEquals(homes.homes[0].owner, `${PEOPLE_ROOT}/berit`);

      await cmd.shouldSucceed('camera-home Exempelbaten add hamnen');
      await cmd.shouldSucceed(`camera-home ${boat} add ${LOCATIONS_ROOT}/hamnen`);
      homes = await client.execJson<CameraHomes>(`camera-home ${boat}`);
      assertEquals(homes.homes.map((home) => [home.source, home.name, home.lat, home.lng]), [['camera', 'Hamnen', 57.5, 11.9]]);
      assertEquals((await client.execJson<{ softlink: string }>(`props -L ${boat}/homes/hamnen`)).softlink, `${LOCATIONS_ROOT}/hamnen`);

      // A person is no place to come home to.
      await cmd.shouldFail(`camera-home ${boat} add ${PEOPLE_ROOT}/berit`);
      await cmd.shouldFail(`camera-home ${boat} rm huset`);

      await cmd.shouldSucceed(`camera-home ${boat} rm hamnen`);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${boat}/homes`), false);
      homes = await client.execJson<CameraHomes>(`camera-home ${boat} list`);
      assertEquals(homes.homes.map((home) => home.source), ['owner']);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
