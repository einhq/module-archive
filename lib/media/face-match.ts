/**
 * Face box matching — pure geometry, no VFS/IO, so it is unit-testable in the
 * fast tier. Used by `tag-transfer` to pair a legacy manual face tag (a
 * hand-drawn box carrying a `personId` but no embedding) with the
 * auto-detected face in the same image (an aligned 512-d embedding but no
 * `personId`), so the tag's identity lands on a face the recognizer can match.
 *
 * The rule is containment, not overlap. Manual boxes were drawn loosely around
 * a head, while InsightFace returns a tight box on the face, so the detection
 * for the tagged person sits wholly inside the manual box — and a detection
 * with a corner sticking out is somebody else's face brushing the edge. Among
 * the detections inside one box the largest is the person the box was drawn
 * around; the smaller ones are faces in the background behind them.
 */

export type Box = { x: number; y: number; width: number; height: number };

type BoxMatch = {
  manualIndex: number;
  autoIndex: number;
  /** Share of the detection inside the manual box: 1 unless a margin let a corner out. */
  score: number;
  iou: number;
  coverage: number;
};

type MatchOptions = {
  /**
   * How far a detection's edge may sit outside the manual box and still count as inside, as a
   * fraction of the manual box's width (horizontally) or height (vertically). 0 is strict.
   */
  margin: number;
  /**
   * The narrowest the chosen detection may be, as a fraction of the manual box's width. A box
   * drawn round a person's head holds their face at about 0.42 of its width;
   * a much smaller face inside it is somebody in the background — the tagged person had their
   * back to the camera, say — and handing them the name makes a stranger an anchor. 0 checks
   * nothing.
   */
  minScale?: number;
};

/** `MatchOptions.minScale` as calibrated: below it, a transfer is too often wrong. */
export const DEFAULT_MIN_SCALE = 0.15;

/** Absorbs the rounding of boxes stored as six-decimal fractions. */
const EPSILON = 1e-9;

const area = (b: Box): number => Math.max(0, b.width) * Math.max(0, b.height);

const intersectionArea = (a: Box, b: Box): number => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - x) * Math.max(0, bottom - y);
};

/** Intersection over union, 0 when either box is degenerate. */
export const iou = (a: Box, b: Box): number => {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
};

/** Share of `inner` that lies inside `outer` (1 = fully contained). */
export const coverage = (inner: Box, outer: Box): number => {
  const innerArea = area(inner);
  if (innerArea === 0) return 0;
  return intersectionArea(inner, outer) / innerArea;
};

/** Every corner of `inner` lies inside `outer`, the latter widened by `margin` on each side. */
export const contains = (outer: Box, inner: Box, margin = 0): boolean => {
  if (area(inner) === 0) return false;
  const dx = margin * outer.width + EPSILON;
  const dy = margin * outer.height + EPSILON;
  return inner.x >= outer.x - dx &&
    inner.y >= outer.y - dy &&
    inner.x + inner.width <= outer.x + outer.width + dx &&
    inner.y + inner.height <= outer.y + outer.height + dy;
};

/** Why a manual tag was left alone instead of paired. */
type AmbiguityReason =
  /** No detection lies inside this tag's box. */
  | 'none'
  /** The largest detections inside this tag's box are the same size, so no one is in front. */
  | 'multi-auto'
  /** More than one tag picked this tag's detection. */
  | 'multi-manual'
  /** The largest detection inside the box is too small to be the face it was drawn around. */
  | 'too-small';

type Ambiguity = { manualIndex: number; reason: AmbiguityReason };

type MatchResult = {
  matches: BoxMatch[];
  ambiguous: Ambiguity[];
};

/**
 * Pair manual tags with detections: the largest detection inside each tag's box, as long as no
 * other tag picked the same one.
 *
 * A detection that crosses the box's edge is ignored outright rather than scored down. A loose
 * box around one head does not cut through the face it was drawn around, so whatever it does cut
 * through is a neighbour — and a neighbour with a large overlap is precisely the pair IoU gets
 * wrong. Two detections wholly inside is the ordinary case of someone standing behind the
 * tagged person, and the one in front is the bigger box; only an exact tie in size is left for a
 * human, since nothing here can say who is in front. Two tags picking one detection is the other
 * coin flip — one of those people is not in that box — and both are left alone. So is a tag
 * whose largest detection is far smaller than the box (`minScale`): only background faces are in it.
 */
export const matchFacesUnique = (
  manual: Box[],
  auto: Box[],
  opts: MatchOptions,
): MatchResult => {
  const picks = new Map<number, BoxMatch>();
  const ambiguous: Ambiguity[] = [];

  for (let m = 0; m < manual.length; m++) {
    let best: number | undefined;
    let tied = false;
    for (let a = 0; a < auto.length; a++) {
      if (!contains(manual[m], auto[a], opts.margin)) continue;
      if (best === undefined || area(auto[a]) > area(auto[best]) + EPSILON) {
        best = a;
        tied = false;
      } else if (Math.abs(area(auto[a]) - area(auto[best])) <= EPSILON) {
        tied = true;
      }
    }
    if (best === undefined) {
      ambiguous.push({ manualIndex: m, reason: 'none' });
      continue;
    }
    if (tied) {
      ambiguous.push({ manualIndex: m, reason: 'multi-auto' });
      continue;
    }
    if (opts.minScale && manual[m].width > 0 && auto[best].width / manual[m].width < opts.minScale) {
      ambiguous.push({ manualIndex: m, reason: 'too-small' });
      continue;
    }
    const contained = coverage(auto[best], manual[m]);
    picks.set(m, { manualIndex: m, autoIndex: best, score: contained, iou: iou(manual[m], auto[best]), coverage: contained });
  }

  const claims = new Map<number, number>();
  for (const p of picks.values()) claims.set(p.autoIndex, (claims.get(p.autoIndex) ?? 0) + 1);

  const matches: BoxMatch[] = [];
  for (const p of picks.values()) {
    if ((claims.get(p.autoIndex) ?? 0) > 1) ambiguous.push({ manualIndex: p.manualIndex, reason: 'multi-manual' });
    else matches.push(p);
  }
  ambiguous.sort((a, b) => a.manualIndex - b.manualIndex);

  return { matches, ambiguous };
};
