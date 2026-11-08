/**
 * Track commands: track-append / track-read / track-import (GPX) / track-list / track-stage /
 * track-mark / track-move / track-update / camera-device. A track is a device's track endpoint under
 * `/dev` — here, as core's `tracker` driver keeps one, a device's `position` — and every command
 * takes its path, or the device or a camera linked to one, by its path or its name; a GPX file read
 * into it goes through its device and is kept in its `routes/`, linked from its `sources/`. Runs
 * against the in-memory track registry.
 */

import { CAMERAS_ROOT } from '@archive/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/testing';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { tracksForGpx } from '@archive/location/track';
import type { GpxInfo, TrackEntry, TrackStageResult, TripList } from '@archive/location/api';
import type { StagingStatus } from '@archive/staging/api';
import type { SourceFile } from '@archive/sources/api';
import { deviceAt, mkTracker, positionOf } from './tracker.ts';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

type Point = { lat: number; lng: number; ts: string; alt?: number; rejected?: string; manual?: string };
type ReadResult = {
  segments: Array<{ day: string; points: Point[] }>;
  points: number;
  truncated: boolean;
};

const flat = (result: ReadResult): Point[] => result.segments.flatMap((segment) => segment.points);

/** What `track-list` says of one device's track. */
const listed = async (device: string): Promise<TrackEntry | undefined> =>
  (await client.execJson<TrackEntry[]>('track-list')).find((track) => track.path === positionOf(device));

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test">
  <trk><name>Test</name><trkseg>
    <trkpt lat="57.70" lon="11.97"><ele>12.5</ele><time>2020-06-01T10:00:00Z</time></trkpt>
    <trkpt lat="57.71" lon="11.98"><ele>13.0</ele><time>2020-06-01T10:01:00Z</time></trkpt>
    <trkpt lon="11.99" lat="57.72"><time>2020-06-01T10:02:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;

Deno.test("tracksForGpx matches a track by its device's name, make and model, or serial, or a linked camera's", () => {
  const tracks = [
    { name: 'Hiking GPS' },
    { name: 'Anna', names: [{ name: 'Phone', serialNumber: 'SN12345' }] },
    { name: 'Sailboat', names: [{ name: 'Chart plotter', make: 'Exempel', model: 'Logger 2' }] },
    { name: 'Old logger', names: [{ make: 'Exempel', model: 'Trail 30' }] },
    { name: 'Go' },
  ];
  assertEquals(tracksForGpx(tracks, { creator: 'Exempel Logger 2', names: [] }).map((track) => track.name), ['Sailboat']);
  assertEquals(tracksForGpx(tracks, { creator: 'Exempel Trail 30 (firmware 2.1)', names: [] }).map((track) => track.name), ['Old logger']);
  assertEquals(tracksForGpx(tracks, { names: ['export from sn12345'] }).map((track) => track.name), ['Anna']);
  assertEquals(tracksForGpx(tracks, { names: ['Hiking GPS, day 2'] }).map((track) => track.name), ['Hiking GPS']);
  // Whole words: "Phone" is not in "Headphones", and two letters ("Go") say nothing.
  assertEquals(tracksForGpx(tracks, { names: ['Headphones on', 'Go for a walk'] }), []);
});

Deno.test({
  name: 'track commands',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const ctx = await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const tracker = (name: string) => cmd.shouldSucceed(mkTracker(name));

  const write = async (path: string, xml: string) => {
    await cmd.shouldSucceed(`mkfile ${path}`);
    const fh = await ctx.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    try {
      await fh.write(new TextEncoder().encode(xml));
    } finally {
      await fh.close();
    }
  };

  try {
    for (const name of ['trip1', 'south', 'backfill', 'thin', 'paused', 'moored', 'hike', 'glitch', 'cluster', 'wrong', 'right', 'untimed']) await tracker(name);

    await t.step("track-list finds a device's track under /dev, named after the device", async () => {
      const trip1 = await listed('trip1');
      assertEquals([trip1?.name, trip1?.points, trip1?.device], ['trip1', 0, deviceAt('trip1')]);

      // The device's label names it, not the position endpoint's own.
      await cmd.shouldSucceed(`device-label trip1 'Trip one'`);
      assertEquals((await listed('trip1'))?.name, 'Trip one');
      await cmd.shouldSucceed(`attrs ${positionOf('trip1')} -s label='The first trip'`);
      assertEquals((await listed('trip1'))?.name, 'Trip one');
      await cmd.shouldSucceed(`attrs ${positionOf('trip1')} -s label=Position && device-label trip1 trip1`);
    });

    await t.step('track-append and track-read roundtrip points', async () => {
      await cmd.shouldSucceed(`track-append ${positionOf('trip1')} 57.7 11.97 --ts 2020-05-01T10:00:00Z`);
      await cmd.shouldSucceed(`track-append ${positionOf('trip1')} 57.71 11.98 --ts 2020-05-01T10:01:00Z --alt=5`);
      await cmd.shouldSucceed(`track-append ${positionOf('trip1')} --json '[{"lat":57.72,"lng":11.99,"ts":"2020-05-01T10:02:00Z"}]'`);

      const all = await client.execJson<ReadResult>(`track-read ${positionOf('trip1')}`);
      const points = flat(all);

      assertEquals(all.segments.length, 1);
      assertEquals(all.segments[0].day, '2020-05-01');
      assertEquals(points.map((p) => p.lat), [57.7, 57.71, 57.72]);
      assertEquals(points[0].ts, '2020-05-01T10:00:00.000Z');
      assertEquals(points[1].alt, 5);

      const window = await client.execJson<ReadResult>(`track-read ${positionOf('trip1')} --from 2020-05-01T10:01:00Z`);
      assertEquals(flat(window).map((p) => p.lat), [57.71, 57.72]);
    });

    await t.step('a southern coordinate needs the flag form, and now has one', async () => {
      // Cape Town: a negative latitude, and an altitude below sea level. Both start with
      // a dash, which the positional form cannot carry — parseArgs reads it as the next
      // flag. Its own track, so trip1's point count and bbox stay exact.
      await cmd.shouldFail(`track-append ${positionOf('south')} -33.9249 18.4241 --ts=2020-05-01T10:00:00Z`);

      await cmd.shouldSucceed(`track-append ${positionOf('south')} --lat=-33.9249 --lng=18.4241 --ts=2020-05-01T10:00:00Z --alt=-5`);

      const south = await client.execJson<ReadResult>(`track-read ${positionOf('south')}`);
      const pts = south.segments.flatMap((seg) => seg.points);
      assertEquals(pts.length, 1);
      assertEquals(pts[0].lat, -33.9249);
      assertEquals(pts[0].lng, 18.4241);
      assertEquals(pts[0].alt, -5);
    });

    await t.step('re-appending the same fix adds nothing', async () => {
      const result = await client.execJson<{ appended: number; skipped: number }>(
        `track-append ${positionOf('trip1')} --json '[{"lat":57.7,"lng":11.97,"ts":"2020-05-01T10:00:00Z"}]'`,
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

      await cmd.shouldSucceed(`track-append ${positionOf('trip1')} 57.69 12.05 --ts 2020-05-01T10:03:00Z`);
      const after = await listed('trip1');
      assertEquals(after?.points, 4);
      assertEquals(after?.lastTs, '2020-05-01T10:03:00.000Z');
      assertEquals(after?.bbox, { north: 57.72, south: 57.69, east: 12.05, west: 11.97 });
    });

    await t.step('track-list follows a track its device is written to', async () => {
      await tracker('live');
      const fixes = [
        { lat: 57.7, lng: 11.97, ts: '2022-02-01T08:00:00Z' },
        { lat: 57.75, lng: 11.9, ts: '2022-02-01T08:01:00Z' },
      ];
      await cmd.shouldSucceed(`echo '${JSON.stringify(fixes)}' > ${deviceAt('live')}`);

      const summary = await listed('live');
      assertEquals(summary?.points, 2);
      assertEquals(summary?.lastTs, '2022-02-01T08:01:00.000Z');
      assertEquals(summary?.bbox, { north: 57.75, south: 57.7, east: 11.97, west: 11.9 });
    });

    await t.step('an out-of-order append reads back in time order', async () => {
      await cmd.shouldSucceed(`track-append ${positionOf('backfill')} 57.8 11.5 --ts 2021-03-01T10:05:00Z`);
      await cmd.shouldSucceed(`track-append ${positionOf('backfill')} 57.7 11.4 --ts 2021-03-01T10:00:00Z`);

      const points = flat(await client.execJson<ReadResult>(`track-read ${positionOf('backfill')}`));
      assertEquals(points.map((p) => p.ts), ['2021-03-01T10:00:00.000Z', '2021-03-01T10:05:00.000Z']);
    });

    await t.step('--bbox reads past the box so the line reaches its edge', async () => {
      // A west-to-east line: only 11.3, 11.4 and 11.5 are inside the box below.
      const points = Array.from({ length: 9 }, (_, i) => ({
        lat: 57.7,
        lng: 11.0 + i * 0.1,
        ts: `2021-01-01T10:0${i}:00Z`,
      }));
      await cmd.shouldSucceed(`track-append ${positionOf('thin')} --json '${JSON.stringify(points)}'`);

      const boxed = await client.execJson<ReadResult>(`track-read ${positionOf('thin')} --bbox=58,57,11.55,11.25`);
      const lngs = flat(boxed).map((p) => Number(p.lng.toFixed(1)));

      // The default margin widens the box by a quarter of its own size, which
      // picks up the neighbour either side rather than stopping inside the view.
      assertEquals(lngs.includes(11.3), true);
      assertEquals(lngs.includes(11.5), true);
      assertEquals(lngs.includes(11.2), true);
      assertEquals(lngs.includes(11.6), true);
      assertEquals(lngs.includes(11.0), false);

      // margin=0 is the box exactly.
      const exact = await client.execJson<ReadResult>(`track-read ${positionOf('thin')} --bbox=58,57,11.55,11.25 --margin 0`);
      assertEquals(flat(exact).map((p) => Number(p.lng.toFixed(1))), [11.3, 11.4, 11.5]);
    });

    await t.step('a pause cuts the line into two segments', async () => {
      const points = [
        { lat: 57.7, lng: 11.0, ts: '2021-02-01T10:00:00Z' },
        { lat: 57.7, lng: 11.1, ts: '2021-02-01T10:01:00Z' },
        { lat: 57.7, lng: 11.2, ts: '2021-02-01T14:00:00Z' },
        { lat: 57.7, lng: 11.3, ts: '2021-02-01T14:01:00Z' },
      ];
      await cmd.shouldSucceed(`track-append ${positionOf('paused')} --json '${JSON.stringify(points)}'`);

      const result = await client.execJson<ReadResult>(`track-read ${positionOf('paused')}`);
      assertEquals(result.segments.length, 2);
      assertEquals(result.segments.map((segment) => segment.points.length), [2, 2]);
    });

    await t.step("--still draws a stay as two points, and the track's kind says what a spike is", async () => {
      // Half an hour drifting ten metres either way on a berth, a fix a minute, with one fix
      // thrown 3 km north: 50 m/s there and back, a glitch for a boat but not for a car.
      const metre = 1 / 111_320;
      const points = Array.from({ length: 31 }, (_, i) => ({
        lat: 57.7 + (i === 15 ? 3000 : ((i % 3) - 1) * 10) * metre,
        lng: 11.97,
        ts: new Date(Date.parse('2021-04-01T10:00:00Z') + i * 60_000).toISOString(),
      }));
      await cmd.shouldSucceed(`track-append ${positionOf('moored')} --json '${JSON.stringify(points)}'`);
      const spiked = (read: ReadResult) => flat(read).some((p) => p.lat > 57.7 + 1000 * metre);

      // A device's name stands for its track.
      assertEquals((await client.execJson<ReadResult>(`track-read moored`)).points, 31);

      const asCar = await client.execJson<ReadResult>(`track-read moored --still`);
      assertEquals(spiked(asCar), true);
      assertEquals(asCar.points < 31, true);

      const slower = await client.execJson<ReadResult>(`track-read moored --still --max-speed=20`);
      assertEquals(slower.points, 2);

      await cmd.shouldSucceed('track-update moored --kind boat');
      const asBoat = await client.execJson<ReadResult>(`track-read moored --still`);
      assertEquals(asBoat.points, 2);
      assertEquals(flat(asBoat).map((p) => p.ts), [points[0].ts, points[30].ts]);
      assertEquals(spiked(asBoat), false);

      await cmd.shouldFailWith('track-read moored --max-speed=20', '--max-speed needs --still');
    });

    await t.step('track-update sets how a track travels, refuses what it does not know, and --clear removes it', async () => {
      await cmd.shouldSucceed(`track-update ${deviceAt('moored')} --timezone Europe/Stockholm --description 'Kept at the jetty'`);
      const attrs = await client.execJson<{ kind?: string; timezone?: string; description?: string }>(`attrs ${positionOf('moored')}`);
      assertEquals([attrs.kind, attrs.timezone, attrs.description], ['boat', 'Europe/Stockholm', 'Kept at the jetty']);
      assertEquals((await listed('moored'))?.kind, 'boat');
      assertEquals(await client.execJson('track-update moored --clear timezone --clear description'), { ok: true });
      const cleared = await client.execJson<{ kind?: string; timezone?: string; description?: string }>(`attrs ${positionOf('moored')}`);
      assertEquals([cleared.kind, cleared.timezone, cleared.description], ['boat', undefined, undefined]);

      await cmd.shouldFailWith('track-update moored --kind submarine', "unknown kind 'submarine'");
      await cmd.shouldFailWith('track-update moored --timezone Mars/Olympus', "unknown timezone 'Mars/Olympus'");
      await cmd.shouldFailWith('track-update moored --kind car --clear kind', 'both set and cleared');
      await cmd.shouldFailWith('track-update moored --clear colour', "unknown field 'colour'");
      await cmd.shouldFailWith('track-update moored', 'nothing to change');
    });

    await t.step("a device's class is how its track travels while the track has no kind of its own", async () => {
      await cmd.shouldSucceed(mkTracker('ferry', 'Ferry', {}, 'boat'));
      assertEquals((await listed('ferry'))?.kind, 'boat');
      assertEquals((await client.execJson<TripList>('trip-list ferry')).units, 'nautical');
      await cmd.shouldSucceed('track-update ferry --kind foot');
      assertEquals((await listed('ferry'))?.kind, 'foot');
      // A class that is no way of travelling says nothing.
      await cmd.shouldSucceed(mkTracker('pocket', 'Pocket', {}, 'phone'));
      assertEquals((await listed('pocket'))?.kind, undefined);
    });

    await t.step('--tolerance thins the line, --limit caps it', async () => {
      const thin = await client.execJson<ReadResult>(`track-read ${positionOf('thin')} --tolerance 1`);
      // A straight line collapses to its endpoints.
      assertEquals(thin.points, 2);

      const capped = await client.execJson<ReadResult>(`track-read ${positionOf('thin')} --limit 4`);
      assertEquals(capped.points <= 4, true);
      assertEquals(capped.truncated, true);
    });

    await t.step('track-mark rejects and accepts fixes by hand, overruling the rules, and --clear hands them back', async () => {
      // Steady going a fix a second, five fixes two degrees north, and back on course.
      const points = Array.from({ length: 25 }, (_, i) => ({
        lat: 57.7 + i * 0.0001 + (i >= 10 && i < 15 ? 2 : 0),
        lng: 11.97 + i * 0.0001,
        ts: new Date(Date.UTC(2020, 6, 1, 10, 0, i)).toISOString(),
      }));
      await cmd.shouldSucceed(`track-append glitch --json '${JSON.stringify(points)}'`);
      assertEquals((await listed('glitch'))?.points, 20);

      const away = await client.execJson<ReadResult>('track-read glitch --only-rejected');
      assertEquals(away.segments.map((segment) => segment.points.length), [5]);
      assertEquals(away.segments[0].points.every((point) => point.rejected === 'excursion'), true);

      const run = `--from ${points[10].ts} --to ${points[15].ts}`;
      assertEquals(await client.execJson(`track-mark glitch ${run} --accept`), { marked: 5 });
      assertEquals((await listed('glitch'))?.points, 25);
      assertEquals((await client.execJson<ReadResult>('track-read glitch --only-rejected')).points, 0);

      // One fix of the steady going, rejected by hand.
      assertEquals(await client.execJson(`track-mark glitch --from ${points[3].ts} --to ${points[4].ts} --reject`), { marked: 1 });
      const rejected = await client.execJson<ReadResult>('track-read glitch --only-rejected');
      assertEquals(rejected.segments[0].points.map((point) => [point.ts, point.rejected, point.manual]), [[points[3].ts, 'manual', 'reject']]);
      assertEquals((await listed('glitch'))?.points, 24);

      assertEquals(await client.execJson('track-mark glitch --clear'), { marked: 6 });
      assertEquals((await listed('glitch'))?.points, 20);

      await cmd.shouldFailWith('track-mark glitch', 'usage');
      await cmd.shouldFailWith('track-mark glitch --reject --accept', 'usage');
      await cmd.shouldFailWith('track-mark glitch --reject --from=yesterday', 'invalid --from');
    });

    await t.step('track-mark --near rejects the fixes around a point, and --marked reject --clear brings back only those', async () => {
      // Steady going a fix a second, about 13 m apart: the first four are within 40 m of the first.
      const points = Array.from({ length: 25 }, (_, i) => ({ lat: 57.7 + i * 0.0001, lng: 11.97 + i * 0.0001, ts: new Date(Date.UTC(2020, 6, 1, 10, 0, i)).toISOString() }));
      await cmd.shouldSucceed(`track-append cluster --json '${JSON.stringify(points)}'`);

      assertEquals(await client.execJson(`track-mark cluster --near=${points[0].lat},${points[0].lng} --reject`), { marked: 4 });
      assertEquals(await client.execJson(`track-mark cluster --near=${points[24].lat},${points[24].lng} --within=10 --reject`), { marked: 1 });
      assertEquals(await client.execJson(`track-mark cluster --from ${points[12].ts} --to ${points[13].ts} --accept`), { marked: 1 });
      assertEquals((await listed('cluster'))?.points, 20);

      assertEquals(await client.execJson('track-mark cluster --marked=reject --clear'), { marked: 5 });
      assertEquals((await listed('cluster'))?.points, 25);
      const kept = await client.execJson<ReadResult>('track-read cluster');
      assertEquals(kept.segments.flatMap((segment) => segment.points).filter((point) => point.manual).map((point) => point.ts), [points[12].ts]);

      await cmd.shouldFailWith('track-mark cluster --near=57.7 --reject', 'invalid --near');
      await cmd.shouldFailWith('track-mark cluster --within=40 --reject', '--within needs --near');
      await cmd.shouldFailWith('track-mark cluster --marked=kept --clear', 'invalid --marked');
    });

    await t.step('track-move moves a time range to another track', async () => {
      const points = Array.from({ length: 20 }, (_, i) => ({ lat: 57.7 + i * 0.0001, lng: 11.97 + i * 0.0001, ts: new Date(Date.UTC(2020, 7, 1, 10, 0, i)).toISOString() }));
      await cmd.shouldSucceed(`track-append wrong --json '${JSON.stringify(points)}'`);
      await cmd.shouldSucceed(`track-mark wrong --from ${points[5].ts} --to ${points[6].ts} --reject`);

      const moved = await client.execJson(`track-move wrong right --from ${points[5].ts} --to ${points[15].ts}`);
      assertEquals(moved, { moved: 10, to: positionOf('right') });
      assertEquals((await listed('wrong'))?.points, 10);
      assertEquals((await listed('right'))?.points, 9);
      const rejected = await client.execJson<ReadResult>('track-read right --only-rejected');
      assertEquals(rejected.segments.flatMap((segment) => segment.points).map((point) => [point.ts, point.manual]), [[points[5].ts, 'reject']]);

      await cmd.shouldFailWith('track-move wrong', 'usage');
      await cmd.shouldFailWith(`track-move wrong ${positionOf('wrong')}`, 'the track the fixes are on');
      await cmd.shouldFailWith('track-move right wrong --to=soon', 'invalid --to');
    });

    await t.step("track-import gives its device a GPX file (both attribute orders) and keeps the file in the track's routes/", async () => {
      await write('/trip.gpx', GPX);

      const result = await client.execJson<{ imported: number; track: string; source: string }>(`track-import hike /trip.gpx`);
      assertEquals(result.imported, 3);
      assertEquals(result.track, positionOf('hike'));

      // The device's name, its path and the track's path all name the same track.
      assertEquals(await client.execJson<ReadResult>(`track-read ${deviceAt('hike')}`), await client.execJson<ReadResult>('track-read hike'));
      const points = flat(await client.execJson<ReadResult>(`track-read ${positionOf('hike')}`));
      assertEquals(points.map((p) => p.lat), [57.7, 57.71, 57.72]);
      assertEquals(points.map((p) => p.lng), [11.97, 11.98, 11.99]);
      assertEquals(points[0].alt, 12.5);
      assertEquals(points[2].ts, '2020-06-01T10:02:00.000Z');

      const hike = await listed('hike');
      assertEquals(hike?.points, 3);
      assertEquals(hike?.bbox, { north: 57.72, south: 57.7, east: 11.99, west: 11.97 });

      // The file stays where it was, and a copy is kept with the track and linked from it.
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, '/trip.gpx'), true);
      assertEquals(result.source, `${positionOf('hike')}/routes/trip.gpx`);
      assertEquals((await client.execJson<SourceFile[]>(`source-list ${positionOf('hike')}`)).map((s) => s.path), [`${positionOf('hike')}/routes/trip.gpx`]);

      // Importing the same file twice does not double the track, nor keep the file twice.
      const again = await client.execJson<{ imported: number; skipped: number }>(`track-import ${positionOf('hike')} /trip.gpx`);
      assertEquals(again.imported, 0);
      assertEquals(again.skipped, 3);
      assertEquals((await ctx.vfs.children(ADMIN_ACCESS, `${positionOf('hike')}/routes`)).map((e) => e.name), ['trip.gpx']);
    });

    await t.step("a track no tracker drives takes a GPX file's fixes as they are", async () => {
      await cmd.shouldSucceed(`device-create plotter && mknode -t track ${deviceAt('plotter')}/route`);
      const result = await client.execJson<{ imported: number; track: string }>('track-import plotter /trip.gpx');
      assertEquals([result.imported, result.track], [3, `${deviceAt('plotter')}/route`]);
      // A device's track other than its position is named after both.
      assertEquals((await client.execJson<TrackEntry[]>(`track-list ${deviceAt('plotter')}`)).map((track) => track.name), ['plotter · route']);
    });

    await t.step('track-import leaves out a point without a time, and refuses a file with only those', async () => {
      await write(
        '/partly-timed.gpx',
        `<gpx><trk><trkseg><trkpt lat="58.1" lon="12.1"><time>2020-07-01T08:00:00Z</time></trkpt><trkpt lat="58.2" lon="12.2"></trkpt></trkseg></trk></gpx>`,
      );
      const result = await client.execJson<{ imported: number; untimed: number }>('track-import untimed /partly-timed.gpx');
      assertEquals(result.imported, 1);
      assertEquals(result.untimed, 1);
      assertEquals(flat(await client.execJson<ReadResult>('track-read untimed')).map((p) => p.ts), ['2020-07-01T08:00:00.000Z']);

      await write('/planned.gpx', `<gpx><trk><trkseg><trkpt lat="58.1" lon="12.1"/><trkpt lat="58.2" lon="12.2"/></trkseg></trk></gpx>`);
      await cmd.shouldFailWith('track-import untimed /planned.gpx', 'none of its 2 track points has a time');
      await cmd.shouldFailWith('track-stage /planned.gpx --track untimed', 'none of its 2 track points has a time');
    });

    await t.step('camera-device links a camera to the device it is part of, whose track then stands for it', async () => {
      const phone = `${CAMERAS_ROOT}/hiking-phone`;
      await cmd.shouldSucceed(`mknode -p -t camera ${phone} --as name='Hiking phone'`);
      await cmd.shouldFailWith('track-read hiking-phone', `${phone} has no track`);

      assertEquals(await client.execJson('camera-device hiking-phone hike'), { ok: true });
      assertEquals((await client.execJson<{ softlink: string }>(`props -L ${phone}/device`)).softlink, deviceAt('hike'));
      assertEquals(await client.execJson<ReadResult>('track-read hiking-phone'), await client.execJson<ReadResult>('track-read hike'));
      // The track is still named after its device, not the camera linked to it.
      assertEquals((await listed('hike'))?.name, 'hike');

      // Linked again elsewhere, by a track of the device, the link moves; --off takes it away.
      await cmd.shouldSucceed(`camera-device ${phone} ${positionOf('trip1')}`);
      assertEquals((await client.execJson<{ softlink: string }>(`props -L ${phone}/device`)).softlink, deviceAt('trip1'));
      await cmd.shouldSucceed('camera-device hiking-phone --off');
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, `${phone}/device`, { follow: false }), false);

      await cmd.shouldFailWith(`camera-device ${deviceAt('hike')} hike`, 'not a camera');
      await cmd.shouldFailWith(`camera-device hiking-phone ${CAMERAS_ROOT}`, 'not a device');
      await cmd.shouldFailWith('camera-device hiking-phone missing', 'no such device');
      await cmd.shouldFailWith('camera-device hiking-phone', 'usage');
      await cmd.shouldFailWith('camera-device hiking-phone hike --off', 'usage');
    });

    await t.step('rejects invalid input', async () => {
      await cmd.shouldSucceed('mkfile /not-track');
      await cmd.shouldFailWith('track-append /not-track 1 2', '/not-track has no track');
      await cmd.shouldSucceed('device-create trackless');
      await cmd.shouldFailWith('track-read trackless', `${deviceAt('trackless')} has no track`);
      // A device with two tracks, neither its position, says which to name; one with a position stands for that.
      await cmd.shouldSucceed(`mknode -t track ${deviceAt('trackless')}/east && mknode -t track ${deviceAt('trackless')}/west`);
      await cmd.shouldFailWith('track-read trackless', 'has 2 tracks: name one');
      await cmd.shouldSucceed(`track-read ${deviceAt('trackless')}/east`);
      await cmd.shouldSucceed(`mknode -t track ${deviceAt('trip1')}/route`);
      assertEquals((await client.execJson<ReadResult>('track-read trip1')).points, (await client.execJson<ReadResult>(`track-read ${positionOf('trip1')}`)).points);
      await cmd.shouldFailWith(`track-append ${positionOf('trip1')} abc 11`, 'numeric lat and lng');
      await cmd.shouldFailWith(`track-read ${positionOf('thin')} --bbox=1,2,3`, 'invalid --bbox');
      await cmd.shouldFailWith(`track-read ${positionOf('thin')} --tolerance x`, 'invalid --tolerance');
      await cmd.shouldFailWith('track-read missing', 'no device or camera of that name');
      const res = await client.exec('track-read missing');
      assertEquals(res.success, false);
      assertStringIncludes(res.error ?? '', 'track-read');
    });

    await t.step("track-stage gives a GPX file to the device it names, and moves the file to its track's routes/", async () => {
      // A logger whose make and model the file's creator names, a camera linked to the tracker.
      await tracker('logger');
      await cmd.shouldSucceed(`mknode -p -t camera ${CAMERAS_ROOT}/trail-logger --as name='Trail logger' --as make=Exempel --as model=Trail`);
      await cmd.shouldSucceed('camera-device trail-logger logger');
      await cmd.shouldSucceed('staging init --user admin && mkdir -p /home/admin/staging/files/inbox/upload-2026-10-16');

      await write('/home/admin/staging/files/inbox/upload-2026-10-16/walk.gpx', GPX.replace('creator="test"', 'creator="Exempel Trail"'));
      const staged = await client.execJson<TrackStageResult>('track-stage /home/admin/staging/files/inbox/upload-2026-10-16/walk.gpx');
      const kept = `${positionOf('logger')}/routes/walk.gpx`;
      assertEquals(staged, { status: 'imported', track: positionOf('logger'), imported: 3, skipped: 0, untimed: 0, source: kept });
      await cmd.shouldFail('info /home/admin/staging/files/inbox/upload-2026-10-16/walk.gpx');
      assertEquals((await client.execJson<SourceFile[]>(`source-list ${positionOf('logger')}`)).map((s) => [s.name, s.path]), [['walk.gpx', kept]]);

      // Staged again, nothing is added: a fix is keyed by its time, and the same bytes are kept once.
      await write('/home/admin/staging/files/inbox/upload-2026-10-16/again.gpx', GPX.replace('creator="test"', 'creator="Exempel Trail"'));
      const again = await client.execJson<TrackStageResult>('track-stage /home/admin/staging/files/inbox/upload-2026-10-16/again.gpx');
      assertEquals(again.status === 'imported' && [again.imported, again.source], [0, kept]);
      await cmd.shouldFail('info /home/admin/staging/files/inbox/upload-2026-10-16/again.gpx');
    });

    await t.step("track-stage matches a device's own manufacturer and model", async () => {
      await cmd.shouldSucceed("device-create 'Old etrex' --driver tracker --manufacturer Exempel --model 'Hiker 30'");
      await write(
        '/home/admin/staging/files/inbox/upload-2026-10-16/hiker.gpx',
        GPX.replace('creator="test"', 'creator="Exempel Hiker 30"').replaceAll('2020-06-01', '2020-08-01'),
      );
      const staged = await client.execJson<TrackStageResult>('track-stage /home/admin/staging/files/inbox/upload-2026-10-16/hiker.gpx');
      assertEquals(staged.status === 'imported' && [staged.track, staged.imported], [positionOf('old-etrex'), 3]);
    });

    await t.step('track-stage leaves a GPX naming no known device waiting in routes/, until told which', async () => {
      const staged = '/home/admin/staging/files/inbox/upload-2026-10-16/odd.gpx';
      await write(staged, GPX.replace('creator="test"', 'creator="Unknown Thing"').replaceAll('2020-06-01', '2020-07-01'));

      const pending = await client.execJson<TrackStageResult>(`track-stage ${staged}`);
      const waiting = '/home/admin/staging/routes/odd.gpx';
      assertEquals(pending.status === 'pending' && pending.path, waiting);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, staged), false);
      assertEquals((await client.execJson<{ trackPending: boolean }>(`attrs ${waiting}`)).trackPending, true);
      assertEquals((await client.execJson<StagingStatus>('staging status')).routesWaiting, 1);

      // Told which track, and under which name to keep it (as the track page's upload says).
      const told = await client.execJson<TrackStageResult>(`track-stage ${waiting} --track logger --name 'July walk.gpx'`);
      assertEquals(told.status === 'imported' && [told.imported, told.source], [3, `${positionOf('logger')}/routes/July walk.gpx`]);
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, waiting), false);
      assertEquals((await ctx.vfs.get(ADMIN_ACCESS, `${positionOf('logger')}/routes/July walk.gpx`)).attrs.trackPending, undefined);
      assertEquals((await client.execJson<SourceFile[]>(`source-list ${positionOf('logger')}`)).map((s) => s.name), ['July walk.gpx', 'walk.gpx']);
    });

    await t.step('gpx-info says what GPX files hold and which tracks they name, without importing them', async () => {
      await write('/named.gpx', GPX.replace('creator="test"', 'creator="Exempel Trail"').replace('<trk>', '<metadata><name>Morning walk</name></metadata><trk>'));
      const size = (await ctx.vfs.get(ADMIN_ACCESS, '/named.gpx')).attrs.size;

      const [named, plain] = await client.execJson<GpxInfo[]>('gpx-info /named.gpx /trip.gpx');
      assertEquals(named, {
        path: '/named.gpx',
        size: size as number,
        name: 'Morning walk',
        creator: 'Exempel Trail',
        tracks: ['Test'],
        points: 3,
        timed: 3,
        start: '2020-06-01T10:00:00.000Z',
        end: '2020-06-01T10:02:00.000Z',
        matches: [{ path: positionOf('logger'), name: 'logger' }],
      });
      assertEquals(plain.path === '/trip.gpx' && !('error' in plain) && [plain.creator, plain.matches], ['test', []]);
      // Nothing was imported: the file stays, the track as it was.
      assertEquals(await ctx.vfs.exists(ADMIN_ACCESS, '/named.gpx'), true);

      // A file that cannot be read is answered with why, beside the others, and the command fails.
      const res = await client.exec('gpx-info /trip.gpx /missing.gpx');
      assertEquals(res.success, false);
      await cmd.shouldSucceed('gpx-info /trip.gpx');
    });

    await t.step("track-list lists every device's track under /dev, or the tracks under a path given", async () => {
      const tracks = await client.execJson<TrackEntry[]>('track-list');
      assertEquals(tracks.map((track) => track.path).filter((path) => path.endsWith('/position')).map((path) => path.split('/')[2]).sort(), [
        'backfill',
        'cluster',
        'ferry',
        'glitch',
        'hike',
        'live',
        'logger',
        'moored',
        'old-etrex',
        'paused',
        'pocket',
        'right',
        'south',
        'thin',
        'trip1',
        'untimed',
        'wrong',
      ]);
      const hike = tracks.find((track) => track.path === positionOf('hike'))!;
      assertEquals([hike.name, hike.points], ['hike', 3]);
      assertEquals((await client.execJson<TrackEntry[]>(`track-list ${deviceAt('hike')}`)).map((track) => track.path), [positionOf('hike')]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
