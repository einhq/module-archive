/**
 * Recurring events around today — what `events-anniversaries` gives the home page's Events:
 * what is coming up, and what just passed.
 *
 * The timeline's birthday source cannot answer this. It deliberately emits
 * nothing dated after today (`birthdays.ts`, `admits`), because a feed you
 * scroll backwards through has no use for next month. The home page is the
 * opposite question: what is about to happen, and what just did.
 *
 * The window is at most a year wide, which is what makes this cheap. Rather
 * than walking years like the timeline does, each recurring thing is checked
 * against the one or two calendar years the window touches — so the cost is the
 * two person listings and one relation query, and nothing else scales with the
 * width of the window.
 *
 * Three kinds recur:
 *
 *  - **birthdays**, from `person.born`. Someone who has died gets "would have
 *    turned", still bounded by `ASSUMED_LIFESPAN`.
 *  - **memorials**, from `person.died`, and *only on milestone years*. A
 *    genealogy holds hundreds of death dates; a family marks fifty years since
 *    one, not a hundred and eighty-seven, and emitting every one of them every
 *    year buries the page in ancestors nobody alive has met.
 *  - **wedding anniversaries**, from the dated partner relations — the same
 *    read the timeline's anniversary source walks (`partnerships.ts`).
 */

import type { Command } from '@ein/client';
import { entryKey } from '@archive/timeline/paging';
import { nameOf } from './enrich.ts';
import { ASSUMED_LIFESPAN, type DatedPerson, isMilestone, listedPeople, yearOf } from './people-dates.ts';
import { datedPartnerships, partnershipDeaths, partnershipLastYear, partnershipYears } from './partnerships.ts';
import { isRealDate } from './recurring.ts';
import type { TimelineEntry } from './api.ts';

/** One occurrence of something that comes round every year. */
export type Anniversary = TimelineEntry & {
  /** Signed days from today: negative has just passed, 0 is today, positive is coming up. */
  daysAway: number;
  /** Which anniversary this is — the age, or the years married. */
  years: number;
  /** A round number, by the timeline's own milestone rule. */
  milestone: boolean;
};

const MS_PER_DAY = 86_400_000;

const utc = (date: string): number => Date.parse(`${date}T00:00:00Z`);

const addDays = (date: string, days: number): string => new Date(utc(date) + days * MS_PER_DAY).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number => Math.round((utc(to) - utc(from)) / MS_PER_DAY);

type AnniversaryOptions = {
  /** Today, as `YYYY-MM-DD`. Injected so tests are not tied to the wall clock. */
  today: string;
  /** How many days back the window reaches. */
  past: number;
  /** How many days forward the window reaches. */
  ahead: number;
  limit: number;
  /**
   * Where to read people from. A listing rather than an attr scan — see
   * `people-dates.ts` for what that trades away, and why a panel about the next
   * month is the right place to trade it.
   */
  peopleRoot: string;
};

type Recurrence = {
  /** `MM-DD` the thing comes round on. */
  monthDay: string;
  /** The year it first happened; the occurrence year minus this is `years`. */
  originYear: number;
  /** Build the entry once the occurrence date and count are known. */
  emit: (date: string, years: number) => Anniversary | undefined;
};

/**
 * Every occurrence of `recurrence` that lands inside the window.
 *
 * A window at most a year wide touches one or two calendar years, so those are
 * the only candidates — the leap-day and "not yet happened" cases fall out as
 * ordinary rejections rather than needing rules of their own.
 */
const occurrences = (recurrence: Recurrence, from: string, to: string): Anniversary[] => {
  const years = new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))]);
  const found: Anniversary[] = [];

  for (const year of years) {
    const date = `${year}-${recurrence.monthDay}`;
    if (!isRealDate(date) || date < from || date > to) continue;

    // Age 0 is the birth itself, and year 0 is the wedding day: the timeline
    // already emits those as what they were, and an "anniversary" of something
    // that has not happened yet is not one.
    const count = year - recurrence.originYear;
    if (count <= 0) continue;

    const entry = recurrence.emit(date, count);
    if (entry) found.push(entry);
  }

  return found;
};

/** Birthdays, including posthumous ones within a plausible lifespan. */
const birthdayRecurrences = (people: DatedPerson[]): Recurrence[] =>
  people.flatMap((person): Recurrence[] => {
    if (!person.monthDay) return [];
    const diedYear = person.died ? yearOf(person.died) : undefined;

    return [{
      monthDay: person.monthDay,
      originYear: person.year,
      emit: (date, years) => {
        // The same bound the timeline uses, for the same reason: without it a
        // corpus of nineteenth-century ancestors celebrates forever.
        if (years > ASSUMED_LIFESPAN) return undefined;
        const posthumous = diedYear !== undefined && Number(date.slice(0, 4)) > diedYear;

        return {
          kind: 'birthday',
          key: entryKey(person.id, 'birthday', date.slice(0, 4)),
          date,
          path: person.path,
          title: posthumous ? `${person.name} would have turned ${years}` : `${person.name} turns ${years}`,
          ownerPath: person.path,
          people: [person.path],
          daysAway: 0,
          years,
          milestone: isMilestone(years),
        };
      },
    }];
  });

/** Milestone memorials only — see the note at the top of the file. */
const memorialRecurrences = (people: DatedPerson[]): Recurrence[] =>
  people.flatMap((person): Recurrence[] => {
    if (!person.monthDay) return [];

    return [{
      monthDay: person.monthDay,
      originYear: person.year,
      emit: (date, years) => {
        if (!isMilestone(years)) return undefined;

        return {
          kind: 'death',
          key: entryKey(person.id, 'death', date.slice(0, 4)),
          date,
          path: person.path,
          title: `${years} years since ${person.name} died`,
          ownerPath: person.path,
          people: [person.path],
          daysAway: 0,
          years,
          milestone: true,
        };
      },
    }];
  });

/**
 * Wedding anniversaries, from the dated partner relations.
 *
 * Not from the wedding's event file: the event names one spouse and never both, it goes on recurring after
 * a couple has parted, and a partnership dated by hand has no event at all. See
 * `partnerships.ts`.
 *
 * Only a full `YYYY-MM-DD` recurs — a marriage recorded as `1923` has no day to
 * come round on — and the recurrence stops when the partnership did, when the
 * first of the two died, or after an assumed span.
 */
const partnershipRecurrences = async (cmd: Command): Promise<Recurrence[]> => {
  const partnerships = await datedPartnerships(cmd);
  if (partnerships.length === 0) return [];
  // Read for the couples rather than taken from the listing below: a partner
  // filed outside the people root still has a death date that ends this.
  const deaths = await partnershipDeaths(cmd, partnerships);

  return partnerships.flatMap((couple): Recurrence[] => {
    if (!couple.monthDay) return [];
    const lastYear = partnershipLastYear(couple, (path) => deaths.get(path));

    return [{
      monthDay: couple.monthDay,
      originYear: couple.year,
      emit: (date, years) => {
        if (Number(date.slice(0, 4)) > lastYear) return undefined;

        return {
          kind: 'anniversary',
          key: entryKey(couple.id, 'anniversary', date.slice(0, 4)),
          date,
          // A couple has no page and a person does, so the card opens on the
          // half the relation was read from.
          path: couple.ownerPath,
          // Replaced below, once both names have been read.
          title: partnershipYears(couple.kind, '', years),
          ownerPath: couple.ownerPath,
          people: [couple.ownerPath, couple.partnerPath],
          eventType: couple.kind ?? 'partner',
          daysAway: 0,
          years,
          milestone: isMilestone(years),
        };
      },
    }];
  });
};

/**
 * The recurring events falling within `past` days behind and `ahead` days in
 * front of `today`.
 *
 * Milestones decide what survives `limit`, then nearness, and of two as near the
 * one still to come; the date decides what order the survivors come back in.
 * Truncating on nearness alone would drop a golden wedding three weeks out in
 * favour of a dozen ordinary birthdays tomorrow, which is precisely backwards;
 * reordering on milestones instead would put a page that reads as a calendar
 * out of calendar order.
 */
export const upcomingAnniversaries = async (cmd: Command, opts: AnniversaryOptions): Promise<Anniversary[]> => {
  const from = addDays(opts.today, -Math.abs(opts.past));
  const to = addDays(opts.today, Math.abs(opts.ahead));

  const [born, died, partnerships] = await Promise.all([
    listedPeople(cmd, opts.peopleRoot, 'born'),
    listedPeople(cmd, opts.peopleRoot, 'died'),
    partnershipRecurrences(cmd),
  ]);

  const found = [...birthdayRecurrences(born), ...memorialRecurrences(died), ...partnerships]
    .flatMap((recurrence) => occurrences(recurrence, from, to))
    .map((entry) => ({ ...entry, daysAway: daysBetween(opts.today, entry.date) }));

  const selected = found
    .toSorted((a, b) => Number(b.milestone) - Number(a.milestone) || Math.abs(a.daysAway) - Math.abs(b.daysAway) || b.daysAway - a.daysAway)
    .slice(0, opts.limit)
    .toSorted((a, b) => a.daysAway - b.daysAway || a.key.localeCompare(b.key));

  // Deliberately *not* `enrichPage`, which is what the timeline runs over its
  // own page. Enrichment costs a handful of listings per entry — the cover
  // link, the events directory, the partner relation — and an anniversary card
  // reads none of it: it shows a face the page fetches itself, a title and a
  // date. The one
  // thing that does have to be resolved is who a wedding was between, because
  // the sentence names them both — two `get`s per couple on the page, cached so
  // a person married on several of them is read once.
  const cache = new Map<string, Promise<unknown>>();
  await Promise.all(selected.map(async (entry) => {
    if (entry.kind !== 'anniversary') return;

    const names = await Promise.all((entry.people ?? []).map((path) => nameOf(cmd, cache, path)));
    entry.title = partnershipYears(entry.eventType, names.join(' and '), entry.years);
  }));

  return selected;
};
