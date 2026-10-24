/**
 * Chromaprint matching: alignment wherever each copy starts, bit noise tolerated, unrelated
 * sequences and repeated values not mistaken for a match, and the stored byte form.
 */

import { assert, assertEquals } from '@std/assert';
import { decodeChromaprint, encodeChromaprint, matchChromaprints } from '@archive/media/chromaprint';

/** Deterministic pseudo-random uint32s (xorshift32), standing in for a recording's values. */
const sequence = (seed: number, length: number): number[] => {
  let x = seed >>> 0 || 1;
  return Array.from({ length }, () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>>= 0);
  });
};

/** Flip one low bit in every `every`th value, as an encoder's noise would. */
const noisy = (values: number[], every: number): number[] => values.map((v, i) => (i % every === 0 ? (v ^ 1) >>> 0 : v));

Deno.test('a copy with other audio in front of it is found at its offset', () => {
  const recording = sequence(7, 400);
  const copy = [...sequence(99, 57), ...noisy(recording, 3)];

  const match = matchChromaprints(Uint32Array.from(recording), Uint32Array.from(copy))!;

  assertEquals(match.offset, -57);
  assertEquals(match.overlap, 400);
  assert(match.similarity > 0.97, `similarity ${match.similarity}`);
});

Deno.test('a copy cut short matches over what it kept', () => {
  const recording = sequence(11, 600);
  const cut = recording.slice(299, 499);

  const match = matchChromaprints(Uint32Array.from(recording), Uint32Array.from(cut))!;

  assertEquals(match.offset, 299);
  assertEquals(match.overlap, 200);
  assertEquals(match.similarity, 1);
});

Deno.test('unrelated recordings score near zero', () => {
  const match = matchChromaprints(Uint32Array.from(sequence(1, 500)), Uint32Array.from(sequence(2, 500)));

  assert(!match || match.similarity < 0.3, `similarity ${match?.similarity}`);
});

Deno.test('recordings that share only their silence do not match', () => {
  // The same value repeated says nothing about the shift; the rest decides.
  const silence = Array(300).fill(0x12345678);
  const a = [...silence, ...sequence(3, 200)];
  const b = [...silence, ...sequence(4, 200)];

  const match = matchChromaprints(Uint32Array.from(a), Uint32Array.from(b));

  assert(!match || match.similarity < 0.3, `similarity ${match?.similarity}`);
});

Deno.test('a print too short to say anything has no match', () => {
  assertEquals(matchChromaprints(Uint32Array.from(sequence(5, 10)), Uint32Array.from(sequence(5, 10))), null);
});

Deno.test('the stored form is the values as little-endian uint32s', () => {
  const values = [0, 1, 0xdeadbeef, 0xffffffff];
  const bytes = encodeChromaprint(values);

  assertEquals(bytes.length, 16);
  assertEquals([...bytes.slice(8, 12)], [0xef, 0xbe, 0xad, 0xde]);
  assertEquals([...decodeChromaprint(bytes)], values);
});
