/**
 * A video face's track: its box at the moments EMS kept, a line each — every sample while the
 * face moves, about one a second while it stands still. Between two of them the box slides from
 * one to the next, so it follows the face while the video plays; outside the face's appearances
 * there is no box.
 */

import type { FaceBox } from '@archive/media/api';

/** `@archive/media/regions`' FACE_TRACK_NAME is the authority. */
export const FACE_TRACK_NAME = 'track';

/** One sighting: `[t, x, y, width, height]`, seconds and fractions of the display frame. */
export type TrackPoint = [number, number, number, number, number];

/** The sightings of a track file in time order; a line that is not one is left out. */
export const parseTrack = (text: string): TrackPoint[] =>
  text
    .split('\n')
    .flatMap((line): TrackPoint[] => {
      try {
        const point = JSON.parse(line);
        return Array.isArray(point) && point.length === 5 && point.every((v) => typeof v === 'number' && Number.isFinite(v)) ? [point as TrackPoint] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a[0] - b[0]);

const boxOf = ([, x, y, width, height]: TrackPoint): FaceBox => ({ x, y, width, height });

/**
 * The longest step between two sightings of a face it was seen throughout: EMS keeps one at
 * least every second while it sees the face. A longer step is a stretch it went unseen in —
 * turned away, or behind somebody — and a box slid across it would trail over the back of a
 * head or whoever stood in front.
 */
const SEEN_STEP_SECONDS = 1.01;
/** How long the box stays at either end of a stretch the face went unseen in. */
const UNSEEN_HOLD_SECONDS = 0.25;

/**
 * Where the face is at `t` seconds. Within one of its appearances the box is interpolated
 * between the sightings either side; in the stretch before the first or after the last of them
 * it stays on the nearest. Where the face went unseen between two sightings the box stays on
 * each for a moment and is otherwise gone. Undefined while the face is off screen.
 */
export const boxAt = (track: TrackPoint[], appearances: [number, number][], t: number): FaceBox | undefined => {
  const span = appearances.find(([start, end]) => start <= t && t <= end);
  if (!span) return undefined;
  let before: TrackPoint | undefined;
  let after: TrackPoint | undefined;
  for (const point of track) {
    if (point[0] < span[0] || point[0] > span[1]) continue;
    if (point[0] <= t) before = point;
    else {
      after = point;
      break;
    }
  }
  if (!before || !after) {
    const only = before ?? after;
    return only ? boxOf(only) : undefined;
  }
  if (after[0] - before[0] > SEEN_STEP_SECONDS) {
    if (t - before[0] <= UNSEEN_HOLD_SECONDS) return boxOf(before);
    if (after[0] - t <= UNSEEN_HOLD_SECONDS) return boxOf(after);
    return undefined;
  }
  const w = (t - before[0]) / (after[0] - before[0]);
  const mix = (i: number) => before[i] + (after[i] - before[i]) * w;
  return { x: mix(1), y: mix(2), width: mix(3), height: mix(4) };
};
