/**
 * Chromaprint matching: whether two recordings are the same sound, wherever each one starts.
 *
 * A chromaprint is one 32-bit value per ~0.124 s of audio. Two copies of a recording give the same
 * sequence up to bit noise from the encoding, shifted by however much audio one has in front of
 * the other. Matching therefore finds the shift first — by voting over the offsets at which the
 * values' top bits agree — and then measures the bit error rate over the overlap at the best of
 * those offsets. `similarity` is `1 - 2·BER`: 1 is identical, 0 is unrelated.
 *
 * Silence, or any held sound, is one value repeated. Two recordings that both hold still at the
 * same place agree there whatever they are, so a position where both sides repeat their previous
 * value is left out of the overlap: two memos that are mostly the same silence do not match.
 *
 * A stored chromaprint is its values as little-endian uint32s, nothing else.
 */

/** The mimetype of a stored chromaprint, which is how they are enumerated. */
export const CHROMAPRINT_MIMETYPE = 'application/x-chromaprint';

/** Values compared to align two prints: their top bits, which encoding noise disturbs least. */
const ALIGN_BITS = 12;
const ALIGN_SHIFT = 32 - ALIGN_BITS;
/** Offsets, best-voted first, whose bit error rate is measured. */
const CANDIDATE_OFFSETS = 5;
/** Votes this close to a chosen offset are its own spread, not another candidate. */
const PEAK_RADIUS = 2;
/** The shortest overlap measured, in values: about two and a half seconds. */
const MIN_OVERLAP = 20;

type ChromaprintMatch = {
  /** Where `b` starts in `a`, in values; negative when `b` has audio in front of `a`. */
  offset: number;
  /** Values compared at that offset: the overlap, less where both sides hold one value. */
  overlap: number;
  /** `1 - 2·BER` over the overlap. */
  similarity: number;
};

export function encodeChromaprint(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
  return bytes;
}

export function decodeChromaprint(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Uint32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < values.length; i++) values[i] = view.getUint32(i * 4, true);
  return values;
}

const popcount = (x: number): number => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Offset votes: for each `i - j`, how many pairs `a[i]`, `b[j]` share their top bits. */
function offsetVotes(a: Uint32Array, b: Uint32Array): Uint32Array {
  const buckets = 1 << ALIGN_BITS;
  const countA = new Uint32Array(buckets);
  const countB = new Uint32Array(buckets);
  for (const value of a) countA[value >>> ALIGN_SHIFT]++;
  for (const value of b) countB[value >>> ALIGN_SHIFT]++;

  // A value repeated through a long stretch of silence or hum agrees with itself at every
  // offset: it says nothing about the shift and would cost the product of its counts. Such
  // values are left out of the vote.
  const common = (n: number) => Math.max(32, Math.ceil((8 * n) / buckets));
  const limitA = common(a.length);
  const limitB = common(b.length);

  const head = new Int32Array(buckets).fill(-1);
  const next = new Int32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const h = a[i] >>> ALIGN_SHIFT;
    if (countA[h] > limitA || countB[h] > limitB) continue;
    next[i] = head[h];
    head[h] = i;
  }

  const votes = new Uint32Array(a.length + b.length - 1);
  const shift = b.length - 1;
  for (let j = 0; j < b.length; j++) {
    for (let i = head[b[j] >>> ALIGN_SHIFT]; i >= 0; i = next[i]) votes[i - j + shift]++;
  }
  return votes;
}

function overlapAt(a: Uint32Array, b: Uint32Array, offset: number): { start: number; end: number } {
  const start = Math.max(0, offset);
  const end = Math.min(a.length, b.length + offset);
  return { start, end };
}

/**
 * The best alignment of two chromaprints, or null when they share no overlap long enough to say:
 * either is shorter than the minimum, or no offset with enough overlap got a vote.
 */
export function matchChromaprints(a: Uint32Array, b: Uint32Array): ChromaprintMatch | null {
  if (a.length < MIN_OVERLAP || b.length < MIN_OVERLAP) return null;

  const votes = offsetVotes(a, b);
  const shift = b.length - 1;
  const candidates: number[] = [];
  const taken = new Uint8Array(votes.length);
  for (let n = 0; n < CANDIDATE_OFFSETS; n++) {
    let best = -1;
    for (let k = 0; k < votes.length; k++) {
      if (taken[k] || votes[k] === 0) continue;
      if (best < 0 || votes[k] > votes[best]) best = k;
    }
    if (best < 0) break;
    for (let k = Math.max(0, best - PEAK_RADIUS); k <= Math.min(votes.length - 1, best + PEAK_RADIUS); k++) taken[k] = 1;
    candidates.push(best - shift);
  }

  let match: ChromaprintMatch | null = null;
  for (const offset of candidates) {
    const { start, end } = overlapAt(a, b, offset);
    if (end - start < MIN_OVERLAP) continue;
    let errors = 0;
    let overlap = 0;
    for (let i = start; i < end; i++) {
      const j = i - offset;
      if (i > 0 && j > 0 && a[i] === a[i - 1] && b[j] === b[j - 1]) continue;
      errors += popcount(a[i] ^ b[j]);
      overlap++;
    }
    if (overlap < MIN_OVERLAP) continue;
    const similarity = 1 - (2 * errors) / (32 * overlap);
    if (!match || similarity > match.similarity) match = { offset, overlap, similarity };
  }
  return match;
}
