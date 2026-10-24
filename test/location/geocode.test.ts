/**
 * The forward-geocoding decision rule: when a Nominatim answer is certain
 * enough to place a node automatically, and when it goes to a human instead.
 *
 * Payloads are trimmed captures of real /search responses for the kind of
 * addresses the legacy import produced.
 */

import { assertEquals } from '@std/assert';
import {
  decideGeocode,
  expandAbbreviations,
  houseNumberOf,
  NOMINATIM_MIN_INTERVAL_MS,
  NOMINATIM_REVERSE_URL,
  NOMINATIM_SEARCH_URL,
  nominatimFetch,
  normalizeQuery,
  postcodeOf,
  precisionOf,
  retryAfterMs,
  streetLineOf,
  throttleNominatim,
} from '@archive/location/geocode';
import type { NominatimResult } from '@archive/location/geocode';

const house = (over: Partial<NominatimResult> = {}): NominatimResult => ({
  lat: '57.6612',
  lon: '11.9089',
  display_name: 'Exempelgatan 27, Söderby, Göteborg, 999 77, Sverige',
  category: 'building',
  type: 'yes',
  addresstype: 'building',
  importance: 0.32,
  address: { house_number: '27', road: 'Exempelgatan', city: 'Göteborg', postcode: '999 77', country: 'Sverige' },
  ...over,
});

Deno.test('normalizeQuery flattens the multi-line legacy address', () => {
  assertEquals(normalizeQuery('Exempelgatan 27\n999 77 Söderby'), 'Exempelgatan 27, 999 77 Söderby');
  assertEquals(normalizeQuery('  Storgatan  1 ,  Stockholm '), 'Storgatan 1, Stockholm');
});

Deno.test('postcodeOf and houseNumberOf read the corroborating parts', () => {
  assertEquals(postcodeOf('Exempelgatan 27, 999 77 Söderby'), '99977');
  assertEquals(postcodeOf('Exempelgatan 27, 99977 Söderby'), '99977');
  assertEquals(postcodeOf('Sommarstugan'), undefined);

  assertEquals(houseNumberOf('Exempelgatan 27, 999 77 Söderby'), '27');
  assertEquals(houseNumberOf('Storgatan 1A, Stockholm'), '1A');
  // Digits after the comma belong to the postcode, not the street.
  assertEquals(houseNumberOf('Sommarvägen, 123 45 Ort'), undefined);
});

Deno.test('precisionOf separates buildings from roads and areas', () => {
  assertEquals(precisionOf(house()), 'house');
  assertEquals(precisionOf({ addresstype: 'road', category: 'highway', address: {} }), 'road');
  assertEquals(precisionOf({ addresstype: 'city', category: 'place', address: {} }), 'area');
  // A road hit that happens to carry a house number is still a building.
  assertEquals(precisionOf({ addresstype: 'road', address: { house_number: '3' } }), 'house');
});

Deno.test('decideGeocode applies a building hit corroborated by the house number', () => {
  const decision = decideGeocode('Exempelgatan 27, 999 77 Söderby', [house()]);
  assertEquals(decision.status, 'applied');
  if (decision.status !== 'applied') return;
  assertEquals(decision.lat, 57.6612);
  assertEquals(decision.precision, 'house');
  assertEquals(decision.address.city, 'Göteborg');
  assertEquals(decision.address.houseNumber, '27');
});

Deno.test('decideGeocode applies when only the postcode corroborates', () => {
  const decision = decideGeocode(
    'Exempelgatan, 999 77 Söderby',
    [house({ address: { house_number: '27', postcode: '999 77', country: 'Sverige' } })],
  );
  assertEquals(decision.status, 'applied');
});

Deno.test('decideGeocode sends a mere city or street hit to review', () => {
  const city = decideGeocode('Söderby', [{
    lat: '57.65',
    lon: '11.91',
    display_name: 'Söderby, Göteborg, Sverige',
    category: 'place',
    addresstype: 'suburb',
    importance: 0.5,
    address: { city: 'Göteborg', country: 'Sverige' },
  }]);
  assertEquals(city.status, 'review');
  assertEquals(city.candidates.length, 1);
  assertEquals(city.candidates[0].lat, 57.65);
});

Deno.test('decideGeocode refuses a building whose number disagrees', () => {
  const decision = decideGeocode(
    'Exempelgatan 27, 999 77 Söderby',
    [house({ address: { house_number: '9', road: 'Exempelgatan', postcode: '411 22' } })],
  );
  assertEquals(decision.status, 'review');
  assertEquals(decision.reason, 'house number and postcode both disagree');
});

Deno.test('decideGeocode refuses an address with nothing to corroborate', () => {
  const decision = decideGeocode('Sommarstugan', [house({ address: { house_number: '4' } })]);
  assertEquals(decision.status, 'review');
});

Deno.test('decideGeocode refuses a comparably-ranked hit somewhere else', () => {
  const elsewhere = house({
    lat: '59.3293',
    lon: '18.0686',
    importance: 0.32,
    display_name: 'Exempelgatan 27, Stockholm',
    address: { house_number: '27', postcode: '999 77' },
  });
  const decision = decideGeocode('Exempelgatan 27, 999 77 Söderby', [house(), elsewhere]);
  assertEquals(decision.status, 'review');
  assertEquals(decision.candidates.length, 2);
});

Deno.test('decideGeocode tolerates a runner-up on the same building', () => {
  const nextDoor = house({ lat: '57.66125', lon: '11.90895', importance: 0.31, display_name: 'Same building, other entrance' });
  const decision = decideGeocode('Exempelgatan 27, 999 77 Söderby', [house(), nextDoor]);
  assertEquals(decision.status, 'applied');
});

Deno.test('decideGeocode reports no results', () => {
  const decision = decideGeocode('Nowhere at all', []);
  assertEquals(decision.status, 'none');
  assertEquals(decision.candidates.length, 0);
});

Deno.test('streetLineOf keeps the street and drops what Nominatim cannot match', () => {
  // The district is the reason these find nothing: OSM files Provgatan under
  // Norrhamn, not under the postal name Söderby.
  assertEquals(streetLineOf('Provgatan 18, 999 39 Söderby'), 'Provgatan 18');
  // Apartment numbers and legacy internal codes go the same way.
  assertEquals(streetLineOf('Provtorget 4, 999 83 Göteborg, Lägenhet 27'), 'Provtorget 4');
  assertEquals(streetLineOf('Stjärngatan 62 : 577, 999 22 Göteborg'), 'Stjärngatan 62 : 577');
  // Nothing to drop.
  assertEquals(streetLineOf('Amsterdam'), 'Amsterdam');
});

Deno.test('a relaxed lookup is confirmed by the postcode, not the house number', () => {
  const written = 'Provgatan 18, 999 39 Söderby';
  const hit = house({
    lat: '57.6606',
    lon: '11.9317',
    display_name: '18, Provgatan, Norrhamn, Göteborg, 999 39, Sverige',
    address: { house_number: '18', road: 'Provgatan', city: 'Göteborg', postcode: '999 39' },
  });

  // Street-only search, and the postcode from the written address agrees.
  const confirmed = decideGeocode(written, [hit], { requirePostcode: true });
  assertEquals(confirmed.status, 'applied');
  assertEquals(confirmed.reason, 'postcode matches');

  // The same house number in the wrong town is not evidence: every street has
  // a number 18, so without the postcode this goes to a human.
  const wrongTown = house({
    lat: '59.3293',
    lon: '18.0686',
    display_name: '18, Provgatan, Stockholm, 121 45, Sverige',
    address: { house_number: '18', road: 'Provgatan', city: 'Stockholm', postcode: '121 45' },
  });
  const unconfirmed = decideGeocode(written, [wrongTown], { requirePostcode: true });
  assertEquals(unconfirmed.status, 'review');
  assertEquals(unconfirmed.reason, 'street-only lookup and the postcode disagrees');

  // Unrelaxed, that same hit would have been applied on the house number alone.
  assertEquals(decideGeocode(written, [wrongTown]).status, 'applied');
});

Deno.test('expandAbbreviations spells out what OSM spells out', () => {
  // Nominatim finds nothing for the abbreviated form and a house for the full
  // one, so this is the difference between no result and a confirmed address.
  assertEquals(expandAbbreviations('Dr Exempelsons gata 2'), 'Doktor Exempelsons gata 2');
  assertEquals(expandAbbreviations('Dr. Provgatan 6 C'), 'Doktor Provgatan 6 C');
  assertEquals(expandAbbreviations('Prof Exempelsons väg 1'), 'Professor Exempelsons väg 1');

  // A word that merely starts with the abbreviation is left alone.
  assertEquals(expandAbbreviations('Drottninggatan 5'), 'Drottninggatan 5');
  assertEquals(expandAbbreviations('400 Example Drive'), '400 Example Drive');

  // Nothing to expand, nothing changed — which is what stops the extra request.
  assertEquals(expandAbbreviations('Exempelgatan 27'), 'Exempelgatan 27');
});

Deno.test('throttleNominatim paces the public host, whichever endpoint is called', async () => {
  // Both endpoints share ONE counter. Alternating between them is exactly
  // the shape of a crawl that geocodes files while a search resolves a location
  // name, and two counters would let that run at two requests per second.
  const started = Date.now();
  await throttleNominatim(new URL(NOMINATIM_SEARCH_URL));
  await throttleNominatim(new URL(NOMINATIM_REVERSE_URL));
  await throttleNominatim(new URL(NOMINATIM_SEARCH_URL));
  const elapsed = Date.now() - started;

  // Three requests are two intervals. The first is free: it only records.
  assertEquals(elapsed >= 2 * NOMINATIM_MIN_INTERVAL_MS, true, `three paced calls took ${elapsed}ms`);
});

Deno.test('throttleNominatim leaves a stub instance alone', async () => {
  // A loopback stub has no usage policy, and a test suite that slept a second
  // per request would pay the whole cost of the limit for none of the benefit.
  const started = Date.now();
  for (let i = 0; i < 5; i++) await throttleNominatim(new URL('http://127.0.0.1:8080/reverse'));
  assertEquals(Date.now() - started < NOMINATIM_MIN_INTERVAL_MS, true);
});

Deno.test('throttleNominatim spaces concurrent callers instead of releasing them together', async () => {
  // Callers arriving while one is already sleeping do not wake as a burst: a slot
  // is reserved when a caller asks, so N concurrent callers leave N-1 intervals
  // apart no matter when they arrived.
  const url = new URL(NOMINATIM_REVERSE_URL);
  await throttleNominatim(url); // take the free first slot so the rest queue
  const started = Date.now();
  const released = await Promise.all([1, 2, 3].map(async () => {
    await throttleNominatim(url);
    return Date.now() - started;
  }));
  released.sort((a, b) => a - b);
  for (let i = 1; i < released.length; i++) {
    const gap = released[i] - released[i - 1];
    assertEquals(gap >= NOMINATIM_MIN_INTERVAL_MS - 20, true, `callers released ${gap}ms apart: ${released.join(', ')}`);
  }
});

Deno.test('retryAfterMs reads seconds and dates, caps, and falls back', () => {
  assertEquals(retryAfterMs('2'), 2000);
  assertEquals(retryAfterMs('0'), 5000);
  assertEquals(retryAfterMs(null), 5000);
  assertEquals(retryAfterMs('soon'), 5000);
  assertEquals(retryAfterMs('3600'), 60_000);
  const inThree = new Date(Date.now() + 3000).toUTCString();
  const ms = retryAfterMs(inThree);
  assertEquals(ms > 1000 && ms <= 3000, true, `date header gave ${ms}ms`);
});

Deno.test('nominatimFetch retries a 429 and gives up with the status in the message', async () => {
  // A loopback stub, so neither the pacing nor the public backoff applies and
  // only the retry logic is under test: two refusals then an answer.
  let calls = 0;
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, () => {
    calls++;
    if (calls < 3) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    return Response.json([{ lat: '1', lon: '2' }]);
  });
  try {
    const url = new URL(`http://127.0.0.1:${server.addr.port}/reverse`);
    const response = await nominatimFetch(url);
    assertEquals(await response.json(), [{ lat: '1', lon: '2' }]);
    assertEquals(calls, 3);

    calls = -10; // never recovers inside the attempts
    let message = '';
    try {
      await nominatimFetch(url, {}, 2);
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message, 'nominatim returned 429');
    assertEquals(calls, -8);
  } finally {
    await server.shutdown();
  }
});
