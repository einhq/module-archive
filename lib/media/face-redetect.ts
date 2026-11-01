/**
 * What a re-detection does with the faces a file already has: pure, so it is testable in the fast
 * tier. `detect-faces -f` runs it when the face models changed (`media.faces.stale`) and when
 * somebody asks for fresh detections.
 *
 * Every face is found again, and each new one continues the old region it is the same face as —
 * the same box on a photo, the same box at the same moment on a video — so the region keeps its
 * name, and with it its person, its doubt and every reference to it (a person's representative
 * face, a cover, a voice seen speaking with it). Only what the detector says is replaced: the box,
 * the points, the pose, the confidence and the vector. An old region the new detector does not
 * find keeps its box and its person as a tag, without a vector, when a person decided who it is;
 * one only a machine named, or nobody, goes.
 */

import { type Box, iou, SAME_FACE_IOU } from '@archive/media/face-match';
import { DETECTED_PREFIX, isMarkedDoubt, MACHINE_SOURCES, type RegionAttrs } from '@archive/media/regions';

/** An old `face-<n>` region: its name and attrs. */
type OldFace = { name: string; attrs: RegionAttrs };

/** A new detection: its box and, on a video, the second the box is of and its path. */
type NewFace = { box: Box; at?: number; track?: [number, number, number, number, number][] };

type RedetectPlan = {
  /** New face index → the old region it continues. */
  continues: Map<number, string>;
  /** Old regions kept as named tags: their vector and track go, the box and the person stay. */
  kept: string[];
  /** Old regions that go, with the person each held, if any. */
  removed: { name: string; personId?: string }[];
  /** New face index → the name of the region it is created as. */
  created: Map<number, string>;
};

/** Whether a person decided something about this region that a new detection must not lose. */
export const isHeldFace = (attrs: RegionAttrs): boolean =>
  (typeof attrs.personId === 'string' && attrs.personId !== '' && !MACHINE_SOURCES.has(attrs.personSource ?? '')) ||
  attrs.assignLocked === true ||
  (Array.isArray(attrs.rejectedPersonIds) && attrs.rejectedPersonIds.length > 0) ||
  (!!attrs.doubt && isMarkedDoubt(attrs.doubt));

/**
 * The new face's box at `at` seconds: its track's sample nearest `at` within `tolerance`, or its
 * stored box when it was seen then. Undefined when it was not on screen near `at`.
 */
const boxAt = (face: NewFace, at: number, tolerance: number): Box | undefined => {
  if (face.at !== undefined && Math.abs(face.at - at) <= tolerance) return face.box;
  let best: [number, number, number, number, number] | undefined;
  for (const sample of face.track ?? []) {
    if (Math.abs(sample[0] - at) <= tolerance && (!best || Math.abs(sample[0] - at) < Math.abs(best[0] - at))) best = sample;
  }
  return best && { x: best[1], y: best[2], width: best[3], height: best[4] };
};

/** How well a new face is the old region's: the overlap of their boxes, on a video at the old box's moment. */
const overlap = (old: RegionAttrs, face: NewFace, tolerance: number): number => {
  if (!old.faceBox) return 0;
  if (old.atSeconds === undefined) return face.at === undefined ? iou(old.faceBox, face.box) : 0;
  const box = boxAt(face, old.atSeconds, tolerance);
  return box ? iou(old.faceBox, box) : 0;
};

/** The index `face-<n>` names, or -1 for another name. */
const indexOf = (name: string): number => {
  const suffix = Number(name.slice(DETECTED_PREFIX.length));
  return name.startsWith(DETECTED_PREFIX) && Number.isInteger(suffix) && suffix >= 0 ? suffix : -1;
};

/**
 * Pair the old regions with the new faces, best overlap first and each at most once, and say what
 * becomes of every region. A new face that continues none is created as a `face-<n>` no old region
 * had, so a removed region's name never comes back on another face. `tolerance` is how far apart,
 * in seconds, a video's old box and a sample of the new path may be: the sampling interval.
 */
export const planRedetection = (old: OldFace[], next: NewFace[], tolerance = 0): RedetectPlan => {
  const pairs: { oldIndex: number; newIndex: number; score: number }[] = [];
  old.forEach((region, oldIndex) => {
    next.forEach((face, newIndex) => {
      const score = overlap(region.attrs, face, tolerance);
      if (score >= SAME_FACE_IOU) pairs.push({ oldIndex, newIndex, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const continues = new Map<number, string>();
  const matched = new Set<number>();
  for (const { oldIndex, newIndex } of pairs) {
    if (matched.has(oldIndex) || continues.has(newIndex)) continue;
    matched.add(oldIndex);
    continues.set(newIndex, old[oldIndex].name);
  }

  const kept: string[] = [];
  const removed: { name: string; personId?: string }[] = [];
  old.forEach((region, index) => {
    if (matched.has(index)) return;
    if (isHeldFace(region.attrs) && region.attrs.faceBox) kept.push(region.name);
    else removed.push({ name: region.name, ...(region.attrs.personId ? { personId: region.attrs.personId } : {}) });
  });

  let free = Math.max(-1, ...old.map((region) => indexOf(region.name))) + 1;
  const created = new Map<number, string>();
  next.forEach((_, index) => {
    if (!continues.has(index)) created.set(index, `${DETECTED_PREFIX}${free++}`);
  });
  return { continues, kept, removed, created };
};
