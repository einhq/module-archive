/**
 * The quality gate in front of recognition, and the per-node decisions of the migration that
 * applies it to faces stored before it. Pure — fast tier, no VFS.
 */

import { assertAlmostEquals, assertEquals } from '@std/assert';
import { DEFAULT_QUALITY_LIMITS, landmarkYaw, qualityLimitsFrom, recognizable } from '../../lib/media/face-quality.ts';

const DIMS = { width: 1000, height: 1000 };
const BOX = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 };

/** Five landmarks of a face in the unit box at (x, y), turned so the nose sits `offset` half eye-distances off the midline. */
const turned = (offset: number, x = 0.4, y = 0.4): [number, number][] => {
  const eye = 0.03; // half the eye distance
  return [
    [x + 0.05 - eye, y + 0.04],
    [x + 0.05 + eye, y + 0.04],
    [x + 0.05 + offset * eye, y + 0.06],
    [x + 0.05 - eye * 0.8, y + 0.08],
    [x + 0.05 + eye * 0.8, y + 0.08],
  ];
};

Deno.test('landmarkYaw: frontal is 0, the nose off the midline is a turn', () => {
  assertAlmostEquals(landmarkYaw(turned(0), DIMS)!, 0, 1e-9);
  assertAlmostEquals(landmarkYaw(turned(1), DIMS)!, 45, 1e-9);
  assertAlmostEquals(landmarkYaw(turned(-Math.sqrt(3)), DIMS)!, -60, 1e-9);
});

Deno.test('landmarkYaw: a tilted head is not a turned one', () => {
  // The same frontal face rotated 30° in the picture plane.
  const angle = Math.PI / 6;
  const rotate = ([x, y]: [number, number]): [number, number] => {
    const dx = x - 0.45, dy = y - 0.45;
    return [0.45 + dx * Math.cos(angle) - dy * Math.sin(angle), 0.45 + dx * Math.sin(angle) + dy * Math.cos(angle)];
  };
  assertAlmostEquals(landmarkYaw(turned(0).map(rotate), DIMS)!, 0, 1e-9);
});

Deno.test('landmarkYaw: fractions are scaled to the frame before they are compared', () => {
  // On a 2:1 frame a frontal face's fractions are squashed horizontally; unscaled, the
  // eye distance would shrink against the vertical offsets and nothing would change here,
  // but a turn would read twice as large.
  const wide = { width: 2000, height: 1000 };
  const landmarks = turned(1).map(([x, y]) => [0.5 + (x - 0.5) / 2, y] as [number, number]);
  assertAlmostEquals(landmarkYaw(landmarks, wide)!, 45, 1e-9);
});

Deno.test('landmarkYaw: nothing to read gives undefined', () => {
  assertEquals(landmarkYaw(null, DIMS), undefined);
  assertEquals(landmarkYaw([[0, 0]], DIMS), undefined);
  assertEquals(landmarkYaw(turned(0), undefined), undefined);
});

Deno.test('recognizable: each limit, in order', () => {
  const ok = { confidence: 0.9, faceBox: BOX, landmarks: turned(0) };
  assertEquals(recognizable(ok, DIMS), { ok: true });
  assertEquals(recognizable({ ...ok, confidence: 0.69 }, DIMS), { ok: false, reason: 'confidence' });
  assertEquals(recognizable({ ...ok, faceBox: { ...BOX, width: 0.02 } }, DIMS), { ok: false, reason: 'size' });
  assertEquals(recognizable({ ...ok, landmarks: turned(10) }, DIMS), { ok: false, reason: 'yaw' });
  // Confidence is read first: a back of a head has symmetric landmarks and passes the turn.
  assertEquals(recognizable({ ...ok, confidence: 0.55, faceBox: { ...BOX, width: 0.01 } }, DIMS), { ok: false, reason: 'confidence' });
});

Deno.test('recognizable: a missing measurement is not a reason to refuse', () => {
  assertEquals(recognizable({ confidence: 0.9, faceBox: { ...BOX, width: 0.01 } }, undefined), { ok: true });
  assertEquals(recognizable({ confidence: 0.9, faceBox: BOX, landmarks: null }, DIMS), { ok: true });
});

Deno.test('qualityLimitsFrom reads the settings and falls back on junk', () => {
  assertEquals(qualityLimitsFrom({}), DEFAULT_QUALITY_LIMITS);
  assertEquals(qualityLimitsFrom({ CFG_FACE_MIN_CONFIDENCE: '0.8', CFG_FACE_MIN_SIZE: 'x', CFG_FACE_MAX_YAW: '60' }), { minConfidence: 0.8, minSize: 24, maxYaw: 60 });
});
