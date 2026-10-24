/**
 * What `label-model` answers with under `JSON_OUTPUT=1`, as types (`@archive/labels/api`), and the
 * model it keeps on a label's tag directory. Import-free, so a browser can import it.
 */

/** Why a label suggests nothing, or suggests without having been measured. */
export type LabelModelReason =
  /** No labeled file or album has a picture vector. */
  | 'no-pictures'
  /** Too few pictures, or all from one file or album, to hold any back and measure. */
  | 'too-few-examples'
  /** Its held-out pictures were not found again: what it names is not in the pictures. */
  | 'not-visual';

/**
 * A label's model, kept as `attrs.model` on `/archive/tags/<label>`: a direction in one picture
 * embedding space. A picture's score is its cosine to `weights`, and it is suggested at or above
 * `floor`.
 */
export type LabelModel = {
  embeddingType: string;
  /** Learned from the label's own pictures, or asked by the vocabulary's words for it. */
  source: 'examples' | 'vocabulary';
  /** For a vocabulary model: the sentence it is the text vector of. */
  prompt?: string;
  /** Unit length. */
  weights: number[];
  floor: number;
  /** Picture vectors it was learned from, and how many files and albums they came from. */
  pictures: number;
  groups: number;
  negatives: number;
  /** Cross-validation over the label's own examples; absent when there were too few to hold any back. */
  measured?: { auc: number; recall: number; folds: number };
  /** Measured, and its held-out pictures were found again. Only then are its suggestions offered on their own. */
  learnable: boolean;
  reason?: LabelModelReason;
  /** Pictures at or above the floor that do not carry the label and were not rejected for it; at most `matchesCapped`. */
  matches: number;
  matchesCapped: boolean;
  /** What it was trained on (members and rejections); a different one means it is stale. */
  signature: string;
  trainedAt: string;
};

/** A label's model as `label-model show`, `list` and `train` report it: everything but the weights. */
export type LabelModelSummary = Omit<LabelModel, 'weights'> & {
  label: string;
  /** Files and albums rejected for the label. */
  rejected: number;
  /** The label's members or rejections changed since it was trained, or it was trained long enough ago to be redone (a week). */
  stale: boolean;
};

/** `label-model train` per label: the summary, or why there is no model. */
export type LabelTrainResult =
  | (LabelModelSummary & { trained: boolean })
  | { label: string; trained: false; reason: LabelModelReason; stale?: undefined };
