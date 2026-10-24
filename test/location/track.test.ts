/**
 * Track commands: track-create / track-append / track-read / track-import (GPX) /
 * track-list / track-stage. A track is a device's child `track`, and every command takes the
 * device (its slug or path) or the track's path. Runs against the in-memory track registry.
 */

import { DEVICES_ROOT } from '@archive/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { devicesForGpx, parseGpx } from '@archive/location/track';
import type { TrackStageResult } from '@archive/location/api';
import type { StagingStatus } from '@archive/staging/api';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

type Point = { lat: number; lng: number; ts: string; alt?: number };
type ReadResult = {
  segments: Array<{ day: string; points: Point[] }>;
  points: number;
  truncated: boolean;
};

const flat = (result: ReadResult): Point[] => result.segments.flatMap((segment) => segment.points);

type Summary = { points: number; firstTs?: string; lastTs?: string; bbox?: Record<string, number> };

/** What `track-list` says of one device's track. */
const listed = async (device: string): Promise<Summary | undefined> =>
  (await client.execJson<(Summary & { id: string })[]>('track-list')).find((track) => track.id === device);

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk><name>Test</name><trkseg>
    <trkpt lat="57.70" lon="11.97"><ele>12.5</ele><time>2020-06-01T10:00:00Z</time></trkpt>
    <trkpt lat="57.71" lon="11.98"><ele>13.0</ele><time>2020-06-01T10:01:00Z</time></trkpt>
    <trkpt lon="11.99" lat="57.72"><time>2020-06-01T10:02:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

Deno.test('parseGpx reads the creator and the names outside the points', () => {
  const gpx = parseGpx(`<gpx creator="Exempel Logger 2"><metadata><name>Morning walk</name></metadata>
    <trk><name><![CDATA[Day 1]]></name><trkseg><trkpt lat="1" lon="2"><name>Bench</name></trkpt></trkseg></trk></gpx>`);
  assertEquals(gpx.creator, 'Exempel Logger 2');
  assertEquals(gpx.names, ['Morning walk', 'Day 1']);
  assertEquals(gpx.points.length, 1);
});

Deno.test('devicesForGpx matches a device by name, make and model, or serial', () => {
  const devices = [
    { name: 'Hiking GPS', make: 'Exempel', model: 'Logger 2' },
    { name: 'Phone', serialNumber: 'SN12345' },
    { name: 'Go' },
  ];
  assertEquals(devicesForGpx(devices, { creator: 'Exempel Logger 2', names: [] }).map((d) => d.name), ['Hiking GPS']);
  assertEquals(devicesForGpx(devices, { names: ['export from sn12345'] }).map((d) => d.name), ['Phone']);
  // Whole words: "Phone" is not in "Headphones", and two letters ("Go") say nothing.
  assertEquals(devicesForGpx(devices, { names: ['Headphones on', 'Go for a walk'] }), []);
});

Deno.test({
  name: 'track commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    for (const device of ['trip1', 'south', 'backfill', 'thin', 'paused', 'hike']) {
      await cmd.shouldSucceed(`mknode -p -t device ${DEVICES_ROOT}/${device} --as name=${device}`);
    }

    await t.step("track-create gives a device its track, the device's child track", async () => {
      await cmd.shouldSucceed('track-create trip1 --description "Trip 1"');

      const info = await client.execJson<{ type: string }>(`info ${DEVICES_ROOT}/trip1/track`);
      assertEquals(info.type, 'track');

      const attrs = await client.execJson<{ description: string; points?: number }>(`attrs ${DEVICES_ROOT}/trip1/track`);
      assertEquals(attrs.description, 'Trip 1');
      assertEquals(attrs.points, undefined);
      assertEquals((await listed('trip1'))?.points, 0);

      await cmd.shouldFailWith('track-create trip1', 'already exists');
      await cmd.shouldFailWith(`track-create ${DEVICES_ROOT}/trip1`, 'already exists');
    });

    await t.step('track-append and track-read roundtrip points', async () => {
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/trip1/track 57.7 11.97 --ts 2020-05-01T10:00:00Z`);
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/trip1/track 57.71 11.98 --ts 2020-05-01T10:01:00Z --alt=5`);
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/trip1/track --json '[{"lat":57.72,"lng":11.99,"ts":"2020-05-01T10:02:00Z"}]'`);

      const all = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/trip1/track`);
      const points = flat(all);

      assertEquals(all.segments.length, 1);
      assertEquals(all.segments[0].day, '2020-05-01');
      assertEquals(points.map((p) => p.lat), [57.7, 57.71, 57.72]);
      assertEquals(points[0].ts, '2020-05-01T10:00:00.000Z');
      assertEquals(points[1].alt, 5);

      const window = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/trip1/track --from 2020-05-01T10:01:00Z`);
      assertEquals(flat(window).map((p) => p.lat), [57.71, 57.72]);
    });

    await t.step('a southern coordinate needs the flag form, and now has one', async () => {
      // Cape Town: a negative latitude, and an altitude below sea level. Both start with
      // a dash, which the positional form cannot carry — parseArgs reads it as the next
      // flag. Its own track, so trip1's point count and bbox stay exact.
      await cmd.shouldSucceed('track-create south --description South');
      await cmd.shouldFail(`track-append ${DEVICES_ROOT}/south/track -33.9249 18.4241 --ts=2020-05-01T10:00:00Z`);

      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/south/track --lat=-33.9249 --lng=18.4241 --ts=2020-05-01T10:00:00Z --alt=-5`);

      const south = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/south/track`);
      const pts = south.segments.flatMap((seg) => seg.points);
      assertEquals(pts.length, 1);
      assertEquals(pts[0].lat, -33.9249);
      assertEquals(pts[0].lng, 18.4241);
      assertEquals(pts[0].alt, -5);
    });

    await t.step('re-appending the same fix adds nothing', async () => {
      const result = await client.execJson<{ appended: number; skipped: number }>(
        `track-append ${DEVICES_ROOT}/trip1/track --json '[{"lat":57.7,"lng":11.97,"ts":"2020-05-01T10:00:00Z"}]'`,
      );

      assertEquals(result.appended, 0);
      assertEquals(result.skipped, 1);
    });

    await t.step('track-list follows every append', async () => {
      const before = await listed('trip1');
      assertEquals(before?.points, 3);
      assertEquals(before?.firstTs, '2020-05-01T10:00:00.000Z');
      assertEquals(before?.lastTs, '2020-05-01T10:02:00.000Z');
      assertEquals(before?.bbox, { north: 57.72, south: 57.7, east: 11.99, west: 11.97 });

      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/trip1/track 57.69 12.05 --ts 2020-05-01T10:03:00Z`);
      const after = await listed('trip1');
      assertEquals(after?.points, 4);
      assertEquals(after?.lastTs, '2020-05-01T10:03:00.000Z');
      assertEquals(after?.bbox, { north: 57.72, south: 57.69, east: 12.05, west: 11.97 });
    });

    await t.step('track-list follows a track fed by its routing key', async () => {
      await cmd.shouldSucceed(`mknode -t device ${DEVICES_ROOT}/live --as name=live`);
      await cmd.shouldSucceed('track-create live --routing-key tracker.live');
      ctx.router.publish('tracker.live', [
        { lat: 57.7, lng: 11.97, ts: '2022-02-01T08:00:00Z' },
        { lat: 57.75, lng: 11.9, ts: '2022-02-01T08:01:00Z' },
      ]);

      // The relay hands the event over on a later turn.
      let summary: Summary | undefined;
      for (let tries = 0; tries < 50 && summary?.points !== 2; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        summary = await listed('live');
      }
      assertEquals(summary?.points, 2);
      assertEquals(summary?.lastTs, '2022-02-01T08:01:00.000Z');
      assertEquals(summary?.bbox, { north: 57.75, south: 57.7, east: 11.97, west: 11.9 });
    });

    await t.step('an out-of-order append reads back in time order', async () => {
      await cmd.shouldSucceed('track-create backfill');
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/backfill/track 57.8 11.5 --ts 2021-03-01T10:05:00Z`);
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/backfill/track 57.7 11.4 --ts 2021-03-01T10:00:00Z`);

      const points = flat(await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/backfill/track`));

      assertEquals(points.map((p) => p.ts), ['2021-03-01T10:00:00.000Z', '2021-03-01T10:05:00.000Z']);
    });

    await t.step('--bbox reads past the box so the line reaches its edge', async () => {
      await cmd.shouldSucceed('track-create thin');
      // A west-to-east line: only 11.3, 11.4 and 11.5 are inside the box below.
      const points = Array.from({ length: 9 }, (_, i) => ({
        lat: 57.7,
        lng: 11.0 + i * 0.1,
        ts: `2021-01-01T10:0${i}:00Z`,
      }));
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/thin/track --json '${JSON.stringify(points)}'`);

      const boxed = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/thin/track --bbox=58,57,11.55,11.25`);
      const lngs = flat(boxed).map((p) => Number(p.lng.toFixed(1)));

      // The default margin widens the box by a quarter of its own size, which
      // picks up the neighbour either side rather than stopping inside the view.
      assertEquals(lngs.includes(11.3), true);
      assertEquals(lngs.includes(11.5), true);
      assertEquals(lngs.includes(11.2), true);
      assertEquals(lngs.includes(11.6), true);
      assertEquals(lngs.includes(11.0), false);

      // margin=0 is the box exactly.
      const exact = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/thin/track --bbox=58,57,11.55,11.25 --margin 0`);
      assertEquals(flat(exact).map((p) => Number(p.lng.toFixed(1))), [11.3, 11.4, 11.5]);
    });

    await t.step('a pause cuts the line into two segments', async () => {
      await cmd.shouldSucceed('track-create paused');
      const points = [
        { lat: 57.7, lng: 11.0, ts: '2021-02-01T10:00:00Z' },
        { lat: 57.7, lng: 11.1, ts: '2021-02-01T10:01:00Z' },
        { lat: 57.7, lng: 11.2, ts: '2021-02-01T14:00:00Z' },
        { lat: 57.7, lng: 11.3, ts: '2021-02-01T14:01:00Z' },
      ];
      await cmd.shouldSucceed(`track-append ${DEVICES_ROOT}/paused/track --json '${JSON.stringify(points)}'`);

      const result = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/paused/track`);
      assertEquals(result.segments.length, 2);
      assertEquals(result.segments.map((segment) => segment.points.length), [2, 2]);
    });

    await t.step('--tolerance thins the line, --limit caps it', async () => {
      const thin = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/thin/track --tolerance 1`);
      // A straight line collapses to its endpoints.
      assertEquals(thin.points, 2);

      const capped = await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/thin/track --limit 4`);
      assertEquals(capped.points <= 4, true);
      assertEquals(capped.truncated, true);
    });

    await t.step('track-import parses GPX (both attribute orders)', async () => {
      await cmd.shouldSucceed('mkfile /trip.gpx');
      const fh = await ctx.vfs.open(ADMIN_ACCESS, '/trip.gpx', { mode: 'w' });
      try {
        await fh.write(new TextEncoder().encode(GPX));
      } finally {
        await fh.close();
      }

      const result = await client.execJson<{ imported: number; track: string }>(`track-import hike /trip.gpx`);
      assertEquals(result.imported, 3);
      assertEquals(result.track, `${DEVICES_ROOT}/hike/track`);

      // The device's slug, its path and the track's path all name the same track.
      assertEquals(await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/hike`), await client.execJson<ReadResult>('track-read hike'));
      const points = flat(await client.execJson<ReadResult>(`track-read ${DEVICES_ROOT}/hike/track`));
      assertEquals(points.map((p) => p.lat), [57.7, 57.71, 57.72]);
      assertEquals(points.map((p) => p.lng), [11.97, 11.98, 11.99]);
      assertEquals(points[0].alt, 12.5);
      assertEquals(points[2].ts, '2020-06-01T10:02:00.000Z');

      const hike = await listed('hike');
      assertEquals(hike?.points, 3);
      assertEquals(hike?.bbox, { north: 57.72, south: 57.7, east: 11.99, west: 11.97 });

      // Importing the same file twice does not double the track.
      const again = await client.execJson<{ imported: number; skipped: number }>(`track-import ${DEVICES_ROOT}/hike/track /trip.gpx`);
      assertEquals(again.imported, 0);
      assertEquals(again.skipped, 3);
    });

    await t.step('rejects invalid input', async () => {
      await cmd.shouldSucceed('mkfile /not-track');
      await cmd.shouldFailWith('track-append /not-track 1 2', 'not a device or a track');
      await cmd.shouldSucceed(`mknode -t device ${DEVICES_ROOT}/trackless`);
      await cmd.shouldFailWith('track-read trackless', 'has no track yet');
      await cmd.shouldFailWith(`track-append ${DEVICES_ROOT}/trip1/track abc 11`, 'numeric lat and lng');
      await cmd.shouldFailWith(`track-read ${DEVICES_ROOT}/thin/track --bbox=1,2,3`, 'invalid --bbox');
      await cmd.shouldFailWith(`track-read ${DEVICES_ROOT}/thin/track --tolerance x`, 'invalid --tolerance');
      const res = await client.exec('track-read missing');
      assertEquals(res.success, false);
      assertStringIncludes(res.error ?? '', 'track-read');
    });

    await t.step('track-stage imports a GPX into the device it names, and removes the file', async () => {
      await cmd.shouldSucceed(`mknode -t device ${DEVICES_ROOT}/logger --as name=Logger --as make=Exempel --as model=Trail`);
      await cmd.shouldSucceed('staging init --user admin && mkdir -p /home/admin/staging/files/inbox/upload-2026-10-16');
      const write = async (path: string, xml: string) => {
        await cmd.shouldSucceed(`mkfile ${path}`);
        const fh = await ctx.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
        try {
          await fh.write(new TextEncoder().encode(xml));
        } finally {
          await fh.close();
        }
      };

      await write('/home/admin/staging/files/inbox/upload-2026-10-16/walk.gpx', GPX.replace('creator="test"', 'creator="Exempel Trail"'));
      const staged = await client.execJson<{ status: string; track: string; imported: number }>('track-stage /home/admin/staging/files/inbox/upload-2026-10-16/walk.gpx');
      assertEquals([staged.status, staged.track, staged.imported], ['imported', `${DEVICES_ROOT}/logger/track`, 3]);
      await cmd.shouldFail('info /home/admin/staging/files/inbox/upload-2026-10-16/walk.gpx');

      // Staged again, nothing is added: a fix is keyed by its time.
      await write('/home/admin/staging/files/inbox/upload-2026-10-16/again.gpx', GPX.replace('creator="test"', 'creator="Exempel Trail"'));
      assertEquals((await client.execJson<{ imported: number }>('track-stage /home/admin/staging/files/inbox/upload-2026-10-16/again.gpx')).imported, 0);
    });

    await t.step('track-stage leaves a GPX naming no known device waiting in routes/, until told which', async () => {
      const staged = '/home/admin/staging/files/inbox/upload-2026-10-16/odd.gpx';
      await cmd.shouldSucceed(`mkfile ${staged}`);
      const fh = await ctx.vfs.open(ADMIN_ACCESS, staged, { mode: 'w' });
      try {
        await fh.write(new TextEncoder().encode(GPX.replace('creator="test"', 'creator="Unknown Thing"').replaceAll('2020-06-01', '2020-07-01')));
      } finally {
        await fh.close();
      }

      const pending = await client.execJson<TrackStageResult>(`track-stage ${staged}`);
      const waiting = '/home/admin/staging/routes/odd.gpx';
      assertEquals(pending.status === 'pending' && pending.path, waiting);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, staged), false);
      const attrs = await client.execJson<{ trackDevicePending: boolean; gpxCreator: string }>(`attrs ${waiting}`);
      assertEquals([attrs.trackDevicePending, attrs.gpxCreator], [true, 'Unknown Thing']);
      assertEquals((await client.execJson<StagingStatus>('staging status')).routesWaiting, 1);

      const told = await client.execJson<{ status: string; imported: number }>(`track-stage ${waiting} --device logger`);
      assertEquals([told.status, told.imported], ['imported', 3]);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, waiting), false);
    });

    await t.step('track-list names the devices that have a track', async () => {
      const tracks = await client.execJson<{ id: string; path: string; name: string; points: number }[]>('track-list');
      assertEquals(tracks.map((track) => track.id).sort(), ['backfill', 'hike', 'live', 'logger', 'paused', 'south', 'thin', 'trip1']);
      const hike = tracks.find((track) => track.id === 'hike')!;
      assertEquals([hike.path, hike.name, hike.points], [`${DEVICES_ROOT}/hike/track`, 'hike', 3]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
