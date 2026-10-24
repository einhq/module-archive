/**
 * Head pose across a change of display frame. Pure unit tests, fast tier.
 */

import { assertEquals } from '@std/assert';
import type { Angle } from '@archive/media/orientation';
import { type FacePose, isFacePose, remapPose, storedPose } from '@archive/media/face-pose';

const frame = (angle: Angle, mirror = false) => ({ angle, mirror });
const POSE: FacePose = { pitch: -5, yaw: 20, roll: 10 };

Deno.test('a quarter turn of the frame turns roll with it and leaves pitch and yaw alone', () => {
  const turned = remapPose(POSE, frame(0), frame(90));
  assertEquals(turned.pitch, -5);
  assertEquals(turned.yaw, 20);
  assertEquals(Math.abs(turned.roll - POSE.roll), 90);
  assertEquals(remapPose(POSE, frame(0), frame(180)).roll, -170);
});

Deno.test('a mirror flips the turn and the tilt', () => {
  assertEquals(remapPose(POSE, frame(0), frame(0, true)), { pitch: -5, yaw: -20, roll: -10 });
});

Deno.test('every change of frame undoes itself', () => {
  const frames = [0, 90, 180, 270].flatMap((angle) => [frame(angle as Angle), frame(angle as Angle, true)]);
  for (const from of frames) {
    for (const to of frames) {
      assertEquals(remapPose(remapPose(POSE, from, to), to, from), POSE, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    }
  }
});

Deno.test('storedPose keeps a well-formed pose, rounded, and drops anything else', () => {
  assertEquals(storedPose({ pitch: 1.234, yaw: -12.26, roll: 0 }), { pitch: 1.2, yaw: -12.3, roll: 0 });
  assertEquals(storedPose({ pitch: 1, yaw: 'x', roll: 0 }), null);
  assertEquals(storedPose(undefined), null);
  assertEquals(isFacePose({ pitch: 0, yaw: 0, roll: Number.NaN }), false);
});
