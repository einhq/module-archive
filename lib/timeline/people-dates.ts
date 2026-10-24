/**
 * The dated-person reads that both the timeline's birthday source and the
 * landing page's anniversaries rest on.
 *
 * Shared so the date parsing has one copy. The two ask about different
 * attrs, though: a birthday needs `born`, a memorial needs `died`, and the two
 * sets are not the same people — much of an imported genealogy records a death
 * for someone whose birth is a bare year, or missing entirely.
 *
 * Two ways to ask, and the choice is a real trade:
 *
 * - `datedPeople` **queries** by attr. `vfs.query` has no OR, so that is one
 *   scan per attr, and on an archive whose person nodes are mostly unidentified
 *   face clusters each scan is slow. What it buys is completeness: a person
 *   filed somewhere other than the people root is still found. The timeline
 *   wants that.
 * - `listedPeople` **lists** the people root instead: one read of a few hundred
 *   entries, far cheaper, and it cannot see a person kept elsewhere. The
 *   landing page wants that — it is a panel about the next month, not an
 *   authority on who exists.
 */

import type { Command } from '@ein/client';

const NODE_TYPE_PERSON = 'person';

/** Ceiling on the person list. Hundreds is the real number; this is the guard. */
const PEOPLE_LIMIT = 5000;

/**
 * How long someone is assumed to have lived when no death date was recorded.
 *
 * Most people in an imported genealogy have a birth year and nothing else, and
 * treating a missing `died` as "still alive" would have someone born in the
 * 1840s turning 180. A cap is a guess, but it is a guess that is wrong by
 * a few decades rather than by a century, and it only ever removes entries.
 */
export const ASSUMED_LIFESPAN = 110;

/**
 * Milestones are every tenth anniversary, plus the fives up to twenty — the
 * ones people actually mark. Without this the feed is one birthday per person
 * per year, which at a few hundred people buries everything else.
 */
export const isMilestone = (years: number): boolean => years > 0 && (years % 10 === 0 || (years < 21 && years % 5 === 0));

export const yearOf = (date: string): number | undefined => {
  const match = /^(\d{4})/.exec(date);
  return match ? Number(match[1]) : undefined;
};

const monthDayOf = (date: string): string | undefined => {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  return match ? `${match[1]}-${match[2]}` : undefined;
};

/** A person node carrying the life date that was asked for, already parsed. */
export type DatedPerson = {
  path: string;
  id: string;
  name: string;
  /** The attr's value as stored, possibly partial (`1815`, `1815-03`). */
  date: string;
  year: number;
  /** `MM-DD`, only set when the date carries both. */
  monthDay?: string;
  born?: string;
  died?: string;
};

/** Parse one person node into the dated form, or drop it. */
const toDated = (absPath: string, attrs: Record<string, unknown>, id: string, ref: 'born' | 'died'): DatedPerson | undefined => {
  const born = typeof attrs.born === 'string' ? attrs.born : undefined;
  const died = typeof attrs.died === 'string' ? attrs.died : undefined;
  const date = ref === 'born' ? born : died;
  if (!date) return undefined;

  const year = yearOf(date);
  if (year === undefined) return undefined;

  return {
    path: absPath,
    id,
    name: (attrs.name as string | undefined) ?? absPath.split('/').pop() ?? absPath,
    date,
    year,
    monthDay: monthDayOf(date),
    born,
    died,
  };
};

/**
 * Everyone under `root` whose `born` (or `died`) is present and starts with a
 * year — one listing, no attr scan. See the note above for what it gives up.
 */
export const listedPeople = async (cmd: Command, root: string, ref: 'born' | 'died'): Promise<DatedPerson[]> => {
  let entries;
  try {
    entries = await cmd.sys.vfs.children(cmd.access, root);
  } catch {
    return [];
  }

  const people: DatedPerson[] = [];
  for (const entry of entries) {
    if (entry.node.type !== NODE_TYPE_PERSON) continue;
    const dated = toDated(`${root}/${entry.name}`, entry.node.attrs as Record<string, unknown>, entry.node.id, ref);
    if (dated) people.push(dated);
  }
  return people;
};

/**
 * Everyone whose `born` (or `died`) is present and starts with a year.
 *
 * Unordered on purpose: the whole set is needed regardless, and ordering by the
 * attr would exclude nobody while costing an index scan.
 */
export const datedPeople = async (cmd: Command, ref: 'born' | 'died'): Promise<DatedPerson[]> => {
  const rows = await cmd.sys.vfs.query(cmd.access, {
    types: [NODE_TYPE_PERSON],
    where: [{ ref, op: 'exists' }],
    limit: PEOPLE_LIMIT,
  });

  const people: DatedPerson[] = [];
  for (const row of rows) {
    const dated = toDated(row.absPath, row.node.attrs as Record<string, unknown>, row.id, ref);
    if (dated) people.push(dated);
  }
  return people;
};
