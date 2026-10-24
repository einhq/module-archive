/**
 * What the location area's commands answer with under `JSON_OUTPUT=1`, as types (`@archive/location/api`).
 *
 * The UI and other modules import these instead of restating the shapes, and each command checks
 * its answer against them. Imports only other type-only files, so a browser can import it
 * without type-checking the module.
 */

export type LocationEntry = {
  id: string; // node/directory name
  name: string;
  /** The written address — the input to geocoding, not its result. */
  address?: string;
  /** What the geocoder resolved the address to, once it has. */
  displayName?: string;
  geocodeStatus?: 'applied' | 'review' | 'none';
  /** Where the coordinates came from, once there are any. */
  locationSource?: 'media-centroid' | 'nominatim' | 'manual';
  /** `media-centroid` only: how many geotagged files the position rests on. */
  locationPoints?: number;
  /** How many candidates are waiting for someone to pick one. */
  candidateCount: number;
  lat?: number;
  lng?: number;
};

/** `track-list`: a device's track, with the track registry's summary of it — no points read. */
export type TrackEntry = {
  /** The device's slug, which is what its page's route uses. */
  id: string;
  /** The device's path. */
  device: string;
  /** The track's path, `<device>/track`. */
  path: string;
  /** The track node's id. */
  nodeId: string;
  /** The device's name. */
  name: string;
  description?: string;
  points: number;
  firstTs?: string;
  lastTs?: string;
  bbox?: { north: number; south: number; east: number; west: number };
};

/**
 * `track-stage`: the file's fixes joined a track, or it waits at `path` (in its staging area's
 * `routes/` when it was staged) for someone to say which device recorded it.
 */
export type TrackStageResult =
  | { status: 'imported'; track: string; imported: number; skipped: number }
  | { status: 'pending'; path: string; reason: string; candidates: string[] };

type TrackSegment = { day: string; points: TrackPoint[] };

export type TrackRead = { segments: TrackSegment[]; points: number; truncated: boolean };

/** A point of a drawn track segment, as `track-read` returns it. */
export type TrackPoint = {
  lat: number;
  lng: number;
  ts?: string;
};

/**
 * `geocode-position <file>/position`: the address its point reverse-geocodes to, as written onto
 * the position node; an empty field was not in the answer. `skipped` when the node holds no point
 * yet, or was geocoded already (at `geocodedAt`) and `--force` was not given.
 */
export type GeocodePositionResult =
  | {
    country: string;
    state: string;
    city: string;
    /** The neighbourhood: Nominatim's suburb, else its neighbourhood. */
    suburb: string;
    road: string;
    houseNumber: string;
    postcode: string;
    /** The named place the point is at (a museum, a campsite), when it is neither the road nor the city. */
    poi: string;
    displayName: string;
    geocodedAt: string;
  }
  | { skipped: 'no position data' }
  | { skipped: 'geocoded already'; geocodedAt: string };
