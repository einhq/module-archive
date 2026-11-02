/**
 * How the place a device stayed at is named from what Overpass and Nominatim answer: by rank, then
 * by distance, never by a generic word or a feature too far away. The places are invented.
 */

import { assertEquals } from '@std/assert';
import { isGenericName, OVERPASS_URLS, type OverpassElement, overpassEndpoints, pickPlace, townOf } from '@archive/location/place-name';

const M2DEG = 1 / 111_320;
const LAT = 59;
const LNG = 18;

/** A node `northM` metres north of the stay. */
const node = (northM: number, tags: Record<string, string>): OverpassElement => ({ lat: LAT + northM * M2DEG, lon: LNG, tags });
/** A way or relation, whose position is its centre. */
const area = (northM: number, tags: Record<string, string>): OverpassElement => ({ center: { lat: LAT + northM * M2DEG, lon: LNG }, tags });

Deno.test('a marina outranks a nearer island, and an island a nearer bay', () => {
  const place = pickPlace(LAT, LNG, [
    node(50, { natural: 'bay', name: 'Exempelviken' }),
    area(100, { place: 'island', name: 'Exempelön' }),
    area(400, { leisure: 'marina', name: 'Exempelhamnen' }),
  ]);
  assertEquals(place, { name: 'Exempelhamnen', kind: 'marina', source: 'overpass' });
  assertEquals(pickPlace(LAT, LNG, [node(50, { natural: 'bay', name: 'Exempelviken' }), area(300, { place: 'islet', name: 'Lillskär' })])?.kind, 'island');
});

Deno.test('a boatyard ranks below a marina and above an island', () => {
  const yard = node(20, { leisure: 'marina', name: 'Exempelvarv' });
  assertEquals(pickPlace(LAT, LNG, [yard, node(300, { 'seamark:type': 'harbour', name: 'Nordhamn' })]), { name: 'Nordhamn', kind: 'harbour', source: 'overpass' });
  assertEquals(pickPlace(LAT, LNG, [yard, area(10, { place: 'island', name: 'Exempelön' })])?.name, 'Exempelvarv');
  assertEquals(pickPlace(LAT, LNG, [yard])?.kind, 'boatyard');
});

Deno.test('within a rank the nearest wins', () => {
  const place = pickPlace(LAT, LNG, [area(300, { place: 'island', name: 'Ytterön' }), area(-120, { place: 'island', name: 'Innerön' })]);
  assertEquals(place?.name, 'Innerön');
});

Deno.test('a generic name, an unranked feature or one beyond 500 m names nothing', () => {
  assertEquals(pickPlace(LAT, LNG, [node(10, { leisure: 'marina', name: 'Gästhamn' })]), undefined);
  assertEquals(pickPlace(LAT, LNG, [node(10, { leisure: 'park', name: 'Exempelparken' })]), undefined);
  assertEquals(pickPlace(LAT, LNG, [area(800, { place: 'island', name: 'Fjärran' })]), undefined);
  assertEquals(pickPlace(LAT, LNG, [{ tags: { place: 'island', name: 'Utan läge' } }]), undefined);
  assertEquals(isGenericName(' Småbåtshamnen '), true);
  assertEquals(isGenericName('Exempelhamnen'), false);
});

Deno.test("the town is Nominatim's city, town or village, else the first part of its name", () => {
  assertEquals(townOf({ address: { village: 'Exempelby', county: 'Exempellän' } }), 'Exempelby');
  assertEquals(townOf({ address: {}, display_name: 'Exempelfjärden, Exempellän' }), 'Exempelfjärden');
  assertEquals(townOf({}), undefined);
});

Deno.test('the Overpass endpoints are the listed ones, else the public ones', () => {
  assertEquals(overpassEndpoints('http://a/api http://b/api'), ['http://a/api', 'http://b/api']);
  assertEquals(overpassEndpoints('http://a/api,http://b/api'), ['http://a/api', 'http://b/api']);
  assertEquals(overpassEndpoints(''), OVERPASS_URLS);
  assertEquals(overpassEndpoints(undefined), OVERPASS_URLS);
});
