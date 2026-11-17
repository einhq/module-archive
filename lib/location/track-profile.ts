/**
 * How a track travels, and what that means for reading it (`@archive/location/track-profile`).
 *
 * A track's `kind` picks one profile: the thresholds that tell a stop from drift and a trip from a
 * rest, and the units its distances and speeds are shown in. A track with no kind reads as a car.
 * A trip's own kind can come from what its device's motion sensors said (`activityKind`).
 * Imports nothing, so the bins and the UI share it.
 */

/** What a track travels as. */
export const TRAVEL_KINDS = ['boat', 'car', 'bike', 'foot'] as const;
type TravelKind = typeof TRAVEL_KINDS[number];

/** How each kind is named to a person. */
export const TRAVEL_KIND_LABELS: Record<TravelKind, string> = { boat: 'Boat', car: 'Car', bike: 'Bike', foot: 'On foot' };

export const isTravelKind = (value: unknown): value is TravelKind => (TRAVEL_KINDS as readonly unknown[]).includes(value);

/** Nautical (knots and nautical miles) or metric (km/h and km). */
type TrackUnits = 'nautical' | 'metric';

type TrackProfile = {
  kind: TravelKind;
  /** A stop's fixes stay within this many metres of where it began; wider is GPS drift no more. */
  driftRadiusM: number;
  /** How long the track has to stay within the drift radius before it counts as stopped. */
  stillMinMs: number;
  /** At or under this speed, in m/s, the track counts as lying still. */
  stillMaxSpeedMps: number;
  /** A jump implying more than this speed, in m/s, is a GPS glitch. */
  maxSpeedMps: number;
  /** Fixes within this many metres of each other are one place when trips are cut; also how near a home counts as home. */
  clusterRadiusM: number;
  /** A stay, or a gap without fixes, longer than this ends a trip. */
  longRestMs: number;
  units: TrackUnits;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KNOT_MPS = 1852 / 3600;
const KMH_MPS = 1000 / 3600;

const PROFILES: Record<TravelKind, TrackProfile> = {
  boat: {
    kind: 'boat',
    driftRadiusM: 80,
    stillMinMs: 15 * MINUTE,
    stillMaxSpeedMps: 0.5 * KNOT_MPS,
    maxSpeedMps: 50 * KNOT_MPS,
    clusterRadiusM: 1000,
    longRestMs: 3 * DAY,
    units: 'nautical',
  },
  car: {
    kind: 'car',
    driftRadiusM: 50,
    stillMinMs: 10 * MINUTE,
    stillMaxSpeedMps: 2 * KMH_MPS,
    maxSpeedMps: 250 * KMH_MPS,
    clusterRadiusM: 500,
    longRestMs: 3 * DAY,
    units: 'metric',
  },
  bike: {
    kind: 'bike',
    driftRadiusM: 30,
    stillMinMs: 10 * MINUTE,
    stillMaxSpeedMps: 1.5 * KMH_MPS,
    maxSpeedMps: 100 * KMH_MPS,
    clusterRadiusM: 300,
    longRestMs: 2 * DAY,
    units: 'metric',
  },
  foot: {
    kind: 'foot',
    driftRadiusM: 25,
    stillMinMs: 10 * MINUTE,
    stillMaxSpeedMps: 1 * KMH_MPS,
    maxSpeedMps: 40 * KMH_MPS,
    clusterRadiusM: 200,
    longRestMs: 2 * DAY,
    units: 'metric',
  },
};

/** The profile of a track of this kind; anything that is not a kind reads as a car. */
export const trackProfile = (kind?: unknown): TrackProfile => PROFILES[isTravelKind(kind) ? kind : 'car'];

/** What a phone's motion sensors say it is doing, as Traccar Client logs it, and the kind that travels so. */
const ACTIVITY_KINDS: Record<string, TravelKind> = { on_foot: 'foot', walking: 'foot', running: 'foot', on_bicycle: 'bike', in_vehicle: 'car' };

/** One entry of a device's `activity` log: when it said it, epoch ms, and what it said. */
export type ActivityEntry = { at: number; activity: string };

/**
 * The kind a device travelled as in `[start, end]` (epoch ms), by its activity log in time order:
 * the kind it said longest, each entry holding until the next and the last before `start` from
 * `start` on. `still`, and anything else that names no kind, counts for none; undefined when
 * nothing else was said.
 */
export const activityKind = (log: ActivityEntry[], start: number, end: number): TravelKind | undefined => {
  const held = new Map<TravelKind, number>();
  log.forEach((entry, index) => {
    const kind = Object.hasOwn(ACTIVITY_KINDS, entry.activity) ? ACTIVITY_KINDS[entry.activity] : undefined;
    if (!kind) return;
    const from = Math.max(entry.at, start);
    const to = Math.min(log[index + 1]?.at ?? end, end);
    if (to > from) held.set(kind, (held.get(kind) ?? 0) + to - from);
  });
  let best: TravelKind | undefined;
  for (const [kind, ms] of held) if (best === undefined || ms > held.get(best)!) best = kind;
  return best;
};

/** How a trip travelled, named to a person: `On foot`, `Bike (by its motion sensors)` when its device sensed it; undefined for none. */
export const tripKindLabel = (trip: { kind?: string; sensed?: true }): string | undefined =>
  isTravelKind(trip.kind) ? `${TRAVEL_KIND_LABELS[trip.kind]}${trip.sensed ? ' (by its motion sensors)' : ''}` : undefined;

/** `12.4 nm` or `23.0 km`; under one unit with one decimal more. */
export const formatDistance = (metres: number, units: TrackUnits): string => {
  const value = metres / (units === 'nautical' ? 1852 : 1000);
  return `${value.toFixed(value < 1 ? 2 : 1)} ${units === 'nautical' ? 'nm' : 'km'}`;
};

/** `5.2 kn` or `48 km/h`. */
export const formatSpeed = (mps: number, units: TrackUnits): string =>
  units === 'nautical' ? `${(mps / KNOT_MPS).toFixed(1)} kn` : `${(mps / KMH_MPS).toFixed(mps / KMH_MPS < 10 ? 1 : 0)} km/h`;
