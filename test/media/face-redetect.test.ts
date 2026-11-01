/**
 * A re-detection's faces continue the regions they are the same face as, and what a person
 * decided outlives it. Pure: no VFS.
 */

import { assertEquals } from '@std/assert';
import { isHeldFace, planRedetection } from '../../lib/media/face-redetect.ts';

const box = (x: number, y = 0.2, side = 0.1) => ({ x, y, width: side, height: side });

Deno.test('a new face on the same box continues the old region, and a new box is a new region', () => {
  const plan = planRedetection(
    [{ name: 'face-0', attrs: { faceBox: box(0.1), personId: 'anna', personSource: 'auto' } }],
    [{ box: box(0.6) }, { box: box(0.105) }],
  );
  assertEquals([...plan.continues], [[1, 'face-0']]);
  assertEquals([...plan.created], [[0, 'face-1']]);
  assertEquals(plan.kept, []);
  assertEquals(plan.removed, []);
});

Deno.test('an old region nobody named, or only a machine, goes when nothing continues it', () => {
  const plan = planRedetection(
    [
      { name: 'face-0', attrs: { faceBox: box(0.1) } },
      { name: 'face-1', attrs: { faceBox: box(0.4), personId: 'anna', personSource: 'cluster' } },
    ],
    [],
  );
  assertEquals(plan.removed, [{ name: 'face-0' }, { name: 'face-1', personId: 'anna' }]);
  assertEquals(plan.kept, []);
});

Deno.test('an old region a person decided on stays as a tag when nothing continues it', () => {
  const plan = planRedetection(
    [
      { name: 'face-0', attrs: { faceBox: box(0.1), personId: 'anna', personSource: 'manual' } },
      { name: 'face-1', attrs: { faceBox: box(0.4), personId: 'berit', personSource: 'transfer' } },
      { name: 'face-2', attrs: { faceBox: box(0.7), rejectedPersonIds: ['anna'] } },
    ],
    [],
  );
  assertEquals(plan.kept, ['face-0', 'face-1', 'face-2']);
  assertEquals(plan.removed, []);
});

Deno.test('each old region is continued once, by the face that overlaps it most', () => {
  const plan = planRedetection(
    [{ name: 'face-3', attrs: { faceBox: box(0.1) } }],
    [{ box: box(0.13) }, { box: box(0.1) }],
  );
  assertEquals([...plan.continues], [[1, 'face-3']]);
  // A removed name never comes back on another face: new ones start after the highest.
  assertEquals([...plan.created], [[0, 'face-4']]);
});

Deno.test('a video face continues the region whose box it had at the same second', () => {
  const old = [{ name: 'face-0', attrs: { faceBox: box(0.1), atSeconds: 4 } }];
  const elsewhere = { box: box(0.6), at: 9, track: [[4, 0.6, 0.2, 0.1, 0.1], [9, 0.6, 0.2, 0.1, 0.1]] as [number, number, number, number, number][] };
  const same = { box: box(0.3), at: 12, track: [[4.1, 0.1, 0.2, 0.1, 0.1], [12, 0.3, 0.2, 0.1, 0.1]] as [number, number, number, number, number][] };
  const plan = planRedetection(old, [elsewhere, same], 0.25);
  assertEquals([...plan.continues], [[1, 'face-0']]);
});

Deno.test('a machine guess alone is not held; a lock, a rejection or a marked doubt is', () => {
  assertEquals(isHeldFace({ personId: 'anna', personSource: 'auto' }), false);
  assertEquals(isHeldFace({ personId: 'anna', personSource: 'cluster' }), false);
  assertEquals(isHeldFace({ personId: 'anna', personSource: 'manual' }), true);
  assertEquals(isHeldFace({ personId: 'anna', personSource: 'auto', assignLocked: true }), true);
  assertEquals(isHeldFace({ rejectedPersonIds: ['anna'] }), true);
  assertEquals(isHeldFace({ doubt: { personId: 'anna', markedBy: 'admin', markedAt: '2026-01-01T00:00:00Z' } }), true);
  assertEquals(isHeldFace({}), false);
});
