import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { ALL_LAYERS, type MapState, mapStateFromParams, paramsFromMapState } from '../map-params.ts';

Deno.test('map params: a plain /map is every layer and no constraint', () => {
  const state = mapStateFromParams(new URLSearchParams());
  assertEquals(state.layers, ALL_LAYERS);
  assertEquals(state.center, undefined);
  assertEquals(state.zoom, undefined);
  assertEquals(state.fromYear, undefined);
  assertEquals(state.baseLayer, undefined);
  assertEquals(state.filters, {});
});

Deno.test('map params: defaults are written as absence', () => {
  const params = paramsFromMapState({ layers: { ...ALL_LAYERS }, filters: {} });
  assertEquals(params.toString(), '');
});

Deno.test('map params: a full view round-trips', () => {
  const state: MapState = {
    center: { lat: 57.70123, lng: 11.97456 },
    zoom: 12,
    layers: { media: true, locations: false, tracks: true },
    fromYear: 2015,
    toYear: 2016,
    baseLayer: 'Satellite',
    filters: { query: 'segelbåt', person: 'Nils_J_Lund', location: 'Göteborg', tag: 'sailing' },
  };

  const params = paramsFromMapState(state);
  assertEquals(params.get('c'), '57.70123,11.97456');
  assertEquals(params.get('z'), '12');
  assertEquals(params.get('layers'), 'media,tracks');
  assertEquals(params.get('from'), '2015');
  assertEquals(params.get('to'), '2016');
  assertEquals(params.get('base'), 'Satellite');
  assertEquals(params.get('q'), 'segelbåt');
  assertEquals(params.get('person'), 'Nils_J_Lund');
  assertEquals(params.get('location'), 'Göteborg');
  assertEquals(params.get('tag'), 'sailing');

  assertEquals(mapStateFromParams(params), state);
});

Deno.test('map params: an empty map is expressible, a mangled one is not blank', () => {
  const blank = { media: false, locations: false, tracks: false };
  assertEquals(paramsFromMapState({ layers: blank, filters: {} }).get('layers'), 'none');
  assertEquals(mapStateFromParams(new URLSearchParams({ layers: 'none' })).layers, blank);

  // Hand-mangled lists fall back to showing everything rather than nothing.
  assertEquals(mapStateFromParams(new URLSearchParams({ layers: 'nonsense' })).layers, ALL_LAYERS);
  assertEquals(mapStateFromParams(new URLSearchParams({ layers: '' })).layers, ALL_LAYERS);
});

Deno.test('map params: garbage coordinates are ignored, not fatal', () => {
  const state = mapStateFromParams(new URLSearchParams({ c: 'north,west', z: 'far', from: 'ages ago' }));
  assertEquals(state.center, undefined);
  assertEquals(state.zoom, undefined);
  assertEquals(state.fromYear, undefined);
  assertEquals(state.layers, ALL_LAYERS);
});

Deno.test('map params: a negative longitude survives the round trip', () => {
  const params = paramsFromMapState({ center: { lat: 47.6205, lng: -122.3493 }, zoom: 9, layers: { ...ALL_LAYERS }, filters: {} });
  assertEquals(mapStateFromParams(params).center, { lat: 47.6205, lng: -122.3493 });
});

Deno.test('map params: a parameter the map does not own survives a camera write', () => {
  const current = new URLSearchParams({ c: '57.70123,11.97456', z: '12', fullscreen: `/media/${encodeURIComponent(`${ALBUMS_ROOT}/Trip/files/a.jpg`)}` });

  // What a pan does: rebuild the camera from the URL it is replacing.
  const params = paramsFromMapState({ ...mapStateFromParams(current), center: { lat: 57.8, lng: 12.1 }, zoom: 13 }, current);

  assertEquals(params.get('c'), '57.80000,12.10000');
  assertEquals(params.get('z'), '13');
  assertEquals(params.get('fullscreen'), `/media/${encodeURIComponent(`${ALBUMS_ROOT}/Trip/files/a.jpg`)}`);
});

Deno.test('map params: a carried parameter does not resurrect a map key the state dropped', () => {
  const current = new URLSearchParams({ from: '2015', to: '2016', base: 'Satellite', q: 'old search', fullscreen: '/media/x' });
  const params = paramsFromMapState({ layers: { ...ALL_LAYERS }, filters: {} }, current);

  assertEquals(params.toString(), 'fullscreen=%2Fmedia%2Fx');
});
