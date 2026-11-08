/**
 * When two media files are the same picture or recording in other bytes — a re-encode, a
 * downscale, a crop, a copy saved by another app — and when they are not, however alike they look:
 * two shots of a burst. Pure: the near check (`@archive/staging/duplicates`) hands in what it read.
 *
 * A picture's likeness is the cosine of the two files' SSCD fingerprints (`sscd-image`), a
 * descriptor trained for copy detection: a copy scores high whatever its size or encoding, a crop
 * lower the more it cuts away, and another photo of the same scene low. That leaves bursts, whose
 * frames can look as alike as a copy does, and those are told apart by when and how they were
 * taken:
 *
 * - two capture times read from the same kind of clock (both the camera's, or both GPS) a second
 *   or more apart are two shots. Two copies of one picture can carry one reading of the camera's
 *   clock that two guesses of its time zone made into two instants, so the times are a second
 *   apart only when both the instants and the readings are;
 * - two frames of one size from one camera in the same second are two shots when their sub-second
 *   times differ, and one capture when both have the same one (an edit keeps it: a filter, a
 *   mirror, black and white). With no sub-second time to tell, they are taken for one picture only
 *   when they are as alike as a re-save (`NEAR.burstScore`).
 *
 * A video is alike another when most of its keyframes (`NEAR.keyframeShare`) each have a keyframe
 * of the other at `NEAR.video` or above, and the two last as long, give or take
 * `NEAR.durationSeconds` or `NEAR.durationShare`. A recording is alike another when their
 * chromaprints, aligned, are at least `NEAR.audio` alike (`@media/chromaprint`) and they
 * last as long. Neither is alike another timed a second or more apart by one kind of clock.
 */

/** The constants of the rules. */
export const NEAR = {
  /** Picture fingerprints at least this alike are one picture. */
  image: 0.75,
  /** A video keyframe at least this alike to one of the other video's matches it. */
  video: 0.80,
  /** Recordings whose aligned chromaprints are at least this alike are one recording. */
  audio: 0.70,
  /** The share of a video's keyframes that must match. */
  keyframeShare: 0.75,
  /** Frames of a possible burst with no sub-second time must be at least this alike. */
  burstScore: 0.95,
  /**
   * A look-alike set is resolved in bulk only when all its pairs are at least this alike. A
   * re-encode or downscale scores above it; below it are the near shots a person tells apart (on
   * fry, a frame named `-2` taken in the same second as the library's scored 0.81).
   */
  bulkScore: 0.95,
  /** Capture times this many seconds apart or more, from one kind of clock, are two shots. */
  momentSeconds: 1,
  /** Two videos' lengths may differ by this many seconds, or by this share of the longer, whichever is more. */
  durationSeconds: 1,
  durationShare: 0.02,
  /** A file that looks like this many others or more is a hub, alike to none. */
  hub: 30,
  /**
   * Fingerprints asked of the index per print: more than a hub's, because the index's walk is
   * approximate and a wider one passes over fewer copies.
   */
  candidates: 100,
  /** Look-alikes a finding keeps at most. */
  peers: 29,
  /** Capture times this many seconds either side of a file's are looked through too. */
  windowSeconds: 2,
  /** Files of that window looked at at most. */
  windowRows: 200,
  /** Recordings of about a recording's length looked through at most, and of those compared. */
  lengthRows: 2_000,
  recordings: 200,
} as const;

/** What the rules read of one file. */
export type NearFacts = {
  id: string;
  mimetype?: string;
  /** The picture's size as shown: its raster turned by its angle. */
  width?: number;
  height?: number;
  takenAtUtc?: string;
  takenAtSource?: string;
  /** The capture time as the clock read it, without its offset (`takenAt`'s wall clock). */
  clock?: string;
  /** The camera, by its camera node's path, when it is known. */
  camera?: string;
  /** The capture time's fraction of a second (EXIF `SubSecTimeOriginal`), when the file has one. */
  subSecond?: string;
  /** A recording's length, in seconds. */
  duration?: number;
};

/** The sources of a capture time that are a clock running at the moment of capture. */
const CLOCKS = new Set(['camera', 'gps']);

/** A vector as an embedding node holds it: its JSON text. Undefined for anything else. */
export const parseVector = (bytes: Uint8Array): number[] | undefined => {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === 'number') ? value : undefined;
  } catch {
    return undefined;
  }
};

/** The cosine of two vectors of one length; 0 when either is all zeros. */
export const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/** The display size of a raster `width`×`height` turned by `angle` degrees. */
export const displaySize = (width: unknown, height: unknown, angle: unknown): { width?: number; height?: number } => {
  if (typeof width !== 'number' || typeof height !== 'number') return {};
  const quarter = typeof angle === 'number' && Math.abs(angle) % 180 === 90;
  return quarter ? { width: height, height: width } : { width, height };
};

const seconds = (iso: string | undefined): number | undefined => {
  const ms = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms / 1000;
};

/** A clock reading to the second, as seconds on a scale of its own; undefined for anything coarser. */
const readingSeconds = (clock: string | undefined): number | undefined =>
  clock !== undefined && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(clock) ? seconds(`${clock}Z`) : undefined;

/**
 * How many seconds apart `a` and `b` were taken, both timed by a clock of one kind: the lesser of
 * the gap between their instants and the gap between their readings. Undefined when they were not
 * timed so, or nothing says.
 */
const clockGap = (a: NearFacts, b: NearFacts): number | undefined => {
  if (!CLOCKS.has(a.takenAtSource ?? '') || a.takenAtSource !== b.takenAtSource) return undefined;
  const gaps: number[] = [];
  const ta = seconds(a.takenAtUtc);
  const tb = seconds(b.takenAtUtc);
  if (ta !== undefined && tb !== undefined) gaps.push(Math.abs(ta - tb));
  const ca = readingSeconds(a.clock);
  const cb = readingSeconds(b.clock);
  if (ca !== undefined && cb !== undefined) gaps.push(Math.abs(ca - cb));
  return gaps.length > 0 ? Math.min(...gaps) : undefined;
};

/**
 * Whether `a` and `b` were taken at two moments: both timed by a clock of one kind, a second or
 * more apart, or — one size, one camera, the same second — with sub-second times that differ.
 * False when nothing says so.
 */
const twoMoments = (a: NearFacts, b: NearFacts): boolean => {
  const gap = clockGap(a, b);
  if (gap === undefined) return false;
  if (gap >= NEAR.momentSeconds) return true;
  return sameShot(a, b) && a.subSecond !== undefined && b.subSecond !== undefined && a.subSecond !== b.subSecond;
};

/**
 * Whether `a` and `b` could be two frames of one burst: one size, from one camera (or neither
 * says which), timed by one kind of clock within the same second.
 */
export const sameShot = (a: NearFacts, b: NearFacts): boolean => {
  if (a.width === undefined || a.width !== b.width || a.height !== b.height) return false;
  if (a.camera !== b.camera) return false;
  const gap = clockGap(a, b);
  return gap !== undefined && gap < NEAR.momentSeconds;
};

/**
 * Whether `a` and `b`, two frames of one shot (`sameShot`), carry the same sub-second time: one
 * capture, as no burst takes two frames in one hundredth of a second. A time of only zeros says
 * nothing, as some cameras write it for every frame.
 */
const oneCapture = (a: NearFacts, b: NearFacts): boolean => a.subSecond !== undefined && a.subSecond === b.subSecond && !/^0+$/.test(a.subSecond);

/** Whether two pictures, their fingerprints `score` alike, are one picture. */
export const nearPictures = (a: NearFacts, b: NearFacts, score: number): boolean => {
  if (score < NEAR.image || twoMoments(a, b)) return false;
  return !sameShot(a, b) || oneCapture(a, b) || score >= NEAR.burstScore;
};

/** Whether two recordings last as long, as `NEAR` allows. True when either length is unknown. */
export const sameLength = (a: number | undefined, b: number | undefined): boolean => {
  if (a === undefined || b === undefined) return true;
  return Math.abs(a - b) <= Math.max(NEAR.durationSeconds, NEAR.durationShare * Math.max(a, b));
};

/**
 * How many of `own`'s keyframes some keyframe of `other` matches, as a share, and the best match:
 * the vote two videos are compared by.
 */
export const keyframeVote = (own: readonly (readonly number[])[], other: readonly (readonly number[])[]): { share: number; best: number } => {
  if (own.length === 0 || other.length === 0) return { share: 0, best: 0 };
  let matched = 0;
  let best = 0;
  for (const frame of own) {
    const top = Math.max(...other.map((each) => cosine(frame, each)));
    best = Math.max(best, top);
    if (top >= NEAR.video) matched++;
  }
  return { share: matched / own.length, best };
};

/** Whether two videos, voted on as `keyframeVote` does, are one recording. */
export const nearVideos = (a: NearFacts, b: NearFacts, vote: { share: number }): boolean =>
  vote.share >= NEAR.keyframeShare && sameLength(a.duration, b.duration) && !twoMoments(a, b);

/** Whether two recordings, their aligned chromaprints `similarity` alike, are one recording. */
export const nearRecordings = (a: NearFacts, b: NearFacts, similarity: number): boolean => similarity >= NEAR.audio && sameLength(a.duration, b.duration) && !twoMoments(a, b);

/**
 * The lengths a recording `duration` seconds long may be alike to, as `sameLength` allows: from
 * the shortest whose own allowance reaches it to the longest within its own.
 */
export const lengthWindow = (duration: number): { from: number; to: number } => ({
  from: Math.min(duration - NEAR.durationSeconds, duration * (1 - NEAR.durationShare)),
  to: Math.max(duration + NEAR.durationSeconds, duration / (1 - NEAR.durationShare)),
});

/** A verified look-alike, as the check ranks them: the most alike first, then by id. */
type NearMatch = { id: string; score: number };

/** `matches` ranked, at most `NEAR.peers`; none for a hub (`NEAR.hub` matches or more). */
export const rankPeers = (matches: readonly NearMatch[]): { peers: NearMatch[]; hub: boolean } => {
  if (matches.length >= NEAR.hub) return { peers: [], hub: true };
  const ranked = [...matches].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { peers: ranked.slice(0, NEAR.peers), hub: false };
};
