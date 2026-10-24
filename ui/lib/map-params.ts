/**
 * The map page's URL, as a codec.
 *
 * The address bar is the map's only state — where you are looking, which layers
 * are on, which years, which basemap, and which search filters. That is what
 * makes a view linkable and bookmarkable, and what survives a reload. Same discipline as the search page
 * (`search-params.ts`), and pure for the same reason: no react-router and no
 * shell client, so it round-trips in a test.
 *
 *   /map?c=57.70123,11.97456&z=12&layers=media,tracks&from=2015&to=2016&base=Satellite&q=sailing
 *
 * Defaults are absent rather than spelled out: all layers on, no year bound and
 * the default basemap (the first of `BASE_LAYERS`) write nothing, so a plain `/map` stays plain.
 *
 * The codec owns `MAP_PARAM_KEYS` and nothing else. Anything else in the query
 * string belongs to a feature layered over the map — the route open full screen
 * over it, the lightbox above all — and the writer carries it through untouched.
 */

import type { PositionPoint } from '@ein/ui/lib';

const MAP_LAYERS = ['media', 'locations', 'tracks'] as const;
type MapLayer = typeof MAP_LAYERS[number];

export type MapLayers = Record<MapLayer, boolean>;

/**
 * Search constraints shared by the markers and the contents behind them. `under` keeps them to one
 * album or folder; the map page never sets it, so the URL has no word for it.
 */
export type MapFilters = { query?: string; person?: string; location?: string; tag?: string; under?: string };

export type MapState = {
  center?: PositionPoint;
  zoom?: number;
  layers: MapLayers;
  /** Inclusive year bounds; both absent means no constraint. */
  fromYear?: number;
  toYear?: number;
  /** Name of the base layer, as `layers.ts` calls it. */
  baseLayer?: string;
  /** What is drawn and what a cluster opens. */
  filters: MapFilters;
};

export const ALL_LAYERS: MapLayers = { media: true, locations: true, tracks: true };

/** Coordinates are written to ~1m; more digits are noise in a URL people paste. */
const COORD_DIGITS = 5;

/** What `layers` means when it is absent (all), `none` (nothing) or a list. */
const layersFromParam = (raw: string | null): MapLayers => {
  if (raw === null) return { ...ALL_LAYERS };
  if (raw.trim() === 'none') return { media: false, locations: false, tracks: false };

  const named = raw.split(',').map((entry) => entry.trim()).filter((entry): entry is MapLayer => (MAP_LAYERS as readonly string[]).includes(entry));
  // A list of nothing recognisable is a mangled URL, not a request for a blank
  // map — `none` is how you ask for that.
  if (named.length === 0) return { ...ALL_LAYERS };

  return { media: named.includes('media'), locations: named.includes('locations'), tracks: named.includes('tracks') };
};

const number = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const centerFromParam = (value: string | null): PositionPoint | undefined => {
  if (!value) return undefined;
  const [lat, lng] = value.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat, lng };
};

/**
 * Read a map view out of the address bar.
 *
 * Anything malformed is ignored rather than rejected — a URL is user-editable,
 * and a half-mangled one should still show a map.
 */
export const mapStateFromParams = (params: URLSearchParams): MapState => {
  const layers = layersFromParam(params.get('layers'));
  const center = centerFromParam(params.get('c'));
  const zoom = number(params.get('z'));
  const fromYear = number(params.get('from'));
  const toYear = number(params.get('to'));
  const baseLayer = params.get('base') ?? undefined;
  const query = params.get('q')?.trim() || undefined;
  const person = params.get('person')?.trim() || undefined;
  const location = params.get('location')?.trim() || undefined;
  const tag = params.get('tag')?.trim() || undefined;

  return {
    ...(center ? { center } : {}),
    ...(zoom !== undefined ? { zoom } : {}),
    layers,
    ...(fromYear !== undefined ? { fromYear } : {}),
    ...(toYear !== undefined ? { toYear } : {}),
    ...(baseLayer ? { baseLayer } : {}),
    filters: {
      ...(query ? { query } : {}),
      ...(person ? { person } : {}),
      ...(location ? { location } : {}),
      ...(tag ? { tag } : {}),
    },
  };
};

/** The query keys this codec owns; every other one is somebody else's state. */
const MAP_PARAM_KEYS = ['c', 'z', 'layers', 'from', 'to', 'base', 'q', 'person', 'location', 'tag'] as const;

/**
 * Write a map view into an address bar, leaving defaults out of it.
 *
 * `current` is the query string being replaced. Pass it whenever one exists:
 * panning rewrites this URL continuously, and rebuilding it from map state
 * alone would drop every parameter the map does not own — the lightbox opened
 * from a marker among them.
 */
export const paramsFromMapState = (state: MapState, current?: URLSearchParams): URLSearchParams => {
  const params = new URLSearchParams();

  if (state.center) {
    params.set('c', `${state.center.lat.toFixed(COORD_DIGITS)},${state.center.lng.toFixed(COORD_DIGITS)}`);
  }
  if (state.zoom !== undefined) params.set('z', String(state.zoom));

  const enabled = MAP_LAYERS.filter((layer) => state.layers[layer]);
  // Nothing on is a real state and has to be expressible; everything on is the
  // default and is not written. `none` keeps it out of the "empty list means
  // default" hole the reader has to guard against.
  if (enabled.length !== MAP_LAYERS.length) params.set('layers', enabled.length > 0 ? enabled.join(',') : 'none');

  if (state.fromYear !== undefined) params.set('from', String(state.fromYear));
  if (state.toYear !== undefined) params.set('to', String(state.toYear));
  if (state.baseLayer) params.set('base', state.baseLayer);
  if (state.filters.query) params.set('q', state.filters.query);
  if (state.filters.person) params.set('person', state.filters.person);
  if (state.filters.location) params.set('location', state.filters.location);
  if (state.filters.tag) params.set('tag', state.filters.tag);

  // Appended after the map's own keys, so the readable part of a pasted link
  // still starts with where you are looking.
  const owned: readonly string[] = MAP_PARAM_KEYS;
  for (const [key, value] of current ?? []) {
    if (!owned.includes(key)) params.append(key, value);
  }

  return params;
};
