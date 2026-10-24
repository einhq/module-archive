/**
 * Head pose: which way a detected face is turned, as EMS's `faces.detect` reports it.
 *
 * Degrees, from InsightFace buffalo_l's 3D landmark model, in the **display frame** the face was
 * detected in: `pitch` is up/down, `yaw` a left/right turn, `roll` a tilt; all three 0 is a face
 * looking straight into the camera. Stored on the face node as `pose` beside `faceBox` and
 * `landmarks`. Faces stored without one, and hand-drawn boxes, have none — readers treat a
 * missing pose as unknown, never as frontal.
 *
 * The convention matters for one thing only, carrying a pose across a change of frame
 * (`file-set-orientation`). InsightFace takes roll as `atan2(R[1][0], R[0][0])` of the rotation
 * that maps its mean face onto the image, in image coordinates with y down — the angle of the
 * head's own x-axis measured clockwise on screen. Turning the frame turns that axis with it;
 * mirroring it mirrors the axis and flips the turn. Pitch, being about the head's own x-axis,
 * is the same in every frame.
 */

import { type Angle, type FracPoint, pointDisplayToRaw, pointRawToDisplay } from '@archive/media/orientation';

export type FacePose = { pitch: number; yaw: number; roll: number };

type Frame = { angle: Angle; mirror: boolean };

export const isFacePose = (value: unknown): value is FacePose => {
  if (typeof value !== 'object' || value === null) return false;
  const pose = value as Record<string, unknown>;
  return ['pitch', 'yaw', 'roll'].every((key) => typeof pose[key] === 'number' && Number.isFinite(pose[key]));
};

/** The pose EMS returned, rounded for storage, or null when it returned none. */
export const storedPose = (value: unknown): FacePose | null => isFacePose(value) ? { pitch: round(value.pitch), yaw: round(value.yaw), roll: round(value.roll) } : null;

const round = (degrees: number): number => Math.round(degrees * 10) / 10;

/** An angle in (-180, 180]. */
const wrap = (degrees: number): number => {
  const d = ((degrees % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};

/**
 * A pose moved from one display frame to another, the way `file-set-orientation` moves boxes
 * and landmarks: through the raw raster, which is the frame that never changes.
 *
 * The change of frame is read off where it sends two unit directions. Every change here is a
 * quarter turn, a mirror or both, so an axis goes to an axis whatever the two frames' aspect
 * ratios, and the angle and handedness come out exact.
 */
export const remapPose = (pose: FacePose, from: Frame, to: Frame): FacePose => {
  const move = (point: FracPoint): FracPoint => pointRawToDisplay(pointDisplayToRaw(point, from.angle, from.mirror), to.angle, to.mirror);
  const origin = move([0.5, 0.5]);
  const xAxis = move([0.75, 0.5]);
  const yAxis = move([0.5, 0.75]);
  const ex = [xAxis[0] - origin[0], xAxis[1] - origin[1]];
  const ey = [yAxis[0] - origin[0], yAxis[1] - origin[1]];
  // Clockwise on screen, since y points down.
  const turn = Math.atan2(ex[1], ex[0]) * 180 / Math.PI;
  const mirrored = ex[0] * ey[1] - ex[1] * ey[0] < 0;
  if (!mirrored) return { pitch: pose.pitch, yaw: pose.yaw, roll: round(wrap(pose.roll + turn)) };
  // A mirror sends the head's x-axis the other way and turns a left turn into a right one.
  return { pitch: pose.pitch, yaw: round(-pose.yaw), roll: round(wrap(turn + 180 - pose.roll)) };
};
