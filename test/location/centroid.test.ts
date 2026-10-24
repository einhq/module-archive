/**
 * The media-centroid rule: when the points linked to a location describe it well
 * enough to become its coordinates, and when they do not.
 *
 * The cases that matter are the dishonest ones — a mislinked holiday photo, a
 * single fix standing in for a whole park — because those are what a mean would
 * accept without complaint.
 */

import { assert, assertAlmostEquals, assertEquals } from '@std/assert';
import { centroidOf, MIN_RADIUS_M, OUTLIER_FLOOR_M } from '@archive/location/centroid';
import type { CentroidResult, Point } from '@archive/location/centroid';
import { haversineMeters } from '@archive/location/geocode';

/** Liseberg, Göteborg — a park-sized cluster. */
const LISEBERG: Point[] = [
  { lat: 57.6952, lng: 11.9915 },
  { lat: 57.6961, lng: 11.9948 },
  { lat: 57.6944, lng: 11.9932 },
  { lat: 57.6958, lng: 11.9901 },
  { lat: 57.6949, lng: 11.9960 },
];

/** Narrows away the `empty` case so a test can read the numbers. */
const placed = (result: ReturnType<typeof centroidOf>): CentroidResult => {
  assert(result.status !== 'empty', `expected a placed result, got empty: ${result.reason}`);
  return result;
};

Deno.test('a tight cluster becomes a good centroid sized by its own spread', () => {
  const result = placed(centroidOf(LISEBERG));

  assertEquals(result.status, 'good');
  assertEquals(result.used, 5);
  assertEquals(result.dropped, 0);
  assertAlmostEquals(result.lat, 57.6953, 0.001);
  assertAlmostEquals(result.lng, 11.9931, 0.001);
  // A ~200m park, not a pin and not a city.
  assert(result.radius > MIN_RADIUS_M && result.radius < 500, `radius ${result.radius} out of park range`);
});

Deno.test('a single far outlier is dropped instead of dragging the centre', () => {
  const withOutlier = [...LISEBERG, { lat: 41.9028, lng: 12.4964 }]; // Rome
  const result = placed(centroidOf(withOutlier));

  assertEquals(result.status, 'good');
  assertEquals(result.used, 5);
  assertEquals(result.dropped, 1);

  // The centre is unmoved: a mean would have pulled it ~260 km south.
  const clean = placed(centroidOf(LISEBERG));
  assert(
    haversineMeters(result.lat, result.lng, clean.lat, clean.lng) < 1,
    'outlier moved the centre',
  );
});

Deno.test('outliers cannot outvote the cluster even in numbers', () => {
  // Four points on one building, three scattered elsewhere in Europe.
  const points: Point[] = [
    { lat: 57.7000, lng: 11.9700 },
    { lat: 57.7001, lng: 11.9701 },
    { lat: 57.7000, lng: 11.9702 },
    { lat: 57.7002, lng: 11.9700 },
    { lat: 48.8566, lng: 2.3522 },
    { lat: 52.3676, lng: 4.9041 },
    { lat: 59.9139, lng: 10.7522 },
  ];
  const result = placed(centroidOf(points));

  assertEquals(result.used, 4);
  assertEquals(result.dropped, 3);
  assertAlmostEquals(result.lat, 57.7001, 0.001);
});

Deno.test('a building-tight cluster keeps its street, and gets the floor radius', () => {
  // GPS jitter on one house: a few meters apart. Without OUTLIER_FLOOR_M the
  // 3x-median cut-off would start discarding the far side of the same building.
  const points: Point[] = [
    { lat: 57.66120, lng: 11.90890 },
    { lat: 57.66123, lng: 11.90894 },
    { lat: 57.66118, lng: 11.90886 },
    { lat: 57.66131, lng: 11.90901 },
  ];
  const result = placed(centroidOf(points));

  assertEquals(result.used, 4);
  assertEquals(result.dropped, 0);
  assertEquals(result.radius, MIN_RADIUS_M);
  assert(result.spread < OUTLIER_FLOOR_M);
});

Deno.test('too few points is poor, not good — it falls through to geocoding', () => {
  const one = placed(centroidOf([{ lat: 57.7, lng: 11.97 }]));
  assertEquals(one.status, 'poor');
  assertEquals(one.used, 1);
  assert(one.reason.includes('needs 2'));

  // ...unless the caller says one point is enough.
  assertEquals(placed(centroidOf([{ lat: 57.7, lng: 11.97 }], { minPoints: 1 })).status, 'good');
});

Deno.test('a cluster wider than maxSpread is poor', () => {
  // Two clusters ~110 km apart, evenly weighted: neither is "the" location, and
  // there is no minority to trim, so the answer is a centre in between.
  const points: Point[] = [
    { lat: 57.7000, lng: 11.9700 },
    { lat: 57.7100, lng: 11.9800 },
    { lat: 58.7000, lng: 11.9700 },
    { lat: 58.7100, lng: 11.9800 },
  ];
  const result = placed(centroidOf(points, { maxSpread: 25000 }));

  assertEquals(result.status, 'poor');
  assert(result.reason.includes('wider than'));

  // The same points are acceptable when the caller allows a region-sized location.
  assertEquals(placed(centroidOf(points, { maxSpread: 100000 })).status, 'good');
});

Deno.test('no usable points reports empty rather than a position', () => {
  assertEquals(centroidOf([]).status, 'empty');

  const garbage = centroidOf([
    { lat: NaN, lng: 11.97 },
    { lat: 57.7, lng: Infinity },
    { lat: 91, lng: 0 },
    { lat: 0, lng: 181 },
  ]);
  assertEquals(garbage.status, 'empty');
  assertEquals(garbage.dropped, 4);
});

Deno.test('points straddling the antimeridian stay there', () => {
  // Taveuni, Fiji — the 180th meridian runs through it. Averaging raw
  // longitudes would answer 0, in the middle of the Atlantic off Africa.
  const points: Point[] = [
    { lat: -16.8, lng: 179.98 },
    { lat: -16.81, lng: -179.99 },
    { lat: -16.79, lng: 179.99 },
    { lat: -16.8, lng: -179.98 },
  ];
  const result = placed(centroidOf(points));

  assertEquals(result.status, 'good');
  assert(Math.abs(result.lng) > 179.9, `lng ${result.lng} wrapped through zero`);
  assertAlmostEquals(result.lat, -16.8, 0.01);
});

Deno.test('an explicit radius overrides the derived one', () => {
  assertEquals(placed(centroidOf(LISEBERG, { radius: 1234 })).radius, 1234);
});
