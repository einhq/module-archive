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
  locationSource?: 'media-centroid' | 'track' | 'nominatim' | 'manual';
  /** `media-centroid` only: how many geotagged files the position rests on. */
  locationPoints?: number;
  /** How many candidates are waiting for someone to pick one. */
  candidateCount: number;
  lat?: number;
  lng?: number;
};

/**
 * `track-list`: a track — a device's `track` endpoint under `/dev`, such as a phone's or a boat's
 * `position` — with the track registry's summary of it; no points read.
 */
export type TrackEntry = {
  /** The track's path. */
  path: string;
  /** The track node's id, which a move keeps. */
  nodeId: string;
  /** The device it is an endpoint of, `/dev/<device>`, whose page shows it. */
  device?: string;
  /**
   * What it is called: its device's label (a device's track other than `position` adds its own
   * label), else its own `label`, else the label, name or node name of the nearest node above it.
   */
  name: string;
  /**
   * How it travels (`TravelKind`), which sets the units its speed is shown in: its own `kind`, else
   * its device's `class` when that is a kind.
   */
  kind?: string;
  description?: string;
  points: number;
  firstTs?: string;
  lastTs?: string;
  bbox?: { north: number; south: number; east: number; west: number };
};

/**
 * `track-stage`: the file's fixes joined a device's track, or it waits at `path` (in its staging
 * area's `routes/` when it was staged) for someone to say which device it belongs to; `candidates`
 * are the tracks of the devices it names. `skipped` counts the fixes the track already had,
 * `untimed` the points without a time, which no track takes.
 */
export type TrackStageResult =
  | { status: 'imported'; track: string; imported: number; skipped: number; untimed: number; source: string }
  | { status: 'pending'; path: string; reason: string; candidates: string[] };

/**
 * `gpx-info`: what one GPX file says about itself, read without importing it — or why it could
 * not be read.
 */
export type GpxInfo =
  | {
    path: string;
    /** Bytes. */
    size: number;
    /** The file's own name, description and time (`<metadata>`, or the root in GPX 1.0). */
    name?: string;
    description?: string;
    time?: string;
    /** The `creator` attribute. */
    creator?: string;
    /** Each track's name. */
    tracks: string[];
    /** Track points, and how many of them carry a time. */
    points: number;
    timed: number;
    /** The earliest and latest point time. */
    start?: string;
    end?: string;
    /** The tracks of the devices the file names, which `track-stage` would choose from. */
    matches: { path: string; name: string }[];
  }
  | { path: string; error: string };

type TrackSegment = { day: string; points: TrackPoint[] };

export type TrackRead = { segments: TrackSegment[]; points: number; truncated: boolean };

/** A point of a drawn track segment, as `track-read` returns it. */
export type TrackPoint = {
  lat: number;
  lng: number;
  ts?: string;
  /** Metres per second, as the tracker reported it. Only on a read that was not simplified. */
  speed?: number;
  /** Why the fix is left out, a rule's name or `manual`, on a `--rejected` read that was not simplified. */
  rejected?: string;
  /** What a person said of the fix (`track-mark`), on a read that was not simplified. */
  manual?: 'reject' | 'accept';
};

/** `track-mark`: how many fixes' verdict changed. */
export type TrackMark = { marked: number };

/** `track-move`: how many fixes left the track, and the track they moved to. */
export type TrackMove = { moved: number; to: string };

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

/**
 * A place a track stayed, derived by `track-trips`. Its position is the mean of its fixes, which
 * for a long stay lands on the berth or the parking spot.
 *
 * - `home`: at one of the track's homes; it ends the trip arriving there.
 * - `rest`: longer than the long rest of the track's kind anywhere else; it ends the trip arriving there too.
 * - `overnight`: two hours or more across a local midnight, within a trip.
 */
export type TripStay = {
  lat: number;
  lng: number;
  /** The first and the last fix of the stay, ISO. */
  start: string;
  end: string;
  kind: 'home' | 'rest' | 'overnight';
  /** `home`: the home's location. */
  home?: string;
  /**
   * The location it was at, from `track-places`: its home, the location within 150 m of it, or
   * one made for it and named after the harbour, island, bay or town there.
   */
  location?: string;
  /** `trip-list`: that location's name as it is now. */
  name?: string;
  /** `track-places` found no name for where it is (out at sea), and does not look again. */
  unnamed?: true;
};

/** Where a trip or a leg starts or ends: a stay (its index in `stays`), or the fix it was at. */
export type TripPlace = {
  lat: number;
  lng: number;
  /** ISO. */
  time: string;
  stay?: number;
};

type TripBounds = { north: number; south: number; east: number; west: number };

/**
 * The weather over a leg or a trip, from `track-weather`: the weather of each hour along its
 * track (`@archive/weather/at`) at where the track was then. A value no hour had is left out.
 */
export type TripWeather = {
  /** How many hours were sampled. */
  hours: number;
  /** The mean of the hours' mean wind speeds, and the strongest of them, m/s. */
  windSpeed?: number;
  windMax?: number;
  /** Where the wind blew from, degrees clockwise from north: the mean of the hours' directions as vectors. */
  windDirection?: number;
  /** The coldest and the warmest hour, °C. */
  temperatureMin?: number;
  temperatureMax?: number;
  /** The mean cloud cover, percent. */
  cloudCover?: number;
};

/** One local day of a trip. */
export type TripLeg = {
  /** The day, `YYYY-MM-DD`, in the track's timezone. */
  day: string;
  /** Its first and last fix, ISO. */
  start: string;
  end: string;
  from: TripPlace;
  to: TripPlace;
  /** The length of the track that day, in metres. */
  distanceM: number;
  bounds: TripBounds;
  /** `track-weather`: the weather that day. */
  weather?: TripWeather;
};

/** A trip derived from a track, from one home or long rest to the next. */
export type Trip = {
  /**
   * What names it to `trip-edit`: its first local day, `YYYY-MM-DD`, and for a further trip
   * starting that day `-2`, `-3` after it.
   */
  id: string;
  /** Its first local day, `YYYY-MM-DD`. */
  day: string;
  /** Its first and last fix, ISO. */
  start: string;
  end: string;
  /** It has not ended at a stay, and its last fix is under 48 hours old. */
  ongoing: boolean;
  from: TripPlace;
  to: TripPlace;
  /** The farthest stay it reached from where it started; the farthest fix when it stayed nowhere. */
  destination: { lat: number; lng: number; stay?: number };
  /** The length of its track, and how far from its start it got, in metres. */
  distanceM: number;
  maxDistanceM: number;
  /** Its local days, one leg each. */
  days: string[];
  legs: TripLeg[];
  bounds: TripBounds;
  /** The first fixes, ISO, of the trips joined to it by a merge, each of which `trip-edit --split` parts again. */
  joined?: string[];
  /** `track-weather`: the weather over all its days. */
  weather?: TripWeather;
  /** Albums whose span overlaps it and whose map draws the track (`album-device-list`). */
  albums: string[];
  /** `trip-list`: the album it was made (`trip-album`). `.trips` does not keep it. */
  album?: string;
};

/** Changes made by hand to how a track is cut into trips: its attr `tripEdits`. */
export type TripEdits = {
  /** The first fixes, ISO, of trips joined to the trip before them. */
  merge?: string[];
  /** Local days, `YYYY-MM-DD`, that start a trip at their midnight. */
  split?: string[];
};

/**
 * `track-trips`: a track's trips and stays, as kept in `<track>/.trips`. It names no track: it is
 * the child of the one it is of, and moves with it.
 */
export type TrackTrips = {
  /** When they were derived, ISO. */
  computedAt: string;
  /** The track's last fix, ISO. */
  lastFix?: string;
  /** From here on the next run reads the track again; before it, trips and stays are kept. ISO. */
  settledUntil?: string;
  /**
   * How many fixes the track had before `settledUntil`. When it has more, fixes were added earlier
   * in the track, and the next run reads all of it.
   */
  settledPoints?: number;
  /** What they were derived with besides the track: thresholds, timezone, homes and edits. */
  basis: string;
  trips: Trip[];
  stays: TripStay[];
};

/** How `track-places` placed one stay. */
export type TrackPlacesStay = {
  /** Its index in the track's stays, and its first fix, ISO. */
  stay: number;
  start: string;
  lat: number;
  lng: number;
  /**
   * - `home`: at its home's location.
   * - `near`: at a location within 150 m of it.
   * - `created`: at a location made for it, named by a lookup.
   * - `unnamed`: the lookups found no name for where it is.
   * - `failed`: a lookup failed; the next run asks again.
   */
  outcome: 'home' | 'near' | 'created' | 'unnamed' | 'failed';
  location?: string;
  name?: string;
  /** `failed`: why. */
  error?: string;
};

/** `track-places`: the stays it placed, and the names it looked up again under `--rename`. */
export type TrackPlaces = {
  track: string;
  stays: TrackPlacesStay[];
  renamed: { location: string; from: string; to: string }[];
  /** How many lookups failed; their stays are asked about again on the next run. */
  failed: number;
  /** How many requests went to Overpass and Nominatim; every other name came from their kept answers. */
  requests: number;
};

/** `track-weather`: what it sampled, and what it left for the next run. */
export type TrackWeather = {
  track: string;
  /** `CFG_WEATHER` is turned off: nothing was asked or written. */
  off?: true;
  /** The legs it gave weather, and how many hours it sampled for them. */
  legs: number;
  hours: number;
  /** The legs a failed lookup left without; the next run asks again. */
  failed: number;
  /** Why the lookup failed. */
  error?: string;
  /** How many requests went to SMHI and Open-Meteo; every other hour came from their kept answers. */
  requests: number;
};

/** `trip-list`: a track's trips and stays as last derived; none when they never were. */
export type TripList = {
  /** The track's path. */
  track: string;
  /** When they were derived, ISO; absent when they never were. */
  computedAt?: string;
  /** The track's last fix, ISO. */
  lastFix?: string;
  /** What the track's kind shows distances in. */
  units: 'nautical' | 'metric';
  /** The IANA timezone the legs' days are cut in; UTC when absent. */
  timezone?: string;
  trips: Trip[];
  stays: TripStay[];
};

/** One place where arriving ends one of a track's trips. */
export type TrackHome = {
  /** The location's path. */
  location: string;
  name: string;
  /**
   * `track` when the track lists it in its `homes/`; `owner` when it is the residence of an owner
   * of a camera linked to the track's device, used because the track lists none.
   */
  source: 'track' | 'owner';
  /** Whose residence it is, for `owner`. */
  owner?: string;
  /** For `owner`, the part of the residence that falls while they owned the camera; either end may be open. */
  from?: string;
  to?: string;
  /** Where it is, when the location has a position. */
  lat?: number;
  lng?: number;
};

/** `track-home <track>`: its home bases. */
export type TrackHomes = { track: string; homes: TrackHome[] };
