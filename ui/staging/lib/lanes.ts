import type { GroupKind } from '@archive/staging/api';

/**
 * The lanes a category's suggested groups fall into, by kind: the events, trips and seeds to sort,
 * the everyday pictures, what needs a date (undated pictures, and those dated only to a year or a
 * month), and clutter. Pure, so the counts and the views the page draws are tested without one.
 */
export type StagingLane = 'sort' | 'everyday' | 'undated' | 'clutter';

/** The lanes in the order the page offers them, as the reader calls them. */
export const LANES: readonly { id: StagingLane; label: string }[] = [
  { id: 'sort', label: 'To sort' },
  { id: 'everyday', label: 'Everyday' },
  { id: 'undated', label: 'Needs a date' },
  { id: 'clutter', label: 'Clutter' },
];

/** What the lanes read of an `album list` row of a suggested album. */
type LaneRow = { memberCount?: number; staging?: { kind?: GroupKind; precision?: 'year' | 'month' } };

const LANE_OF_KIND: Record<GroupKind, StagingLane> = {
  event: 'sort',
  trip: 'sort',
  seed: 'sort',
  loose: 'everyday',
  undated: 'undated',
  clutter: 'clutter',
};

/**
 * A row's lane, by kind: an everyday lane dated only to a year or a month needs a date, and one
 * without a kind (or of a kind this page does not know) is an ordinary event.
 */
export const laneOf = (row: LaneRow): StagingLane => {
  if (row.staging?.kind === 'loose' && row.staging.precision) return 'undated';
  return (row.staging?.kind && LANE_OF_KIND[row.staging.kind]) || 'sort';
};

export const isLane = (value: string | null | undefined): value is StagingLane => LANES.some((lane) => lane.id === value);

/** Whether a row is a lane's group (Everyday, clutter, undated), which is not merged or said to be no group. */
export const isLaneGroup = (row: LaneRow): boolean => row.staging?.kind === 'loose' || row.staging?.kind === 'clutter' || row.staging?.kind === 'undated';

type LaneCount = { groups: number; files: number };

/** Groups and their files per lane, in one pass. */
export function laneCounts(rows: readonly LaneRow[]): Record<StagingLane, LaneCount> {
  const counts = Object.fromEntries(LANES.map((lane) => [lane.id, { groups: 0, files: 0 }])) as Record<StagingLane, LaneCount>;
  for (const row of rows) {
    const count = counts[laneOf(row)];
    count.groups++;
    count.files += row.memberCount ?? 0;
  }
  return counts;
}

/** The rows in `lane`, in the order given. */
export const inLane = <T extends LaneRow>(rows: readonly T[], lane: StagingLane): T[] => rows.filter((row) => laneOf(row) === lane);
