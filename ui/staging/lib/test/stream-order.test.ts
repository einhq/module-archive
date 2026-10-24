import { assertEquals } from '@std/assert';
import { nextAfterDecision, stepFrom, streamOrder } from '../stream-order.ts';

const rows = [
  { name: 'auto-2019-06-16', timeStart: '2019-06-16T09:00:00Z' },
  { name: 'undated-box-3' },
  { name: 'seed-lake-trip', timeStart: '2019-06-14T08:00:00Z' },
  { name: 'auto-2019-06-14', timeStart: '2019-06-14T08:00:00Z' },
  { name: 'folder-scans' },
  { name: 'auto-2018-12-24', timeStart: '2018-12-24T17:00:00Z' },
];

Deno.test('seeds and folders stand at their time, ties by name, and the undated come last', () => {
  assertEquals(streamOrder(rows).map((row) => row.name), [
    'auto-2018-12-24',
    'auto-2019-06-14',
    'seed-lake-trip',
    'auto-2019-06-16',
    'folder-scans',
    'undated-box-3',
  ]);
});

Deno.test('newest first reverses the dated groups and keeps the undated last', () => {
  assertEquals(streamOrder(rows, { newestFirst: true }).map((row) => row.name), [
    'auto-2019-06-16',
    'seed-lake-trip',
    'auto-2019-06-14',
    'auto-2018-12-24',
    'folder-scans',
    'undated-box-3',
  ]);
});

Deno.test('J and K step to the neighbours, and stop at the ends', () => {
  const view = ['a', 'b', 'c'];
  assertEquals(stepFrom(view, 'b', 1), 'c');
  assertEquals(stepFrom(view, 'b', -1), 'a');
  assertEquals(stepFrom(view, 'c', 1), 'c');
  assertEquals(stepFrom(view, 'a', -1), 'a');
  assertEquals(stepFrom(view, null, 1), 'a');
  assertEquals(stepFrom(view, 'gone', -1), 'c');
  assertEquals(stepFrom([], 'a', 1), null);
});

Deno.test('after a decision the cursor skips rows being decided or that failed, and keeps the ones stepped past', () => {
  const view = ['skipped', 'decided', 'pending', 'failed', 'next', 'last'];
  const skip = (name: string) => name === 'pending' || name === 'failed';
  assertEquals(nextAfterDecision(view, 'decided', skip), 'next');
  // At the end, the nearest row before it that is still to decide: the one stepped past.
  assertEquals(nextAfterDecision(['skipped', 'decided', 'pending'], 'decided', skip), 'skipped');
  assertEquals(nextAfterDecision(['decided', 'pending'], 'decided', skip), null);
  assertEquals(nextAfterDecision(view, 'not-in-view', skip), 'skipped');
});
