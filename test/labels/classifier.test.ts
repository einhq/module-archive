/**
 * The label classifier: a direction learned from positives and negatives, a floor from held-out
 * negatives, and cross-validation that keeps a group on one side of every fold.
 */

import { assert, assertAlmostEquals, assertEquals, assertRejects } from '@std/assert';
import { auc, crossValidate, dot, floorAt, passingOf, type Sample, seededRandom, train, unit } from '@archive/labels/classifier';

const DIM = 48;

/** A unit vector near `centre`, `spread` controlling how near. */
const near = (centre: Float32Array, spread: number, random: () => number): Float32Array => {
  const v = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) v[d] = centre[d] + spread * (random() * 2 - 1);
  return unit(v);
};

const randomUnit = (random: () => number): Float32Array => {
  const v = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) v[d] = random() * 2 - 1;
  return unit(v);
};

/** Positives in `groups` groups around one direction, negatives anywhere. */
const dataset = (seed: string, groups: number, perGroup: number, negatives: number) => {
  const random = seededRandom(seed);
  const concept = randomUnit(random);
  const samples: Sample[] = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < perGroup; i++) samples.push({ vector: near(concept, 0.25, random), positive: true, weight: 1, group: `g${g}` });
  }
  for (let i = 0; i < negatives; i++) samples.push({ vector: randomUnit(random), positive: false, weight: 1 });
  return { samples, concept, random };
};

Deno.test('unit and dot', () => {
  const v = unit([3, 4]);
  assertAlmostEquals(v[0], 0.6, 1e-6);
  assertAlmostEquals(dot(v, v), 1, 1e-6);
  assertEquals([...unit([0, 0])], [0, 0]);
});

Deno.test('seededRandom repeats for one seed and differs between seeds', () => {
  const [a, b, c] = [seededRandom('x'), seededRandom('x'), seededRandom('y')];
  const first = [a(), a(), a()];
  assertEquals(first, [b(), b(), b()]);
  assert(first[0] !== c());
  assert(first.every((value) => value >= 0 && value < 1));
});

Deno.test('train finds the direction the positives share', async () => {
  const { samples, concept } = dataset('train', 4, 10, 400);
  const direction = await train(samples);
  assertAlmostEquals(dot(direction, direction), 1, 1e-9);
  assert(dot(direction, concept) > 0.8, `cosine to the concept ${dot(direction, concept)}`);
  const pos = samples.filter((s) => s.positive).map((s) => dot(direction, s.vector));
  const neg = samples.filter((s) => !s.positive).map((s) => dot(direction, s.vector));
  assert(auc(pos, neg) > 0.99);
});

Deno.test('train refuses a single class', async () => {
  const { samples } = dataset('one-class', 1, 5, 0);
  await assertRejects(() => train(samples), Error, 'positive and negative');
});

Deno.test('floorAt lets the given number of negatives through', () => {
  const negatives = Array.from({ length: 100 }, (_, i) => i / 100);
  assertEquals(negatives.filter((score) => score >= floorAt(negatives, 5)).length, 5);
  assertEquals(negatives.filter((score) => score >= floorAt(negatives, 0)).length, 0);
});

Deno.test('passingOf takes the share, and at least the least', () => {
  assertEquals(passingOf(2000, 0.005, 3), 10);
  assertEquals(passingOf(100, 0.005, 3), 3);
});

Deno.test('auc counts ties as half', () => {
  assertEquals(auc([1, 2], [0, 0.5]), 1);
  assertEquals(auc([0], [1]), 0);
  assertEquals(auc([1], [1]), 0.5);
});

Deno.test('crossValidate measures a learnable label as learnable', async () => {
  const { samples, random } = dataset('cv', 6, 8, 600);
  const measured = await crossValidate(samples, { fpRate: 0.01, random });
  assertEquals(measured.folds, 5);
  assert(measured.auc > 0.98, `auc ${measured.auc}`);
  assert(measured.recall > 0.8, `recall ${measured.recall}`);
});

Deno.test('crossValidate finds nothing to learn in positives that share nothing', async () => {
  const random = seededRandom('noise');
  const samples: Sample[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ vector: randomUnit(random), positive: true, weight: 1, group: `g${i % 8}` })),
    ...Array.from({ length: 600 }, () => ({ vector: randomUnit(random), positive: false, weight: 1 })),
  ];
  const measured = await crossValidate(samples, { fpRate: 0.01, random });
  assert(measured.auc < 0.7, `auc ${measured.auc}`);
  assert(measured.recall < 0.2, `recall ${measured.recall}`);
});

Deno.test('crossValidate needs two groups', async () => {
  const { samples, random } = dataset('one-group', 1, 20, 100);
  await assertRejects(() => crossValidate(samples, { fpRate: 0.01, random }), Error, 'two groups');
});
