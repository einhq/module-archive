/**
 * Leave-one-out nearest anchor: for every human-anchored face, the closest other anchor of the
 * same person and the closest anchor of anyone else, by cosine similarity, never counting a face
 * from the same photo.
 *
 * An anchor is a face a human named (`transfer`, `manual`): recognition votes from them, so one
 * on the wrong person pulls others after it. A face whose nearest anchor is somebody else is the
 * audit's suspect (`face-audit`): for a correctly named face that is rare.
 *
 * The search is exact and brute force: every pair once, rows taken eight at a time so each
 * vector read serves eight products. An index cannot answer "nearest among the anchors" — they
 * are a tenth of the faces, and a filtered HNSW walk per face costs more than this whole pass —
 * and an exact scan in PostgreSQL detoasts every row for every query.
 *
 * The pass runs in a worker, since a minute of arithmetic on the process's own thread slows
 * every other command by seconds however finely it is sliced.
 */

/** One anchor: its person, its photo, and its vector. */
export type Anchor = { person: string; file?: string; vector: ArrayLike<number> };

/** The closest anchor, by index into the input, and its similarity. */
type Hit = { index: number; similarity: number };

type Nearest = {
  /** The closest other anchor of the same person; null when the person has no other. */
  own: Hit | null;
  /** The closest anchor of anybody else; null when there is nobody else. */
  other: Hit | null;
};

/** Packed input: `n` unit vectors of `dim` in `m`, and small-integer person and photo ids (-1: no photo). */
type Packed = { m: Float32Array; n: number; dim: number; person: Int32Array; file: Int32Array };

/** Per anchor, the index (-1: none) and similarity of its nearest own and other anchor. */
type Found = { ownIdx: Int32Array; ownSim: Float32Array; otherIdx: Int32Array; otherSim: Float32Array };

/**
 * The pass. It is sent to the worker as source text, so it uses nothing outside its own body:
 * no helper, no import, no constant from this file.
 */
const kernel = ({ m, n, dim, person, file }: Packed): Found => {
  const ownSim = new Float32Array(n).fill(-Infinity);
  const ownIdx = new Int32Array(n).fill(-1);
  const otherSim = new Float32Array(n).fill(-Infinity);
  const otherIdx = new Int32Array(n).fill(-1);

  /** Both directions of one pair. */
  const pair = (a: number, b: number, sim: number) => {
    if (file[a] !== -1 && file[a] === file[b]) return;
    if (person[a] === person[b]) {
      if (sim > ownSim[a]) (ownSim[a] = sim, ownIdx[a] = b);
      if (sim > ownSim[b]) (ownSim[b] = sim, ownIdx[b] = a);
    } else {
      if (sim > otherSim[a]) (otherSim[a] = sim, otherIdx[a] = b);
      if (sim > otherSim[b]) (otherSim[b] = sim, otherIdx[b] = a);
    }
  };
  const dot = (a: number, b: number) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += m[a + d] * m[b + d];
    return s;
  };

  // Eight rows against each vector read.
  const full = n - (n % 8);
  for (let i = 0; i < full; i += 8) {
    const a0 = i * dim, a1 = a0 + dim, a2 = a1 + dim, a3 = a2 + dim;
    const a4 = a3 + dim, a5 = a4 + dim, a6 = a5 + dim, a7 = a6 + dim;
    // Pairs inside the block first, then the block against every later row.
    for (let r = i; r < i + 8; r++) {
      for (let j = r + 1; j < i + 8; j++) pair(r, j, dot(r * dim, j * dim));
    }
    for (let j = i + 8; j < n; j++) {
      const b = j * dim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, s6 = 0, s7 = 0;
      for (let d = 0; d < dim; d++) {
        const x = m[b + d];
        s0 += m[a0 + d] * x;
        s1 += m[a1 + d] * x;
        s2 += m[a2 + d] * x;
        s3 += m[a3 + d] * x;
        s4 += m[a4 + d] * x;
        s5 += m[a5 + d] * x;
        s6 += m[a6 + d] * x;
        s7 += m[a7 + d] * x;
      }
      pair(i, j, s0);
      pair(i + 1, j, s1);
      pair(i + 2, j, s2);
      pair(i + 3, j, s3);
      pair(i + 4, j, s4);
      pair(i + 5, j, s5);
      pair(i + 6, j, s6);
      pair(i + 7, j, s7);
    }
  }
  // The rows after the last full block, against each other; every earlier pair is done.
  for (let r = full; r < n; r++) {
    for (let j = r + 1; j < n; j++) pair(r, j, dot(r * dim, j * dim));
  }
  return { ownIdx, ownSim, otherIdx, otherSim };
};

/**
 * The worker, as a `data:` URL rather than a file beside this one: `#!ts` commands run from
 * staged copies of exactly the files they import, so a sibling file is not there to load.
 */
const WORKER_URL = `data:text/javascript,${
  encodeURIComponent(`const kernel = ${kernel.toString()};
self.onmessage = ({ data }) => {
  const found = kernel(data);
  self.postMessage(found, [found.ownIdx.buffer, found.ownSim.buffer, found.otherIdx.buffer, found.otherSim.buffer]);
};`)
}`;

const inWorker = (packed: Packed): Promise<Found> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (event: MessageEvent<Found>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      worker.terminate();
      reject(new Error(`face-audit worker: ${event.message}`));
    };
    worker.postMessage(packed, [packed.m.buffer, packed.person.buffer, packed.file.buffer]);
  });

/**
 * The nearest own and other anchor of every anchor.
 *
 * Vectors are normalized here, so any length works; a zero vector matches nothing. The pass is
 * quadratic, about a minute or two for twenty thousand 512-d faces, all of it off this thread.
 */
export const nearestAnchors = async (anchors: Anchor[]): Promise<Nearest[]> => {
  const n = anchors.length;
  const dim = n > 0 ? anchors[0].vector.length : 0;
  const m = new Float32Array(n * dim);
  const person = new Int32Array(n);
  const file = new Int32Array(n);
  const personIds = new Map<string, number>();
  const fileIds = new Map<string, number>();
  const idOf = (ids: Map<string, number>, key: string): number => {
    let id = ids.get(key);
    if (id === undefined) ids.set(key, id = ids.size);
    return id;
  };
  for (let i = 0; i < n; i++) {
    const { vector } = anchors[i];
    if (vector.length !== dim) throw new Error(`anchor ${i}: vector has ${vector.length} dimensions, expected ${dim}`);
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += vector[d] * vector[d];
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let d = 0; d < dim; d++) m[i * dim + d] = vector[d] * scale;
    person[i] = idOf(personIds, anchors[i].person);
    // -1 is "no photo known", which matches no other face's photo.
    file[i] = anchors[i].file === undefined ? -1 : idOf(fileIds, anchors[i].file!);
  }

  const { ownIdx, ownSim, otherIdx, otherSim } = await inWorker({ m, n, dim, person, file });
  const out: Nearest[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      own: ownIdx[i] === -1 ? null : { index: ownIdx[i], similarity: ownSim[i] },
      other: otherIdx[i] === -1 ? null : { index: otherIdx[i], similarity: otherSim[i] },
    });
  }
  return out;
};

/**
 * Whether a face's nearest anchor is somebody else: another person's anchor is closer than any of
 * its own. A face that is its person's only anchor has nothing to agree with, so it never is.
 */
export const disagrees = (nearest: Nearest): boolean => nearest.own !== null && nearest.other !== null && nearest.other.similarity > nearest.own.similarity;
