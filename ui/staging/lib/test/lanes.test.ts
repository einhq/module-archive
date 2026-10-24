import { assertEquals } from '@std/assert';
import { inLane, isLane, isLaneGroup, laneCounts, laneOf } from '../lanes.ts';

Deno.test('a kind decides the lane, and no kind is an event to sort', () => {
  assertEquals(laneOf({}), 'sort');
  assertEquals(laneOf({ staging: {} }), 'sort');
  assertEquals(laneOf({ staging: { kind: 'trip' } }), 'sort');
  assertEquals(laneOf({ staging: { kind: 'event' } }), 'sort');
  assertEquals(laneOf({ staging: { kind: 'seed' } }), 'sort');
  assertEquals(laneOf({ staging: { kind: 'folder' } }), 'sort');
  assertEquals(laneOf({ staging: { kind: 'loose' } }), 'everyday');
  assertEquals(laneOf({ staging: { kind: 'undated' } }), 'undated');
  assertEquals(laneOf({ staging: { kind: 'clutter' } }), 'clutter');
  // Everyday pictures dated only to a year or a month need a date.
  assertEquals(laneOf({ staging: { kind: 'loose', precision: 'year' } }), 'undated');
  assertEquals(laneOf({ staging: { kind: 'loose', precision: 'month' } }), 'undated');
  // A kind from a newer server than this page is sorted, not lost.
  assertEquals(laneOf({ staging: { kind: 'newfangled' as 'trip' } }), 'sort');
});

Deno.test('a group put aside is in Later, whatever its kind', () => {
  assertEquals(laneOf({ staging: { later: '2026-10-17T10:00:00Z' } }), 'later');
  assertEquals(laneOf({ staging: { kind: 'clutter', later: '2026-10-17T10:00:00Z' } }), 'later');
});

Deno.test('counts are groups and their files per lane', () => {
  const rows = [
    { memberCount: 143, staging: { kind: 'trip' as const } },
    { memberCount: 24 },
    { memberCount: 412, staging: { kind: 'loose' as const } },
    { staging: { kind: 'clutter' as const } },
  ];
  assertEquals(laneCounts(rows), {
    sort: { groups: 2, files: 167 },
    everyday: { groups: 1, files: 412 },
    undated: { groups: 0, files: 0 },
    clutter: { groups: 1, files: 0 },
    later: { groups: 0, files: 0 },
  });
  assertEquals(inLane(rows, 'sort'), [rows[0], rows[1]]);
});

Deno.test('only a known lane is a lane', () => {
  assertEquals([isLane('sort'), isLane('clutter'), isLane('later'), isLane('elsewhere'), isLane(null)], [true, true, true, false, false]);
});

Deno.test("a lane's group is Everyday, clutter or undated, never an event", () => {
  assertEquals((['loose', 'clutter', 'undated'] as const).map((kind) => isLaneGroup({ staging: { kind } })), [true, true, true]);
  assertEquals((['event', 'trip', 'seed', 'folder'] as const).map((kind) => isLaneGroup({ staging: { kind } })), [false, false, false, false]);
  assertEquals(isLaneGroup({}), false);
});

Deno.test('lane counts follow the kinds, a period lane under Needs a date', () => {
  const counts = laneCounts([{ memberCount: 30, staging: { kind: 'loose', precision: 'year' } }, { memberCount: 2, staging: { kind: 'undated' } }, {
    memberCount: 9,
    staging: { kind: 'seed' },
  }]);
  assertEquals([counts.undated, counts.sort, counts.everyday], [{ groups: 2, files: 32 }, { groups: 1, files: 9 }, { groups: 0, files: 0 }]);
});
