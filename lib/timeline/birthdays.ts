/**
 * Recurring birthdays — the one timeline source with nothing behind it in the
 * store.
 *
 * A birthday is arithmetic on a birth date, so there is no node to query and no
 * cursor to keep: the people are loaded once and `recurringSource` walks the
 * calendar years, which is the same walk wedding anniversaries take
 * (`partnerships.ts`).
 */

import type { Command } from '@ein/client';
import { entryKey } from '@archive/timeline/paging';
import { ASSUMED_LIFESPAN, datedPeople, type DatedPerson, yearOf } from './people-dates.ts';
import { type Recurrence, type RecurringOptions, recurringSource } from './recurring.ts';
import { listSource, type TimelineSource } from './sources.ts';

/**
 * Everyone with a birth date precise enough to celebrate, as recurrences.
 *
 * A year-only birth date (`1815`, which much of an imported corpus has) is
 * dropped here rather than in the store: there is no day to put a birthday on,
 * and inventing 1 Jan would be a lie the feed then sorts on.
 */
const celebrants = async (cmd: Command): Promise<Recurrence[]> => {
  // Without a death date someone is assumed dead after `ASSUMED_LIFESPAN`: a
  // guess wrong by decades rather than by a century, and it only removes entries.
  const lastYear = (person: DatedPerson): number => (person.died ? yearOf(person.died) : undefined) ?? person.year + ASSUMED_LIFESPAN;

  return (await datedPeople(cmd, 'born')).flatMap((person): Recurrence[] => {
    if (!person.monthDay) return [];

    return [{
      monthDay: person.monthDay,
      originYear: person.year,
      lastYear: lastYear(person),
      emit: (date, age) => ({
        kind: 'birthday',
        key: entryKey(person.id, 'birthday', date.slice(0, 4)),
        date,
        path: person.path,
        title: `${person.name} turns ${age}`,
        ownerPath: person.path,
        people: [person.path],
        age,
        years: age,
      }),
    }];
  });
};

/** Birthdays as a source, walking calendar years out from the page boundary. */
export const birthdaySource = async (cmd: Command, opts: RecurringOptions): Promise<TimelineSource> => {
  if (opts.mode === 'none') return listSource('birthday', []);
  return recurringSource('birthday', await celebrants(cmd), opts);
};
