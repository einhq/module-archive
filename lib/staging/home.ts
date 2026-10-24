/**
 * Where home is, per year, for one inbox: what a suggested album's "away" is measured against.
 *
 * For each year the inbox has photos in, the first of these that gives a place:
 *
 *   1. `flag`, the analysis command's `--home`, for every year;
 *   2. the owner's person (`<USERS_PATH>/<user>/person`, on the account) and the residence of theirs (`homes/`) that
 *      covers most of that year, at its location's point;
 *   3. the densest cell of the inbox's own points that year, when it holds at least a quarter of
 *      them;
 *   4. the year before's home;
 *   5. none: nothing that year counts as away.
 *
 * Only the inbox and the owner's own records are read: the cost does not grow with the archive.
 */
import type { AutoAlbumHome } from '@archive/staging/api';
import type { Access, NodeVFS } from '@ein/client';
import { USERS_PATH } from '@ein/paths';
import { comparableDate } from '@archive/people/genealogy';
import { readResidences } from '@archive/people/residence';
import { usualLocation } from '@archive/staging/cluster';
import { pointsOf } from '@archive/staging/signals';

type Geo = { lat: number; lng: number };

/** The inbox's densest cell is home only when it holds this share of that year's points. */
const INBOX_HOME_SHARE = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last day a partial date (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) covers. */
const lastDay = (date: string): string => {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  if (d) return comparableDate(date);
  const end = m ? new Date(Date.UTC(y, m, 0)) : new Date(Date.UTC(y, 11, 31));
  return end.toISOString().slice(0, 10);
};

/** Days of `year` a residence from `from` to `to` (either end open) covers. */
const daysIn = (year: string, from?: string, to?: string): number => {
  const start = Math.max(Date.parse(`${year}-01-01`), from ? Date.parse(comparableDate(from)) : -Infinity);
  const end = Math.min(Date.parse(`${year}-12-31`), to ? Date.parse(lastDay(to)) : Infinity);
  return end < start ? 0 : Math.round((end - start) / DAY_MS) + 1;
};

/** The owner's residences, each with its location's point; none when the owner has no person. */
const residencesOf = async (vfs: NodeVFS, access: Access, user: string) => {
  const link = await vfs.get(access, `${USERS_PATH}/${user}/person`, { follow: false }).catch(() => undefined);
  const person = link?.props.softlink;
  if (!person) return [];
  const residences = (await readResidences(vfs, access, person)).filter((entry) => entry.target);
  const locations = await Promise.all([...new Set(residences.map((entry) => entry.target))].map(async (path) => {
    const node = await vfs.get(access, path).catch(() => undefined);
    return node ? [path, node.id] as const : undefined;
  }));
  const idOf = new Map(locations.filter((entry) => entry !== undefined));
  const points = await pointsOf(vfs, access, [...idOf.values()]);
  return residences.flatMap((entry) => {
    const point = points.get(idOf.get(entry.target) ?? '');
    return point ? [{ ...point, location: entry.target, from: entry.from, to: entry.to }] : [];
  });
};

/**
 * Home for each of `years` (`YYYY`): `pointsByYear` holds the inbox's own GPS points by the local
 * year they were taken in; `flag` overrides everything. Years without a home are absent.
 */
export const homesByYear = async (
  vfs: NodeVFS,
  access: Access,
  opts: { user: string; years: Iterable<string>; pointsByYear: ReadonlyMap<string, Geo[]>; flag?: Geo },
): Promise<Map<string, AutoAlbumHome>> => {
  const years = [...new Set(opts.years)].sort();
  const homes = new Map<string, AutoAlbumHome>();
  if (opts.flag) {
    for (const year of years) homes.set(year, { ...opts.flag, source: 'flag' });
    return homes;
  }

  const residences = years.length > 0 ? await residencesOf(vfs, access, opts.user) : [];
  let previous: AutoAlbumHome | undefined;
  for (const year of years) {
    let best: { days: number; home: AutoAlbumHome } | undefined;
    for (const residence of residences) {
      const days = daysIn(year, residence.from, residence.to);
      if (days > 0 && (!best || days > best.days)) {
        best = { days, home: { lat: residence.lat, lng: residence.lng, source: 'residence', location: residence.location } };
      }
    }
    const cell = best ? undefined : usualLocation(opts.pointsByYear.get(year) ?? [], INBOX_HOME_SHARE);
    const home = best?.home ?? (cell ? { ...cell, source: 'inbox' as const } : previous && { ...previous, source: 'previous' as const });
    if (home) homes.set(year, home);
    previous = home ?? previous;
  }
  return homes;
};
