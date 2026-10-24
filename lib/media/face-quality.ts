/**
 * Is a detection a usable face? The quality gate in front of recognition.
 *
 * A detection that passes is stored as a face — a region with an embedding — and votes in
 * recognition. One that fails is not stored at all by `detect-faces`; the migration keeps a failed
 * detection only when a human or a legacy tag gave it a person, as a plain region without a vector.
 *
 * Below confidence 0.7 a face's nearest neighbour is far less often the same person, and weak
 * faces become hubs that pull strangers toward their person. Above it, small faces vote as well
 * as large ones, and the turn only hurts near profile. Backs of heads come out at low confidence;
 * their landmarks are symmetric guesses, so the turn does not catch them.
 *
 * Pure: no VFS, no config reads, so the fast test tier covers it. `canSeedPerson` in
 * `@archive/media/face-assign` (may this face start a new identity) and the cover ranking in
 * `@archive/people/cover` (is it a good portrait) are separate, stricter questions.
 */

import { type Dims, type FracBox, toPixels } from '@archive/media/orientation';

type QualityLimits = {
  /** Minimum detector confidence. */
  minConfidence: number;
  /** Minimum shorter side of the box, in display-frame pixels. */
  minSize: number;
  /** Maximum head turn in degrees, estimated from the landmarks (`landmarkYaw`). */
  maxYaw: number;
};

export const DEFAULT_QUALITY_LIMITS: QualityLimits = { minConfidence: 0.7, minSize: 24, maxYaw: 80 };

export type QualityReason = 'confidence' | 'size' | 'yaw';

type Quality = { ok: true } | { ok: false; reason: QualityReason };

/** What the gate reads off a detection: everything a face region stores. */
type Detection = {
  confidence?: number;
  faceBox?: FracBox;
  landmarks?: ReadonlyArray<readonly [number, number] | number[]> | null;
};

/**
 * The head's left/right turn in degrees, from the detector's five landmarks, or undefined when
 * there are none to read.
 *
 * In the face's own frame — rotated so the eyes are level, which takes out a tilted head — the
 * nose sits on the midline between the eyes and mouth corners when the face is frontal and moves
 * toward one side as the head turns. Its offset in half eye-distances is about `tan(yaw)` for a
 * human head, whose nose sticks out roughly as far as the eyes sit from the midline. Bucketed by
 * this value, faces read as three-quarter views at 50–60°, near profiles at 70–80° and full
 * profiles beyond. EMS's own `pose` is not used even where stored: the limit is calibrated on
 * this estimate, and it is available on every detection.
 *
 * Points are fractions of the display frame, so they are scaled to it first: on a wide picture an
 * unscaled fraction would read a frontal face as turned.
 */
export const landmarkYaw = (landmarks: Detection['landmarks'], dims: Dims | undefined): number | undefined => {
  if (!landmarks || landmarks.length !== 5 || !dims) return undefined;
  const points = landmarks.map(([x, y]) => [x * dims.width, y * dims.height] as const);
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return undefined;
  const [leftEye, rightEye, nose, leftMouth, rightMouth] = points;
  const ex = rightEye[0] - leftEye[0], ey = rightEye[1] - leftEye[1];
  const eyeDistance = Math.hypot(ex, ey);
  if (!(eyeDistance > 0)) return undefined;
  const cos = ex / eyeDistance, sin = ey / eyeDistance;
  // Distance along the eye line from the left eye.
  const along = ([x, y]: readonly [number, number]) => (x - leftEye[0]) * cos + (y - leftEye[1]) * sin;
  const midline = (along(leftEye) + along(rightEye) + along(leftMouth) + along(rightMouth)) / 4;
  const offset = (along(nose) - midline) / (eyeDistance / 2);
  return Math.atan(offset) * 180 / Math.PI;
};

/**
 * Whether a detection is good enough to be a face, and if not, the first limit it failed.
 *
 * Unknown frame dimensions skip the size limit and missing landmarks skip the turn limit: a
 * missing measurement is not evidence of a bad face, and refusing it would drop faces for a
 * reason that has nothing to do with them.
 */
export const recognizable = (detection: Detection, dims: Dims | undefined, limits: QualityLimits = DEFAULT_QUALITY_LIMITS): Quality => {
  if ((detection.confidence ?? 0) < limits.minConfidence) return { ok: false, reason: 'confidence' };
  if (detection.faceBox && dims) {
    const pixels = toPixels(detection.faceBox, dims);
    if (Math.min(pixels.width, pixels.height) < limits.minSize) return { ok: false, reason: 'size' };
  }
  const yaw = landmarkYaw(detection.landmarks, dims);
  if (yaw !== undefined && Math.abs(yaw) > limits.maxYaw) return { ok: false, reason: 'yaw' };
  return { ok: true };
};

/**
 * The limits from the archive's settings (`CFG_FACE_MIN_CONFIDENCE`, `CFG_FACE_MIN_SIZE`,
 * `CFG_FACE_MAX_YAW`), each falling back to its default when unset or not a number.
 */
export const qualityLimitsFrom = (env: Record<string, string | undefined>): QualityLimits => {
  const read = (key: string, fallback: number) => {
    const value = parseFloat(env[key] ?? '');
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    minConfidence: read('CFG_FACE_MIN_CONFIDENCE', DEFAULT_QUALITY_LIMITS.minConfidence),
    minSize: read('CFG_FACE_MIN_SIZE', DEFAULT_QUALITY_LIMITS.minSize),
    maxYaw: read('CFG_FACE_MAX_YAW', DEFAULT_QUALITY_LIMITS.maxYaw),
  };
};
