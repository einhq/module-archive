/**
 * The name of the place a device stayed at (`@archive/location/place-name`).
 *
 * A boat stays at harbours, islands and bays, which a reverse geocoder names only by the town
 * around them. So the named features OpenStreetMap's Overpass API has within `PLACE_RADIUS_M`
 * come first: a marina or a seamark harbour, then a boatyard ("varv"), then an island or islet,
 * then a bay, the nearest within a rank (`pickPlace`). Only when there is none is Nominatim asked
 * for the town, village or area around the point (`nominatimTown`).
 *
 * Overpass is asked for a whole `PlaceTile` at a time, with a margin of `PLACE_RADIUS_M` around
 * it, so one answer names every point in the tile. It is paced `OVERPASS_MIN_INTERVAL_MS` apart,
 * and a busy answer is retried on the next endpoint of the list: the public instances are mirrors
 * of each other.
 */

import { haversineMeters } from '@ein/client';
import { NOMINATIM_REVERSE_URL, nominatimFetch } from '@archive/location/geocode';

/** A named feature this close to the stay beats the town around it. */
const PLACE_RADIUS_M = 500;

/** The public Overpass instances, tried in turn. */
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/** The public instances ask for no more than about one request a second. */
const OVERPASS_MIN_INTERVAL_MS = 1100;
const OVERPASS_MAX_ATTEMPTS = 4;
/** The query asks the server to give up after 30 s; a mirror that has not answered well after that is down. */
const OVERPASS_REQUEST_TIMEOUT_MS = 45_000;
/** What an overloaded public instance answers. */
const OVERPASS_BUSY = new Set([429, 502, 503, 504]);
const OVERPASS_BACKOFF_MS = 3000;
const OVERPASS_MAX_BACKOFF_MS = 60_000;
const USER_AGENT = 'EiN/1.0';

/** What a place is, by what named it. `town` is Nominatim's answer: a town, village or area. */
type PlaceKind = 'marina' | 'harbour' | 'boatyard' | 'island' | 'bay' | 'town';

export type PlaceName = { name: string; kind: PlaceKind; source: 'overpass' | 'nominatim' };

/** An element of an Overpass answer, as `out center tags` gives it. */
export type OverpassElement = {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/**
 * Words OpenStreetMap often puts where a harbour's name should be. They tell one harbour from
 * no other, so a feature named only this is passed over.
 */
const GENERIC_NAMES = new Set([
  'småbåtshamn',
  'småbåtshamnen',
  'gästhamn',
  'gästhamnen',
  'hamn',
  'hamnen',
  'båthamn',
  'båthamnen',
  'fiskehamn',
  'fiskehamnen',
  'marina',
  'harbour',
  'harbor',
  'guest harbour',
  'ställplats',
]);

export const isGenericName = (name: string | undefined): boolean => !name?.trim() || GENERIC_NAMES.has(name.trim().toLowerCase());

/** A boatyard is where a boat is hauled out or mended, not where it goes, so it ranks below a marina. */
const isBoatyard = (name: string): boolean => /varv\b/i.test(name);

/** The rank of a feature, lower first, and what it is; undefined for a feature that is no stay's place. */
const rankOf = (tags: Record<string, string>): { rank: number; kind: PlaceKind } | undefined => {
  if (tags.leisure === 'marina' || tags['seamark:type'] === 'harbour') {
    if (isBoatyard(tags.name)) return { rank: 1.5, kind: 'boatyard' };
    return { rank: 1, kind: tags.leisure === 'marina' ? 'marina' : 'harbour' };
  }
  if (tags.place === 'island' || tags.place === 'islet') return { rank: 2, kind: 'island' };
  if (tags.natural === 'bay') return { rank: 3, kind: 'bay' };
  return undefined;
};

/** A tile's size in degrees: about 5.5 km north to south, and as far east to west at 60° N. */
const TILE_LAT = 0.05;
const TILE_LNG = 0.1;

/** A tile of the map Overpass is asked for at once. `key` names it: its south-west corner. */
type PlaceTile = { key: string; south: number; west: number; north: number; east: number };

/** The tile a point is in. */
export const tileOf = (lat: number, lng: number): PlaceTile => {
  const i = Math.floor(lat / TILE_LAT);
  const j = Math.floor(lng / TILE_LNG);
  const south = i * TILE_LAT;
  const west = j * TILE_LNG;
  return { key: `${south.toFixed(2)}_${west.toFixed(1)}`, south, west, north: south + TILE_LAT, east: west + TILE_LNG };
};

/** The tags `pickPlace` reads; the rest of an answer is dropped before it is kept. */
const KEPT_TAGS = ['name', 'leisure', 'place', 'natural', 'seamark:type'];

/** The Overpass query for the named features in a tile and `PLACE_RADIUS_M` around it. */
const overpassTileQuery = (tile: PlaceTile): string => {
  const marginLat = PLACE_RADIUS_M / 111_320;
  const marginLng = marginLat / Math.max(Math.cos(((tile.south + tile.north) / 2) * Math.PI / 180), 0.01);
  const bbox = [tile.south - marginLat, tile.west - marginLng, tile.north + marginLat, tile.east + marginLng].map((value) => value.toFixed(5)).join(',');
  return `[out:json][timeout:30];nwr(${bbox})` +
    '[~"^(leisure|natural|place|seamark:type)$"~"^(marina|bay|island|islet|harbour)$"][name];out center tags;';
};

/** The named features in a tile and around it, with only the tags `pickPlace` reads. Throws when Overpass fails. */
export const fetchOverpassTile = async (endpoints: string[], tile: PlaceTile): Promise<OverpassElement[]> =>
  (await overpassQuery(endpoints, overpassTileQuery(tile))).map((element) => ({
    ...(element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : {}),
    ...(element.center ? { center: element.center } : {}),
    tags: Object.fromEntries(Object.entries(element.tags ?? {}).filter(([key]) => KEPT_TAGS.includes(key))),
  }));

/** The best of the features Overpass answered for a point: by rank, then by distance. */
export const pickPlace = (lat: number, lng: number, elements: OverpassElement[]): PlaceName | undefined => {
  let best: { name: string; kind: PlaceKind; rank: number; distance: number } | undefined;
  for (const element of elements) {
    const tags = element.tags ?? {};
    const ranked = rankOf(tags);
    if (!ranked || isGenericName(tags.name)) continue;
    const at = element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : element.center;
    if (!at) continue;
    const distance = haversineMeters(lat, lng, at.lat, at.lon);
    if (distance > PLACE_RADIUS_M) continue;
    if (!best || ranked.rank < best.rank || (ranked.rank === best.rank && distance < best.distance)) {
      best = { name: tags.name.trim(), kind: ranked.kind, rank: ranked.rank, distance };
    }
  }
  return best && { name: best.name, kind: best.kind, source: 'overpass' };
};

/** The name Nominatim's reverse answer gives the area around a point. */
export const townOf = (answer: { address?: Record<string, string>; display_name?: string }): string | undefined => {
  const a = answer.address ?? {};
  const name = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || answer.display_name?.split(',')[0];
  return name?.trim() || undefined;
};

/** The endpoints a setting lists, separated by spaces or commas; the public ones when it lists none. */
export const overpassEndpoints = (setting: string | undefined): string[] => {
  const listed = (setting ?? '').split(/[\s,]+/).filter(Boolean);
  return listed.length ? listed : OVERPASS_URLS;
};

/** When the next Overpass request may go out, shared by every caller in the process. */
let nextOverpassSlot = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A server on this machine, such as a test's stub, has no rate to keep to. */
const isLoopback = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

const throttleOverpass = async (url: URL): Promise<void> => {
  if (isLoopback(url)) return;
  const now = Date.now();
  const slot = Math.max(now, nextOverpassSlot);
  nextOverpassSlot = slot + OVERPASS_MIN_INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
};

/**
 * One Overpass query, paced, on the endpoints in turn. A busy answer (429, 502, 503, 504), a failed
 * connection or no answer within `OVERPASS_REQUEST_TIMEOUT_MS` is retried on the next one after a
 * backoff, or `Retry-After` when it says longer.
 * Throws once the attempts are spent, or on any other answer.
 */
const overpassQuery = async (endpoints: string[], query: string): Promise<OverpassElement[]> => {
  let backoff = OVERPASS_BACKOFF_MS;
  for (let attempt = 0;; attempt++) {
    const url = new URL(endpoints[attempt % endpoints.length]);
    await throttleOverpass(url);
    const last = attempt + 1 >= OVERPASS_MAX_ATTEMPTS;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(OVERPASS_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (last) throw new Error(`overpass: ${error instanceof Error ? error.message : String(error)}`);
      if (!isLoopback(url)) await sleep(backoff);
      backoff = Math.min(backoff * 2, OVERPASS_MAX_BACKOFF_MS);
      continue;
    }
    if (response.ok) {
      const answer = await response.json() as { elements?: OverpassElement[] };
      return Array.isArray(answer.elements) ? answer.elements : [];
    }
    await response.body?.cancel();
    if (!OVERPASS_BUSY.has(response.status) || last) throw new Error(`overpass returned ${response.status}`);
    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Math.min(Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), OVERPASS_MAX_BACKOFF_MS);
    if (!isLoopback(url)) await sleep(wait);
    backoff = Math.min(backoff * 2, OVERPASS_MAX_BACKOFF_MS);
  }
};

/**
 * The town, village or area Nominatim gives for a point; undefined where it has none, as out at
 * sea. Throws when the request fails.
 */
export const nominatimTown = async (lat: number, lng: number, reverseUrl?: string): Promise<string | undefined> => {
  const url = new URL(reverseUrl || NOMINATIM_REVERSE_URL);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '12');
  const answer = await (await nominatimFetch(url)).json();
  // Where it has no name for the place Nominatim answers 200 with an error and no address.
  return answer && typeof answer === 'object' && !('error' in answer) ? townOf(answer) : undefined;
};
