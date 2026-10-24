/**
 * The matching model's constants and its arithmetic: how evidence becomes a probability that a
 * group belongs in a library album, and how sure a match is from the best probability and its
 * margin over the next. Pure, so it is tested without a VFS.
 *
 * Each album weighed gets a logit z = b + Σ wᵢ·eᵢ over the evidence present: evidence that is
 * absent (no GPS on either side, no people) neither raises nor lowers it. The albums weighed for
 * one group and "a new album" are then one choice: album i's probability is e^zᵢ / (1 + Σ e^zⱼ),
 * and a new album's is what is left. So two albums that fit equally well share the probability
 * rather than both claiming it, and the best album's probability is how often it is the right one.
 *
 * There are two sets of constants: one for a group whose pictures were compared with the albums',
 * and one for a group with no picture vectors, which without the look would otherwise be judged
 * too unsure. Both are fitted on albums people made, held out (`auto-album-assign --holdout`);
 * `MATCH_MODEL` names them, and every stored match carries it. `duplicate` and `text` are not
 * fitted, as held-out library photos carry neither: they are set so that each alone makes an
 * album about 0.7 likely (copies of all of a group's photos) and 0.25 likely (a folder label the
 * album's title matches exactly).
 */
import type { MatchConfidence, MatchEvidence } from '@archive/staging/api';

/** The name of these constants, stored with every match so a refit can tell its own from older ones. */
export const MATCH_MODEL = 'choice-fitted-1';

type Constants = { bias: number; weights: Required<MatchEvidence> };

/** For a group whose pictures were compared: each kind of evidence's weight; an album's own breadth and an unsorted name count against it. */
const SEEN: Constants = {
  bias: -5.45,
  weights: { time: 6.66, place: 1.94, people: 1.66, visual: 3.4, duplicate: 6.3, text: 4.4, breadth: -1.71, unsorted: -0.61 },
};

/** For a group with no pictures to compare. */
const UNSEEN: Constants = {
  bias: -4.83,
  weights: { time: 6.8, place: 1.99, people: 2.01, visual: 0, duplicate: 5.7, text: 3.7, breadth: -1.81, unsorted: -1.13 },
};

/** The weights reasons are ranked by: those for a group whose pictures were compared. */
export const WEIGHTS = SEEN.weights;

/** An existing album is proposed when the best is at least this likely and this far ahead of the next. */
const PROPOSE_P = 0.5;
const PROPOSE_MARGIN = 0.1;

/** A match is sure from this probability and margin on, once sureness is enabled. */
const HIGH_P = 0.85;
const HIGH_MARGIN = 0.25;

/**
 * Whether a match may be stored as sure: only while the constants meet their bar on held-out
 * albums, an expected calibration error of at most 0.05 and sure matches right at least nine times
 * in ten. Off, a match that would be sure is stored as likely.
 */
const HIGH_ENABLED = true;

/** A lane's day is matched only to an album at least this likely. */
export const DAY_MATCH_P = 0.5;

/** Time evidence below this is no evidence of time: the album's nearest photo is many τ away. */
const TIME_SUPPORT = 0.01;

/** Ten years, in days: an album whose days span this much or more is as broad as it gets. */
const BROAD_DAYS = 3650;

/** The logit the evidence gives one album, for a group whose pictures were compared with the albums' (`seen`) or not. */
export const logitOf = (evidence: MatchEvidence, seen: boolean): number => {
  const { bias, weights } = seen ? SEEN : UNSEEN;
  let x = bias;
  for (const [key, weight] of Object.entries(weights) as [keyof MatchEvidence, number][]) {
    const value = evidence[key];
    if (value !== undefined && Number.isFinite(value)) x += weight * value;
  }
  return x;
};

/** The probability of each album of a choice by their logits, and of a new album: e^zᵢ / (1 + Σ e^zⱼ), and 1 / (1 + Σ e^zⱼ). */
export const choiceOf = (logits: readonly number[]): { p: number[]; none: number } => {
  // Scaled by the largest logit (or none's 0), so no term overflows.
  const top = Math.max(0, ...logits);
  const terms = logits.map((z) => Math.exp(z - top));
  const total = Math.exp(-top) + terms.reduce((sum, term) => sum + term, 0);
  return { p: terms.map((term) => term / total), none: Math.exp(-top) / total };
};

/** How broad an album is from the days its photos span: 0 for one day, 1 for ten years or more. */
export const breadthOf = (spanDays: number): number => Math.min(1, Math.max(0, spanDays - 1) / BROAD_DAYS);

/**
 * Whether an album has evidence of time, place, people or copies for a group. One with none, only
 * a look or a name, is never ranked first: an album years away that merely looks alike is not
 * where a group goes.
 */
export const supportedBy = (evidence: MatchEvidence): boolean =>
  (evidence.time ?? 0) >= TIME_SUPPORT || (evidence.place ?? 0) > 0 || (evidence.people ?? 0) > 0 || (evidence.duplicate ?? 0) > 0;

/**
 * What the best candidate's probability `p` and its margin over the next say: whether an existing
 * album is proposed, and how sure that is. Sure only when enabled; likely for a proposed album;
 * unsure otherwise, which is also how sure a new album is when two albums are nearly tied.
 */
export const verdictOf = (p: number, margin: number): { proposal: 'existing' | 'new'; confidence: MatchConfidence } => {
  if (p < PROPOSE_P || margin < PROPOSE_MARGIN) return { proposal: 'new', confidence: 'low' };
  return { proposal: 'existing', confidence: HIGH_ENABLED && p >= HIGH_P && margin >= HIGH_MARGIN ? 'high' : 'medium' };
};
