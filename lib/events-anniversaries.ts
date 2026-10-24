/**
 * events-anniversaries — birthdays, memorials and wedding anniversaries around a date, as
 * `events` entries: archive's part of the home page's Events. The walk is
 * `upcomingAnniversaries`; each entry is drawn by archive's `/events/anniversary` route, whose
 * query carries the kind, the person it is about, the people whose faces it shows, the sentence
 * and whether it is a milestone.
 */

import type { EventEntry, Provided } from '@ein/api';
import { PEOPLE_ROOT } from '@archive/paths';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '@ein/client';
import type { CmdReturn, Command } from '@ein/client';
import { type Anniversary, upcomingAnniversaries } from './timeline/anniversaries.ts';

/** The route that draws one entry. */
const ENTRY_ROUTE = '/events/anniversary';

/** The window and the limit when the command is run on its own; core's `events` always passes its own. */
const DEFAULT_DAYS_AHEAD = 30;
const DEFAULT_DAYS_PAST = 7;
const DEFAULT_LIMIT = 16;

/**
 * A count flag's value. `--days-ahead -3` arrives as an empty value (a leading
 * `-` starts a new option), and an unguarded `Number('')` would be a silent 0.
 */
const count = (raw: string | undefined, fallback: number): number | undefined => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : undefined;
};

/**
 * An occurrence as an entry, about the person it is read from. Its route shows both partners'
 * faces for a wedding, and the person's for anything else.
 */
const entryOf = (entry: Anniversary): Provided<EventEntry> => {
  const query = new URLSearchParams({ kind: entry.kind, path: entry.path, title: entry.title });
  for (const face of entry.people?.length ? entry.people.slice(0, 2) : [entry.ownerPath ?? entry.path]) query.append('people', face);
  if (entry.milestone) query.set('milestone', '1');
  return { date: entry.date, title: entry.title, milestone: entry.milestone, path: entry.ownerPath ?? entry.path, route: `${ENTRY_ROUTE}?${query}` };
};

export const eventsAnniversaries = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    string: ['days-ahead', 'days-past', 'limit', 'today', 'people'],
    unknown: collectUnknownFlags(unknown),
  });

  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const numbers: Record<string, number> = {};
  for (const [name, fallback] of [['days-ahead', DEFAULT_DAYS_AHEAD], ['days-past', DEFAULT_DAYS_PAST], ['limit', DEFAULT_LIMIT]] as const) {
    const value = count(flags[name], fallback);
    if (value === undefined) {
      await cmd.writeError(`events-anniversaries: --${name} must be a non-negative whole number\n`);
      return 1;
    }
    numbers[name] = value;
  }

  const today = flags.today ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00Z`))) {
    await cmd.writeError(`events-anniversaries: --today must be YYYY-MM-DD, got '${today}'\n`);
    return 1;
  }

  const found = await upcomingAnniversaries(cmd, {
    today,
    past: numbers['days-past'],
    ahead: numbers['days-ahead'],
    limit: numbers.limit,
    peopleRoot: flags.people ?? PEOPLE_ROOT,
  });

  if (cmd.json) {
    await cmd.writeJSON(found.map(entryOf) satisfies Provided<EventEntry>[]);
    return 0;
  }

  for (const entry of found) {
    const when = entry.daysAway === 0 ? 'today' : entry.daysAway > 0 ? `in ${entry.daysAway}d` : `${-entry.daysAway}d ago`;
    await cmd.writeLn(`${entry.date}  ${when.padStart(8)}  ${entry.milestone ? '*' : ' '} ${entry.title}`);
  }
  return 0;
};

eventsAnniversaries.spec = {
  name: 'events-anniversaries',
  effect: 'read' as const,
  description: 'Birthdays, memorials and wedding anniversaries around a date, as events entries (core events gathers them)',
  args: [],
  flags: [
    { name: 'days-ahead', type: 'number' as const, description: `how far forward to look (default ${DEFAULT_DAYS_AHEAD})` },
    { name: 'days-past', type: 'number' as const, description: `how far back to look (default ${DEFAULT_DAYS_PAST})` },
    { name: 'limit', type: 'number' as const, description: `anniversaries returned; milestones survive the cut (default ${DEFAULT_LIMIT})` },
    { name: 'today', type: 'string' as const, description: 'the date to look around, YYYY-MM-DD (default today, UTC)' },
    { name: 'people', type: 'path' as const, description: `people root to read (default ${PEOPLE_ROOT})` },
  ],
  examples: [
    'events-anniversaries',
    'events-anniversaries --days-ahead 0 --days-past 0',
    'events-anniversaries --today 2026-12-24 --days-ahead 7',
  ],
  returns:
    'each birthday, milestone memorial and wedding anniversary in the window as an events entry, in date order: the day, the sentence, whether it is a milestone, the person, and the route that draws it.',
};
