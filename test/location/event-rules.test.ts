/**
 * The location rules: which VFS mutations are location and point facts,
 * and — as much the point — which are not.
 */

import { ALBUMS_ROOT, LOCATIONS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { deriveLocationEvents, LOCATION_EVENTS, type LocationRuleContext, type VfsEventInput } from '../../lib/location/event-rules.ts';

const LOCATION = `${LOCATIONS_ROOT}/Exempelparken`;
const POINT = `${ALBUMS_ROOT}/trip/files/a.jpg/position`;
const SHAPE = `${LOCATION}/position`;
const LINK = `${ALBUMS_ROOT}/trip/files/a.jpg/location`;

const ctx = (opts: { points?: string[]; links?: Record<string, { target: string; attrs?: Record<string, unknown> }> } = {}): LocationRuleContext => ({
  hasPoint: (path) => Promise.resolve(opts.points?.includes(path) ?? false),
  getLink: (path) => {
    const link = opts.links?.[path];
    return Promise.resolve(link ? { id: 'l1', target: link.target, attrs: link.attrs ?? {} } : undefined);
  },
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
