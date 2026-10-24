/**
 * auto-album-cluster: how the organizer would group the media under some paths, read only. A run
 * of days away from home is one trip, named after the town most of it was taken in; home is
 * `--home`, else the owner's residence that year, else the densest cell of the year's own points;
 * an album's members can be the scope; nothing is written. Places and people are invented.
 */
import { ALBUMS_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import type { AutoAlbumClusterReport } from '@archive/staging/api';
import { assertEquals } from '@std/assert';
import { ADMIN_ACCESS, captureTime, createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });

const FILES = '/home/traveller/staging/files/inbox';
const ALBUMS = '/home/traveller/staging/albums/inbox';

const HOME = { lat: 59.33, lng: 18.06 };
const AWAY = { lat: 57.7, lng: 11.97 };

Deno.test({ name: 'auto-album-cluster', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client: ShellClient = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const analyse = (args: string) => client.execJson<AutoAlbumClusterReport>(`auto-album-cluster ${args}`);

  /** `n` photos five minutes apart from `start`, at `at` (or nowhere). */
  const part = async (tag: string, start: string, at: { lat: number; lng: number } | undefined, n = 2) => {
    for (let i = 0; i < n; i++) {
      const path = `${FILES}/${tag}-${i}.jpg`;
      const time = captureTime(new Date(Date.parse(start) + i * 5 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')) as { takenAt: string; takenAtUtc: string };
      await cmd.shouldSucceed(`mknode -t file ${path} --as mimetype=image/jpeg --as takenAt=${time.takenAt} --as takenAtUtc=${time.takenAtUtc}`);
      if (at) {
        await cmd.shouldSucceed(`mknode -t position ${path}/position`);
        await cmd.shouldSucceed(`position-set ${path}/position --lat=${at.lat} --lng=${at.lng}`);
      }
    }
  };

  try {
    await cmd.shouldSucceed('user-create traveller --uid 3001');
    await cmd.shouldSucceed('staging init --user traveller');
    // Two days at home, morning and evening, then three days away, morning and evening, with an
    // evening indoors between two away parts.
    for (const day of ['2027-05-01', '2027-05-02']) {
      await part(`home-${day}-m`, `${day}T10:00:00Z`, HOME, 4);
      await part(`home-${day}-e`, `${day}T19:00:00Z`, HOME, 4);
    }
    for (const day of ['2027-05-04', '2027-05-05', '2027-05-06']) {
      await part(`away-${day}-m`, `${day}T10:00:00Z`, AWAY);
      await part(`away-${day}-e`, `${day}T19:00:00Z`, AWAY);
    }
    await part('away-2027-05-05-indoors', '2027-05-05T23:30:00Z', undefined);
    // What the geocode pipeline leaves on most of the away photos' positions.
    for (const day of ['2027-05-04', '2027-05-05']) {
      for (const tag of ['m', 'e']) {
        for (const i of [0, 1]) await cmd.shouldSucceed(`attrs ${FILES}/away-${day}-${tag}-${i}.jpg/position -s city=Harbourtown -s country=Farland`);
      }
    }

    await t.step('a flag or an unknown value is named, not swallowed', async () => {
      await cmd.shouldFailWith(`auto-album-cluster ${FILES} --bogus`, 'unknown flag --bogus');
      await cmd.shouldFailWith(`auto-album-cluster ${FILES} --strategy albums`, '--strategy is one of');
      await cmd.shouldFailWith('auto-album-cluster', 'usage: auto-album-cluster <path>');
    });

    await t.step('a run of days away from home is one trip, named after its town; nothing is written', async () => {
      const report = await analyse(`${FILES} --home=${HOME.lat},${HOME.lng}`);
      assertEquals(report.home['2027']?.source, 'flag');
      assertEquals([report.items, report.undated, report.geotagged], [30, 0, 28]);
      const trip = report.groups.find((group) => group.kind === 'trip')!;
      assertEquals([trip.action, trip.days, trip.members, trip.parts, trip.significance], ['proposed', 3, 14, 7, 'trip']);
      assertEquals(trip.name, 'Harbourtown · 4–6 May 2027');
      assertEquals(trip.memberPaths, undefined);
      assertEquals(report.groups.reduce((sum, group) => sum + group.members, 0), 30);
      assertEquals((await vfs.children(ADMIN_ACCESS, ALBUMS)).length, 0);
    });

    await t.step("without a residence, the year's densest cell is home", async () => {
      const report = await analyse(`${FILES} --members`);
      assertEquals(report.home['2027']?.source, 'inbox');
      assertEquals(Math.abs((report.home['2027']?.lat ?? 0) - HOME.lat) < 0.05, true);
      const trip = report.groups.find((group) => group.kind === 'trip')!;
      assertEquals(trip.memberPaths?.length, 14);
    });

    await t.step("the owner's residence that year is home", async () => {
      // Anna Andersson, the traveller, moved to the coast in March 2027: the days in the city are now away.
      await cmd.shouldSucceed(`mkdir -p ${PEOPLE_ROOT} ${LOCATIONS_ROOT}`);
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna-andersson --name 'Anna Andersson'`);
      await cmd.shouldSucceed(`mknode -t location ${LOCATIONS_ROOT}/the-coast`);
      await cmd.shouldSucceed(`position-set ${LOCATIONS_ROOT}/the-coast/position --lat=${AWAY.lat} --lng=${AWAY.lng}`);
      await cmd.shouldSucceed(`person-set-home --from 2027-03 ${PEOPLE_ROOT}/anna-andersson ${LOCATIONS_ROOT}/the-coast`);
      await cmd.shouldSucceed(`ln -s ${PEOPLE_ROOT}/anna-andersson /etc/users/traveller/person`);
      const report = await analyse(FILES);
      assertEquals(report.home['2027'], { lat: AWAY.lat, lng: AWAY.lng, source: 'residence', location: `${LOCATIONS_ROOT}/the-coast` });
      const trips = report.groups.filter((group) => group.kind === 'trip');
      assertEquals(trips.map((group) => [group.members, group.timeStart?.slice(0, 10)]), [[16, '2027-05-01']]);
    });

    await t.step("an album's members can be the scope", async () => {
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} && mknode -t album ${ALBUMS_ROOT}/weekend`);
      for (const tag of ['m', 'e']) {
        for (const i of [0, 1]) await cmd.shouldSucceed(`ln -s ${FILES}/away-2027-05-04-${tag}-${i}.jpg ${ALBUMS_ROOT}/weekend/${tag}-${i}.jpg`);
      }
      const report = await analyse(`${ALBUMS_ROOT}/weekend --home=${HOME.lat},${HOME.lng} --user traveller`);
      assertEquals(report.items, 4);
      assertEquals(report.groups.map((group) => [group.kind, group.members]), [['event', 4]]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
