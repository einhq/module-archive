/**
 * How a device moves, and what that means for reading its track (`@archive/location/track-profile`).
 *
 * A device's `kind` picks one profile: the thresholds that tell a stop from drift and a trip from a
 * rest, and the units its distances and speeds are shown in. A device with no kind reads as a car.
 * Imports nothing, so the bins and the UI share it.
 */

/** What a device travels as. */
export const DEVICE_KINDS = ['boat', 'car', 'bike', 'foot'] as const;
export type DeviceKind = typeof DEVICE_KINDS[number];

/** How each kind is named to a person. */
export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = { boat: 'Boat', car: 'Car', bike: 'Bike', foot: 'On foot' };

export const isDeviceKind = (value: unknown): value is DeviceKind => (DEVICE_KINDS as readonly unknown[]).includes(value);

/** Nautical (knots and nautical miles) or metric (km/h and km). */
type TrackUnits = 'nautical' | 'metric';

type TrackProfile = {
  kind: DeviceKind;
  /** A stop's fixes stay within this many metres of where it began; wider is GPS drift no more. */
  driftRadiusM: number;
  /** How long the device has to stay within the drift radius before it counts as stopped. */
  stillMinMs: number;
  /** At or under this speed, in m/s, the device counts as lying still. */
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

const PROFILES: Record<DeviceKind, TrackProfile> = {
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

/** The profile of a device of this kind; anything that is not a kind reads as a car. */
export const trackProfile = (kind?: unknown): TrackProfile => PROFILES[isDeviceKind(kind) ? kind : 'car'];

/** `12.4 nm` or `23.0 km`; under one unit with one decimal more. */
export const formatDistance = (metres: number, units: TrackUnits): string => {
  const value = metres / (units === 'nautical' ? 1852 : 1000);
  return `${value.toFixed(value < 1 ? 2 : 1)} ${units === 'nautical' ? 'nm' : 'km'}`;
};

/** `5.2 kn` or `48 km/h`. */
export const formatSpeed = (mps: number, units: TrackUnits): string =>
  units === 'nautical' ? `${(mps / KNOT_MPS).toFixed(1)} kn` : `${(mps / KMH_MPS).toFixed(mps / KMH_MPS < 10 ? 1 : 0)} km/h`;
