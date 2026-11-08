/**
 * The location rules: which VFS mutations are location and point facts,
 * and — as much the point — which are not.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { deriveLocationEvents, LOCATION_EVENTS, type LocationRuleContext, type VfsEventInput } from '../../lib/location/event-rules.ts';

const LOCATION = `${LOCATIONS_ROOT}/Exempelparken`;
const POINT = `${ALBUMS_ROOT}/trip/files/a.jpg/position`;
const SHAPE = `${LOCATION}/position`;
const LINK = `${ALBUMS_ROOT}/trip/files/a.jpg/location`;

const ctx = (
  opts: { points?: string[]; links?: Record<string, { target: string; attrs?: Record<string, unknown> }>; types?: Record<string, string> } = {},
): LocationRuleContext => ({
  hasPoint: (path) => Promise.resolve(opts.points?.includes(path) ?? false),
  getLink: (path) => {
    const link = opts.links?.[path];
    return Promise.resolve(link ? { id: 'l1', target: link.target, attrs: link.attrs ?? {} } : undefined);
  },
  getNode: (path) => Promise.resolve(opts.types?.[path] ? { type: opts.types[path] } : undefined),
});

const event = (nodeType: string, path: string, type: string, changedAttrs?: string[]): VfsEventInput => ({
  type,
  path,
  nodeId: 'n1',
  nodeType,
  timestamp: 1,
  ...(changedAttrs ? { changedAttrs } : {}),
});

const types = async (input: VfsEventInput, context = ctx()) => (await deriveLocationEvents(input, context, 1)).map((fact) => `${fact.type} ${fact.subject}`);

Deno.test('rule: a new location is announced', async () => {
  assertEquals(await types(event('location', LOCATION, 'created')), [`${LOCATION_EVENTS.locationChanged} ${LOCATION}`]);
});

Deno.test('rule: a location whose shape was written is announced', async () => {
  assertEquals(await types(event('position', SHAPE, 'updated', [])), [`${LOCATION_EVENTS.locationChanged} ${LOCATION}`]);
  // Its shape node appearing, empty, is not news: the location's own creation was.
  assertEquals(await types(event('position', SHAPE, 'created'), ctx({ points: [SHAPE] })), []);
});

Deno.test('rule: an edited address or a pin by hand is announced', async () => {
  assertEquals((await types(event('location', LOCATION, 'updated', ['address']))).length, 1);
  assertEquals((await types(event('location', LOCATION, 'updated', ['locationSource', 'geocodeStatus']))).length, 1);
});

Deno.test('rule: bookkeeping on a location is not', async () => {
  // What location-locate and geocode-location write about themselves.
  assertEquals(await types(event('location', LOCATION, 'updated', ['geocodeAttemptedAt', 'geocodeStatus', 'geocodeCandidates'])), []);
  // An update without changedAttrs: no way to tell, so nothing.
  assertEquals(await types(event('location', LOCATION, 'updated')), []);
});

Deno.test('rule: a location outside the locations root, or a position not named position, is ignored', async () => {
  assertEquals(await types(event('location', `${LOCATIONS_ROOT}/Exempelparken/extra`, 'created')), []);
  assertEquals(await types(event('position', '/elsewhere/spot', 'updated', [])), []);
});

Deno.test('rule: a photo point is announced when it is written, not when its empty node appears', async () => {
  assertEquals(await types(event('position', POINT, 'created')), []);
  assertEquals(await types(event('position', POINT, 'created'), ctx({ points: [POINT] })), [`${LOCATION_EVENTS.pointChanged} ${POINT}`]);
  assertEquals(await types(event('position', POINT, 'updated', [])), [`${LOCATION_EVENTS.pointChanged} ${POINT}`]);
});

Deno.test('rule: the reverse geocoder annotating a photo point is not a move', async () => {
  assertEquals(await types(event('position', POINT, 'updated', ['displayName', 'geocodedAt'])), []);
});

Deno.test('rule: a photo linked to a location by hand announces the location', async () => {
  const context = ctx({ links: { [LINK]: { target: LOCATION } } });
  assertEquals(await types(event('softlink', LINK, 'created'), context), [`${LOCATION_EVENTS.locationChanged} ${LOCATION}`]);
});

Deno.test('rule: a link made from the shape does not — that would be the loop', async () => {
  const context = ctx({ links: { [LINK]: { target: LOCATION, attrs: { linkSource: 'shape' } } } });
  assertEquals(await types(event('softlink', LINK, 'created'), context), []);
});

Deno.test('rule: other softlinks are ignored', async () => {
  const context = ctx({ links: { [`${ALBUMS_ROOT}/trip/cover`]: { target: `${ALBUMS_ROOT}/trip/files/a.jpg` }, [LINK]: { target: '/somewhere/else' } } });
  assertEquals(await types(event('softlink', `${ALBUMS_ROOT}/trip/cover`, 'created'), context), []);
  assertEquals(await types(event('softlink', LINK, 'created'), context), []);
});

const TRACK = '/dev/the-sailboat/position';

Deno.test("rule: points appended to a device's track under /dev are announced for the track", async () => {
  assertEquals(await types(event('track', TRACK, 'updated', [])), [`${LOCATION_EVENTS.trackChanged} ${TRACK}`]);
  assertEquals(await types(event('track', '/dev/the-phone/route', 'updated', [])), [`${LOCATION_EVENTS.trackChanged} /dev/the-phone/route`]);
  // A track outside /dev is not, nor one being made.
  assertEquals(await types(event('track', '/home/someone/route', 'updated', [])), []);
  assertEquals(await types(event('track', '/archive/cameras/the-phone/track', 'updated', [])), []);
  assertEquals(await types(event('track', TRACK, 'created')), []);
});

Deno.test("rule: a track's kind or timezone changing is announced, other attrs are not", async () => {
  assertEquals(await types(event('track', TRACK, 'updated', ['kind'])), [`${LOCATION_EVENTS.trackChanged} ${TRACK}`]);
  assertEquals(await types(event('track', TRACK, 'updated', ['timezone', 'description'])), [`${LOCATION_EVENTS.trackChanged} ${TRACK}`]);
  assertEquals(await types(event('track', TRACK, 'updated', ['description', 'tripEdits'])), []);
  // An update without changedAttrs: no way to tell, so nothing.
  assertEquals(await types(event('track', TRACK, 'updated')), []);
});

Deno.test('rule: a home added to or taken off a track is announced, a person moving is not', async () => {
  const context = ctx({ types: { [TRACK]: 'track', [`${PEOPLE_ROOT}/anna`]: 'person' } });
  assertEquals(await types(event('softlink', `${TRACK}/homes/the-berth`, 'created'), context), [`${LOCATION_EVENTS.trackChanged} ${TRACK}`]);
  assertEquals(await types(event('softlink', `${TRACK}/homes/the-berth`, 'deleted'), context), [`${LOCATION_EVENTS.trackChanged} ${TRACK}`]);
  assertEquals(await types(event('softlink', `${PEOPLE_ROOT}/anna/homes/the-house`, 'created'), context), []);
  assertEquals(await types(event('softlink', `${ALBUMS_ROOT}/trip/homes/x`, 'created'), context), []);
});
