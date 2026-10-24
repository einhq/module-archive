/**
 * Forward geocoding: a free-text address -> a point.
 *
 * The decision logic lives here, apart from the HTTP call, because it is the
 * part worth testing: the legacy import hands us Swedish addresses typed by
 * hand years ago, and Nominatim answers *something* for almost any string. A
 * wrong coordinate is worse than none — it drags media onto the wrong place
 * through location-link-media — so a result is only applied when it is pinned to a
 * building and independently corroborated by the house number or postcode the
 * query already contained. Everything else becomes candidates for a human.
 */

import { haversineMeters } from '@ein/client';

export type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  category?: string;
  type?: string;
  addresstype?: string;
  importance?: number;
  place_rank?: number;
  address?: Record<string, string>;
  /** ["south", "north", "west", "east"], as strings. Present on every jsonv2 hit. */
  boundingbox?: string[];
};

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
export const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_USER_AGENT = 'EiN/1.0';

type NominatimSearchOptions = {
  limit?: number;
  /** Comma-separated ISO codes, or '' for no restriction. A location name from a search query
   * must not be restricted to one country the way a legacy Swedish address is. */
  countrycodes?: string;
  baseUrl?: string;
};

/** Nominatim's published usage policy for the public instance: 1 request per second. */
export const NOMINATIM_MIN_INTERVAL_MS = 1000;

/**
 * How long the public instance is left alone after it answers 429 with no `Retry-After`, and
 * the longest any `Retry-After` is honoured. It has answered 429 to one paced caller at a time
 * when its own load was high, so a few seconds is the floor, not a guess at a per-IP window.
 */
const NOMINATIM_BACKOFF_MS = 5000;
const NOMINATIM_MAX_BACKOFF_MS = 60_000;

/** Attempts at one request before a 429 is the caller's problem. Three waits of up to a minute. */
const NOMINATIM_MAX_ATTEMPTS = 4;

/**
 * When the next public-instance request may go out, shared by every caller in the process.
 *
 * A slot is *reserved* at the moment a caller asks, not recorded once it has waited: computing
 * the wait from the last stamp and stamping after the sleep would let every caller that arrived
 * during one sleep wake together, as a burst.
 */
let nextPublicSlot = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isPublicNominatim = (url: URL): boolean => url.host === new URL(NOMINATIM_SEARCH_URL).host;

/**
 * Hold until the public instance may be called again.
 *
 * The pacing belongs to the request rather than to a loop over locations, because
 * a single lookup is several requests: an address is tried Sweden-first, then
 * worldwide, then street-only.
 *
 * It is exported, and keyed on the host rather than on one endpoint, because
 * the limit is the service's: search and reverse lookups share one counter,
 * where two counters would issue two requests per second between them.
 *
 * Only the public instance is throttled — a stub on loopback or a self-hosted
 * instance has no such policy, and making the test suite sleep a second per
 * request would buy nothing.
 */
export const throttleNominatim = async (url: URL): Promise<void> => {
  if (!isPublicNominatim(url)) return;

  const now = Date.now();
  const slot = Math.max(now, nextPublicSlot);
  nextPublicSlot = slot + NOMINATIM_MIN_INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
};

/**
 * Push every caller's next slot out by `ms`.
 *
 * A 429 is the service saying the *process* is over its limit, so the caller that saw it is
 * not the only one that must wait: the others already queued behind the throttle would
 * otherwise walk straight into the same answer one second apart.
 */
const holdNominatim = (url: URL, ms: number): void => {
  if (!isPublicNominatim(url)) return;
  nextPublicSlot = Math.max(nextPublicSlot, Date.now() + ms);
};

/** `Retry-After` in ms, as seconds or an HTTP date, capped; the default when absent or unreadable. */
export const retryAfterMs = (header: string | null, fallback = NOMINATIM_BACKOFF_MS): number => {
  if (!header) return fallback;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(header).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.min(ms, NOMINATIM_MAX_BACKOFF_MS);
};

/**
 * One paced request to Nominatim, retried on 429 (and 503) with the service's own backoff.
 *
 * Retrying *here* rather than leaving it to the pipeline's `maxAttempts` matters because the
 * engine re-dispatches a failed step immediately: three attempts at a 429 arrive inside 40 s and
 * all three get the same answer. A step that instead holds the line for a few seconds, or for
 * whatever `Retry-After` says, succeeds — and it holds it for every other caller too.
 *
 * Throws on a non-OK answer once the attempts are spent, with the status in the message.
 */
export const nominatimFetch = async (url: URL, init: RequestInit = {}, attempts = NOMINATIM_MAX_ATTEMPTS): Promise<Response> => {
  const headers = { 'User-Agent': NOMINATIM_USER_AGENT, ...(init.headers as Record<string, string> | undefined) };
  let backoff = NOMINATIM_BACKOFF_MS;
  for (let attempt = 1;; attempt++) {
    await throttleNominatim(url);
    const response = await fetch(url, { ...init, headers });
    if (response.ok) return response;
    if ((response.status !== 429 && response.status !== 503) || attempt >= attempts) {
      throw new Error(`nominatim returned ${response.status}`);
    }
    await response.body?.cancel();
    const wait = retryAfterMs(response.headers.get('retry-after'), backoff);
    holdNominatim(url, wait);
    backoff = Math.min(backoff * 2, NOMINATIM_MAX_BACKOFF_MS);
  }
};

/**
 * One forward-geocoding request. Throws with a caller-formattable message on any failure.
 *
 * Shared so the geocoder and the natural-language query parser cannot drift apart on the
 * endpoint, the user agent or the response format — or on the rate limit.
 */
export const nominatimSearch = async (query: string, opts: NominatimSearchOptions = {}): Promise<NominatimResult[]> => {
  const url = new URL(opts.baseUrl || NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', String(opts.limit ?? 5));
  if (opts.countrycodes) url.searchParams.set('countrycodes', opts.countrycodes);

  const response = await nominatimFetch(url);

  const results = await response.json();
  return Array.isArray(results) ? results as NominatimResult[] : [];
};

/**
 * A hit's bounding box, or undefined when it has none or it is unusable.
 *
 * This is how a location *name* becomes a search region: "Italy" has no single point worth
 * searching around, but it has a box. Nominatim orders the array south, north, west, east.
 */
export const boundsOf = (result: NominatimResult): { north: number; south: number; east: number; west: number } | undefined => {
  const box = result.boundingbox;
  if (!box || box.length !== 4) return undefined;
  const [south, north, west, east] = box.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return undefined;
  if (north <= south || east <= west) return undefined;
  return { north, south, east, west };
};

type GeocodeCandidate = {
  lat: number;
  lng: number;
  displayName: string;
  type: string;
  importance: number;
};

/** How tightly the hit is pinned. Only `house` is ever applied automatically. */
type GeocodePrecision = 'house' | 'road' | 'area';

type AddressFields = {
  country?: string;
  state?: string;
  city?: string;
  road?: string;
  houseNumber?: string;
  postcode?: string;
  displayName?: string;
};

export type GeocodeDecision =
  | { status: 'applied'; lat: number; lng: number; precision: GeocodePrecision; address: AddressFields; candidates: GeocodeCandidate[]; reason: string }
  | { status: 'review'; candidates: GeocodeCandidate[]; reason: string }
  | { status: 'none'; candidates: []; reason: string };

/** Legacy addresses are multi-line ("street\npostcode city"); Nominatim wants one line. */
export const normalizeQuery = (raw: string): string => raw.replace(/[\r\n]+/g, ', ').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();

/** Swedish postcode as written ("999 77" or "99977"), normalized to digits only. */
export const postcodeOf = (query: string): string | undefined => {
  const match = query.match(/\b(\d{3})\s?(\d{2})\b/);
  return match ? `${match[1]}${match[2]}` : undefined;
};

/**
 * The street part of the query: everything before the first comma or newline.
 *
 * The legacy addresses qualify a street with things Nominatim cannot match. The
 * district is the worst offender — "Söderby" is a postal name, while OSM
 * files the same street under Norrhamn/Sydväst/Göteborg — and free-text search is
 * conjunctive enough that one unmatchable qualifier returns *nothing* rather
 * than a weaker hit. "Provgatan 18, 999 39 Söderby" finds nothing;
 * "Provgatan 18" is a house with exactly that postcode. Apartment numbers
 * ("Lägenhet 27") and legacy internal codes (" : 496") do the same.
 */
export const streetLineOf = (query: string): string => (query.split(/[,\r\n]/)[0] ?? '').trim();

/**
 * Street-name abbreviations OSM spells out and Nominatim will not expand.
 *
 * "Dr Exempelsons gata 2" finds nothing at all; "Doktor Exempelsons gata 2" is a
 * house, with the very postcode the written address already carried.
 *
 * Deliberately tiny, and only entries with a single possible reading. `St` is
 * the counter-example and is left out: in a Swedish street name it is both
 * Sankt and Stora. Expansion is a guess, so it is the last attempt tried and
 * whatever it finds has to be confirmed by the postcode.
 */
const STREET_ABBREVIATIONS: [RegExp, string][] = [
  // `\b` right after `Dr` is what keeps this off "Drottninggatan" and "Drive".
  // It does not keep it off the English "Salem Dr" — which is exactly why the
  // postcode, not this table, has the final say.
  [/\bDr\b\.?/gi, 'Doktor'],
  [/\bProf\b\.?/gi, 'Professor'],
];

export const expandAbbreviations = (text: string): string => STREET_ABBREVIATIONS.reduce((acc, [pattern, full]) => acc.replace(pattern, full), text);

/**
 * House number in the street part of the query.
 *
 * Only the segment before the first comma/newline is considered, so the digits
 * of a postcode or a city district cannot be mistaken for one.
 */
export const houseNumberOf = (query: string): string | undefined => {
  const match = streetLineOf(query).match(/\b(\d+)\s*([A-Za-z])?\b\s*$/);
  return match ? `${match[1]}${match[2] ?? ''}` : undefined;
};

const digits = (value: string | undefined): string => (value ?? '').replace(/\D/g, '');

/** Compares "27" to "27 A" / "27b" without caring about spacing or case. */
const houseNumberMatches = (queried: string, resolved: string | undefined): boolean => {
  if (!resolved) return false;
  const norm = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  return norm(resolved) === norm(queried) || norm(resolved).startsWith(norm(queried));
};

/** OSM tags a addresstype can carry for something the size of a building. */
const HOUSE_TYPES = ['house', 'building', 'house_number'];

export const precisionOf = (result: NominatimResult): GeocodePrecision => {
  const kind = result.addresstype ?? result.type ?? '';
  // `category: 'building'` covers the common `type: 'yes'` building tag, which
  // says nothing on its own.
  if (result.address?.house_number || result.category === 'building' || HOUSE_TYPES.includes(kind)) return 'house';
  if (kind === 'road' || kind === 'street' || result.category === 'highway') return 'road';
  return 'area';
};

const toCandidate = (result: NominatimResult): GeocodeCandidate | undefined => {
  const lat = Number(result.lat);
  const lng = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    lat,
    lng,
    displayName: result.display_name ?? '',
    type: result.addresstype ?? result.type ?? '',
    importance: typeof result.importance === 'number' ? result.importance : 0,
  };
};

const addressFieldsOf = (result: NominatimResult): AddressFields => {
  const a = result.address ?? {};
  const fields: AddressFields = {
    country: a.country,
    state: a.state,
    city: a.city ?? a.town ?? a.village ?? a.municipality,
    road: a.road,
    houseNumber: a.house_number,
    postcode: a.postcode,
    displayName: result.display_name,
  };
  for (const key of Object.keys(fields) as (keyof AddressFields)[]) {
    if (!fields[key]) delete fields[key];
  }
  return fields;
};

/** A runner-up this close is the same building by another name, not a rival. */
const AMBIGUITY_METERS = 250;
/** Below this share of the top importance a runner-up is not a serious rival. */
const AMBIGUITY_IMPORTANCE_RATIO = 0.9;

type DecideOptions = {
  /**
   * Require the postcode to corroborate, not merely the house number.
   *
   * For a **relaxed** lookup, where the street line was searched on its own.
   * A common street name exists in a dozen Swedish towns and every one of them
   * has a number 6, so the house number stops being evidence — the postcode
   * from the original address is the only thing left that ties the answer to
   * the location we meant. Without a match it goes to a human.
   */
  requirePostcode?: boolean;
};

/**
 * Decide what to do with Nominatim's answers for `query`.
 *
 * `applied` requires all three: building precision, corroboration by a house
 * number or postcode the query itself carried, and no comparably-ranked hit
 * somewhere else.
 *
 * `query` is always the address **as written**, even when a reduced string was
 * sent to the geocoder — corroboration has to be judged against what we
 * actually know, not against what we asked.
 */
export const decideGeocode = (query: string, results: NominatimResult[], opts: DecideOptions = {}): GeocodeDecision => {
  const candidates = results.map(toCandidate).filter((c): c is GeocodeCandidate => c !== undefined);
  if (candidates.length === 0) return { status: 'none', candidates: [], reason: 'no results' };

  const top = results[0];
  const topCandidate = candidates[0];
  const precision = precisionOf(top);

  if (precision !== 'house') {
    return { status: 'review', candidates, reason: `top hit is ${precision}-precision` };
  }

  const wantedNumber = houseNumberOf(query);
  const wantedPostcode = postcodeOf(query);
  const numberOk = wantedNumber !== undefined && houseNumberMatches(wantedNumber, top.address?.house_number);
  const postcodeOk = wantedPostcode !== undefined && digits(top.address?.postcode) === wantedPostcode;

  if (opts.requirePostcode && !postcodeOk) {
    return {
      status: 'review',
      candidates,
      reason: wantedPostcode === undefined ? 'street-only lookup with no postcode to confirm it' : 'street-only lookup and the postcode disagrees',
    };
  }

  if (!numberOk && !postcodeOk) {
    const missing = wantedNumber === undefined && wantedPostcode === undefined
      ? 'query has no house number or postcode to corroborate'
      : 'house number and postcode both disagree';
    return { status: 'review', candidates, reason: missing };
  }

  const rival = candidates.slice(1).find((c) =>
    c.importance >= topCandidate.importance * AMBIGUITY_IMPORTANCE_RATIO &&
    haversineMeters(topCandidate.lat, topCandidate.lng, c.lat, c.lng) > AMBIGUITY_METERS
  );
  if (rival) {
    return { status: 'review', candidates, reason: 'ambiguous: a comparable hit sits elsewhere' };
  }

  return {
    status: 'applied',
    lat: topCandidate.lat,
    lng: topCandidate.lng,
    precision,
    address: addressFieldsOf(top),
    candidates,
    // Name the rule that actually let this through. Under `requirePostcode` the
    // house number is not evidence, so crediting it would misdescribe why a
    // street-only answer was trusted.
    reason: opts.requirePostcode || !numberOk ? 'postcode matches' : 'house number matches',
  };
};

export { haversineMeters };
