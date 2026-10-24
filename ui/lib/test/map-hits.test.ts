/**
 * classifyHits: turning `find-within` rows into map markers. A marker's album is a full VFS
 * path, since the album route hands its `:id` straight to `ls`.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { classifyHits, positionedMediaHit } from '../map-hits.ts';

Deno.test('classifyHits carries the album as an absolute path', () => {
  const { media } = classifyHits([
    { id: '1', lat: 57.7, lng: 11.9, paths: [`${ALBUMS_ROOT}/Sommaren-2003/files/p.jpg/position`] },
  ]);

  assertEquals(media.length, 1);
  assertEquals(media[0].filePath, `${ALBUMS_ROOT}/Sommaren-2003/files/p.jpg`);
  assertEquals(media[0].albumPath, `${ALBUMS_ROOT}/Sommaren-2003`);
});

Deno.test(`a file outside ${ALBUMS_ROOT} has no album, but is still a marker`, () => {
  const { media } = classifyHits([
    { id: '2', lat: 0, lng: 0, paths: ['/incoming/p.jpg/position'] },
  ]);

  assertEquals(media.length, 1);
  assertEquals(media[0].albumPath, undefined);
});

Deno.test(`a ${LOCATIONS_ROOT} row is a location, not media`, () => {
  const { media, locations } = classifyHits([
    { id: '3', lat: 1, lng: 2, paths: [`${LOCATIONS_ROOT}/harbour`] },
  ]);

  assertEquals(media, []);
  assertEquals(locations.map((p) => p.locationId), ['harbour']);
});

/**
 * A clustered answer reports a lone picture's content under the cell that holds
 * it, and only the cell carries coordinates: the marker sits at the cell's.
 */
Deno.test('a cluster hit takes its position from the cell', () => {
  const hit = positionedMediaHit({ id: '3', paths: [`${ALBUMS_ROOT}/Vintern/files/p.jpg/position`] }, 57.7, 11.9);

  assertEquals(hit?.lat, 57.7);
  assertEquals(hit?.lng, 11.9);
  assertEquals(hit?.filePath, `${ALBUMS_ROOT}/Vintern/files/p.jpg`);
});

Deno.test('a cluster hit that is not media is no marker at all', () => {
  assertEquals(positionedMediaHit({ id: '4', paths: [`${LOCATIONS_ROOT}/Exempelbaren`] }, 57.7, 11.9), undefined);
});
