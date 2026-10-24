/**
 * A label learned from its pictures: logistic regression over unit picture vectors.
 *
 * For a unit vector `x`, `w·x + b` orders pictures exactly as `cos(w, x)` does, so the trained
 * model is a direction in the picture space. Its unit weights are a query vector for a
 * nearest-neighbour search, and a threshold on the model is a floor on that cosine. Everything
 * here is pure arithmetic over the vectors it is given; nothing reads the VFS.
 *
 * Each fit runs in a worker, since seconds of arithmetic on the process's own thread slow every
 * other command however finely they are sliced.
 */

/** One picture vector, as training sees it. */
export type Sample = {
  /** Unit length (`unit`). */
  vector: Float32Array;
  positive: boolean;
  /** How much the sample counts; the classes are balanced over these before training. */
  weight: number;
  /**
   * What a positive came from: the file or album that carries the label. Cross-validation keeps
   * a group on one side of every fold, so the pictures of one album never test each other.
   */
  group?: string;
};

/** The learned direction: unit weights, so a picture's score is its cosine to them. */
type Direction = Float64Array;

/** What cross-validation measured. */
type Measurement = {
  /** Area under the ROC curve over held-out positives against held-out negatives, mean over folds. */
  auc: number;
  /** Held-out positives at or above each fold's own floor (`floorAt` at `fpRate`), mean over folds. */
  recall: number;
  folds: number;
};

/** The vector scaled to length 1; a zero vector stays zero. */
export const unit = (vector: ArrayLike<number>): Float32Array => {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] * scale;
  return out;
};

/** `a·b`. */
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/** A seeded generator in [0, 1), so a label trains to the same model from the same data. */
export const seededRandom = (seed: string): () => number => {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type TrainOptions = {
  /** L2 penalty on the weights. Unit inputs need long weights to separate, so it is small. */
  l2?: number;
  iterations?: number;
  /** The gradient step. The loss's curvature is at most 1/4 for unit inputs and unit total weight, so a step of a few is stable. */
  rate?: number;
};

const DEFAULTS: Required<TrainOptions> = { l2: 1e-3, iterations: 100, rate: 2 };
const MOMENTUM = 0.9;

/** Packed input: `n` vectors of `dim` in `m`, each one's share of the loss and its class (1, -1). */
type Packed = { m: Float32Array; n: number; dim: number; weight: Float64Array; sign: Float64Array } & Required<TrainOptions> & { momentum: number };

/**
 * The fit, returning the weights before scaling to unit length. It is sent to the worker as
 * source text, so it uses nothing outside its own body: no helper, no import, no constant from
 * this file.
 */
const kernel = ({ m, n, dim, weight, sign, l2, iterations, rate, momentum }: Packed): Float64Array => {
  const w = new Float64Array(dim);
  for (let i = 0; i < n; i++) {
    const k = weight[i] * sign[i] * 2;
    for (let d = 0; d < dim; d++) w[d] += k * m[i * dim + d];
  }
  let b = 0;

  const velocity = new Float64Array(dim + 1);
  const grad = new Float64Array(dim + 1);
  for (let step = 1; step <= iterations; step++) {
    grad.fill(0);
    for (let i = 0; i < n; i++) {
      const x = i * dim;
      let z = b;
      for (let d = 0; d < dim; d++) z += w[d] * m[x + d];
      // d/dz of log(1 + e^(-y z)) is -y σ(-y z).
      const g = -sign[i] * weight[i] / (1 + Math.exp(sign[i] * z));
      for (let d = 0; d < dim; d++) grad[d] += g * m[x + d];
      grad[dim] += g;
    }
    for (let d = 0; d < dim; d++) grad[d] += l2 * w[d];

    for (let d = 0; d <= dim; d++) {
      velocity[d] = momentum * velocity[d] - rate * grad[d];
      if (d < dim) w[d] += velocity[d];
      else b += velocity[d];
    }
  }
  return w;
};

/**
 * The worker, as a `data:` URL rather than a file beside this one: `#!ts` commands run from
 * staged copies of exactly the files they import, so a sibling file is not there to load.
 */
const WORKER_URL = `data:text/javascript,${
  encodeURIComponent(`const kernel = ${kernel.toString()};
self.onmessage = ({ data }) => {
  const w = kernel(data);
  self.postMessage(w, [w.buffer]);
};`)
}`;

const inWorker = (packed: Packed): Promise<Float64Array> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (event: MessageEvent<Float64Array>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      worker.terminate();
      reject(new Error(`label training worker: ${event.message}`));
    };
    worker.postMessage(packed, [packed.m.buffer, packed.weight.buffer, packed.sign.buffer]);
  });

/**
 * Fit the direction separating the positives from the negatives. The classes are weighted to
 * equal totals, so a label with 20 pictures against 2000 sampled ones is not learned as "never".
 * Full-batch gradient descent with momentum on the weighted logistic loss, started from the
 * difference of the class means, which is already most of the answer. Plain gradient steps, not
 * per-coordinate ones: the many dimensions only noise separates move little in the iterations
 * given, which is what keeps a few dozen examples from being learned as their noise.
 */
export const train = async (samples: Sample[], options: TrainOptions = {}): Promise<Direction> => {
  const { l2, iterations, rate } = { ...DEFAULTS, ...options };
  const dim = samples[0]?.vector.length ?? 0;
  const positiveTotal = samples.reduce((sum, s) => sum + (s.positive ? s.weight : 0), 0);
  const negativeTotal = samples.reduce((sum, s) => sum + (s.positive ? 0 : s.weight), 0);
  if (dim === 0 || positiveTotal === 0 || negativeTotal === 0) throw new Error('training needs positive and negative samples');

  const n = samples.length;
  const m = new Float32Array(n * dim);
  const weight = new Float64Array(n);
  const sign = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    m.set(s.vector, i * dim);
    weight[i] = s.weight / (s.positive ? positiveTotal : negativeTotal) / 2;
    sign[i] = s.positive ? 1 : -1;
  }

  const w = await inWorker({ m, n, dim, weight, sign, l2, iterations, rate, momentum: MOMENTUM });
  let length = 0;
  for (let d = 0; d < dim; d++) length += w[d] * w[d];
  length = Math.sqrt(length);
  if (length === 0) throw new Error('training found no direction');
  for (let d = 0; d < dim; d++) w[d] /= length;
  return w;
};

/** How many of `count` negatives a floor lets through: `rate` of them, and at least `least`. */
export const passingOf = (count: number, rate: number, least: number): number => Math.max(least, Math.floor(rate * count));

/**
 * The floor that lets `passing` of `negatives` through: the cosine just above the next highest
 * negative score. Measured on negatives the direction was not trained on, it says what share of
 * the pictures not carrying the label sit above it.
 */
export const floorAt = (negatives: number[], passing: number): number => {
  if (negatives.length === 0) throw new Error('a floor needs negative scores');
  const sorted = negatives.toSorted((a, b) => b - a);
  return sorted[Math.min(passing, sorted.length - 1)] + 1e-6;
};

/** Mann-Whitney AUC: how often a positive outscores a negative, ties counting half. */
export const auc = (positives: number[], negatives: number[]): number => {
  if (positives.length === 0 || negatives.length === 0) return NaN;
  const all = [...positives.map((score) => ({ score, positive: true })), ...negatives.map((score) => ({ score, positive: false }))]
    .sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j].score === all[i].score) j++;
    const rank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k].positive) rankSum += rank;
    i = j;
  }
  const p = positives.length;
  return (rankSum - p * (p + 1) / 2) / (p * negatives.length);
};

/**
 * Train on all folds but one and score the one held out, for each fold. Positives are split by
 * group, negatives at random; at most `folds` folds, and no more than there are groups. Needs at
 * least two groups.
 */
export const crossValidate = async (
  samples: Sample[],
  options: TrainOptions & { folds?: number; fpRate: number; leastPassing?: number; random: () => number },
): Promise<Measurement> => {
  const groups = [...new Set(samples.filter((s) => s.positive).map((s) => s.group ?? ''))];
  const folds = Math.min(options.folds ?? 5, groups.length);
  if (folds < 2) throw new Error('cross-validation needs positives from at least two groups');

  // Groups shuffled, then dealt round-robin: folds of near-equal group counts.
  const order = groups.map((group) => ({ group, key: options.random() })).sort((a, b) => a.key - b.key);
  const foldOfGroup = new Map(order.map(({ group }, index) => [group, index % folds]));
  const foldOf = samples.map((s) => s.positive ? foldOfGroup.get(s.group ?? '')! : Math.floor(options.random() * folds));

  let aucSum = 0, recallSum = 0, counted = 0;
  for (let fold = 0; fold < folds; fold++) {
    const training = samples.filter((_, i) => foldOf[i] !== fold);
    const held = samples.filter((_, i) => foldOf[i] === fold);
    const heldPositives = held.filter((s) => s.positive);
    const heldNegatives = held.filter((s) => !s.positive);
    if (heldPositives.length === 0 || heldNegatives.length === 0 || !training.some((s) => s.positive)) continue;
    const direction = await train(training, options);
    const pos = heldPositives.map((s) => dot(direction, s.vector));
    const neg = heldNegatives.map((s) => dot(direction, s.vector));
    const floor = floorAt(neg, passingOf(neg.length, options.fpRate, options.leastPassing ?? 0));
    aucSum += auc(pos, neg);
    recallSum += pos.filter((score) => score >= floor).length / pos.length;
    counted++;
  }
  if (counted === 0) throw new Error('no fold had both positives and negatives held out');
  return { auc: aucSum / counted, recall: recallSum / counted, folds: counted };
};
