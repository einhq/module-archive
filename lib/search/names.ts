/**
 * Names in a search, resolved to what `search` takes: a person, the people a partial name matches,
 * a location node, or — a country, a city — an area. Each runs an existing command or lookup as
 * the asker, and remembers what it found in `Names`, so one search resolves a name the same way
 * twice.
 */

import type { SearchParseRegion } from '@ein/api';
import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { boundsOf, nominatimSearch } from '@archive/location/geocode';
import { makeCtx } from '@archive/people/genealogy';
import { kinInMessage, parseKin, type Relative, walkKin } from '@archive/people/kin';

const NAME_LIMIT = 5;
/** A confident name match: exact, or a prefix that ends where a word of the name does (`nameScore`). */
const NAME_MATCH = 0.8;
const SLUG = /^[\p{L}\p{N}._-]+$/u;

/** A name that resolves to nothing, said so a person can act on it. */
class NameError extends Error {}

/** What one search has looked up. */
type Names = {
  /** The search as written, so a kin phrase can be checked against the user's own words. */
  message: string;
  /** The asker's person slug, looked up once when a name is "mig" or "min dotter"; null when the account has none. */
  user?: string | null;
  people: Map<string, { name: string; path: string }>;
  locations: Map<string, { name: string; path: string }>;
  regions: Map<string, { name: string; region: SearchParseRegion }>;
};

export const namesFor = (message: string): Names => ({ message, people: new Map(), locations: new Map(), regions: new Map() });

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const slugOfPath = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

const runJson = async (cmd: Command, line: string): Promise<unknown> => {
  const ran = await cmd.execute(`JSON_OUTPUT=1 ${line}`);
  try {
    return ran.stdout.trim() ? JSON.parse(ran.stdout) : null;
  } catch {
    return null;
  }
};

/** The asker's own person, by slug: what "mig" and "min dotter" mean. */
const userOf = async (cmd: Command, names: Names): Promise<string | undefined> => {
  if (names.user === undefined) {
    const personPath = str(asRecord(await runJson(cmd, 'user-whoami')).personPath);
    names.user = personPath ? slugOfPath(personPath) : null;
  }
  return names.user ?? undefined;
};

type SubjectHit = { slug: string; name: string; score: number };

const subjectSearch = async (cmd: Command, provider: string, name: string, table: Names['people']): Promise<SubjectHit[]> => {
  const hits: SubjectHit[] = [];
  for (const raw of (asRecord(await runJson(cmd, `${provider} ${shq(name)} -l ${NAME_LIMIT}`)).results as unknown[] | undefined) ?? []) {
    const hit = asRecord(raw);
    const path = str(hit.path);
    if (!path) continue;
    const slug = slugOfPath(path);
    const label = str(hit.name) ?? slug;
    table.set(slug, { name: label, path });
    hits.push({ slug, name: label, score: Math.round((num(hit.score) ?? 0) * 100) / 100 });
  }
  return hits;
};

/** The user, written as a pronoun where a person goes. */
const SELF_WORDS = new Set(['i', 'me', 'my', 'myself', 'jag', 'mig', 'min', 'mitt', 'mina', 'mig själv']);

/**
 * A name no location node carries, as an area: a country or a city is a box, not a point. Nothing
 * found is undefined: an area that cannot be located is reported as unknown, never widened to the
 * world.
 */
const geocodeRegion = async (cmd: Command, name: string): Promise<SearchParseRegion | undefined> => {
  try {
    const results = await nominatimSearch(name, { limit: 1, countrycodes: '', baseUrl: cmd.env.NOMINATIM_SEARCH_URL || undefined });
    const bounds = results[0] ? boundsOf(results[0]) : undefined;
    return bounds ? { shape: 'bbox', ...bounds } : undefined;
  } catch {
    return undefined;
  }
};

/** What a person resolved to: one person, or a partial name the search unions itself. */
type PersonFilter = { slug: string; name: string } | { partial: string; matches: { slug: string; name: string }[] };

/**
 * A slug rather than a name: the user's own, or one written as a path. Looked up as a node, not
 * searched as a name — `search-people` scores names, and "olof-strand" is not one.
 */
const nodeBySlug = async (cmd: Command, root: string, value: string): Promise<{ slug: string; name: string } | undefined> => {
  const slug = value.split('/').filter(Boolean).pop() ?? '';
  if (!slug || /\s/.test(slug) || !SLUG.test(slug)) return undefined;
  try {
    const node = await cmd.sys.vfs.get(cmd.access, `${root}/${slug}`);
    return { slug, name: str(node.attrs.name) ?? slug };
  } catch {
    return undefined;
  }
};

/**
 * The people a kin phrase reaches from one person, through the graph (`kin.ts`). Nobody is an
 * error, and so is a phrase that is not kin words at all.
 */
const relativesOf = async (cmd: Command, of: { slug: string; name: string }, phrase: string, names: Names): Promise<Relative[]> => {
  const terms = parseKin(phrase);
  if (!terms) throw new NameError(`unknown relation ${JSON.stringify(phrase)}`);
  const found = await walkKin(makeCtx(cmd.sys.vfs, cmd.access), `${PEOPLE_ROOT}/${of.slug}`, terms);
  for (const rel of found) names.people.set(rel.slug, { name: rel.name, path: rel.path });
  if (found.length === 0) throw new NameError(`no ${phrase} is recorded for ${of.name} in the family tree`);
  return found;
};

/**
 * A person as written — a name, a slug, "mig", or a kin phrase from the user ("min dotter") —
 * resolved to what `search` takes.
 *
 * An exact or prefix match to one person is that person. Several confident matches, or only
 * partial ones, become a `--subject-name person:…` group — the union `search` defines for a
 * partial name, the same reading the search box gives "Olof". No match is a `NameError`.
 */
export const resolvePerson = async (cmd: Command, written: string, names: Names): Promise<PersonFilter> => {
  let name = written.trim().slice(0, 200);
  if (!name) throw new NameError('a person must be a name or a slug');
  let relation: string | undefined;
  if (SELF_WORDS.has(name.toLowerCase())) {
    const user = await userOf(cmd, names);
    if (!user) throw new NameError(`${JSON.stringify(name)} is the asker, whose account is linked to no person`);
    name = user;
  } else if (parseKin(name)) {
    const user = await userOf(cmd, names);
    if (!user) throw new NameError(`${JSON.stringify(name)} is a relation, and the asker's account is linked to no person`);
    relation = name;
    name = user;
  }

  const base = await (async (): Promise<PersonFilter> => {
    const slug = name.split('/').filter(Boolean).pop() ?? name;
    const known = names.people.get(slug) ?? await nodeBySlug(cmd, PEOPLE_ROOT, name);
    if (known) {
      names.people.set(slug, { name: known.name, path: `${PEOPLE_ROOT}/${slug}` });
      return { slug, name: known.name };
    }
    const hits = await subjectSearch(cmd, 'search-people', name, names.people);
    if (hits.length === 0) throw new NameError(`no person named ${JSON.stringify(name)}`);
    // One confident match, or one match of any kind, is that person: "Olof Strand" against
    // a stored "Olof J Strand-Wik" is an all-words match just under the prefix score,
    // and there is nobody else it could be.
    const confident = hits.filter((hit) => hit.score >= NAME_MATCH);
    // "Harald Nyberg" beside "Henrik D Nyberg": only one hit carries every word asked for.
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    const whole = hits.filter((hit) => {
      const have = new Set(hit.name.toLowerCase().split(/[\s-]+/));
      return words.every((word) => have.has(word));
    });
    const only = confident.length === 1 ? confident[0] : hits.length === 1 ? hits[0] : whole.length === 1 ? whole[0] : undefined;
    if (only) return { slug: only.slug, name: only.name };
    return { partial: name, matches: hits.map(({ slug, name }) => ({ slug, name })) };
  })();

  if (relation === undefined) return base;
  if ('partial' in base) throw new NameError(`${JSON.stringify(name)} matches several people; name one to ask for their ${relation}`);
  // The user's own kin phrase when the search has exactly one, else the model's.
  const phrase = kinInMessage(names.message) ?? relation;
  const found = await relativesOf(cmd, base, phrase, names);
  if (found.length > 1) throw new NameError(`${base.name} has ${found.length} matching ${phrase}`);
  return { slug: found[0].slug, name: found[0].name };
};

/**
 * A location: a slug seen, a location node by name, or — a country, a landscape — an area.
 * `geocode: false` stops at the location nodes, for a name that may not be a location at all.
 */
export const resolveLocation = async (
  cmd: Command,
  written: string,
  names: Names,
  { geocode = true }: { geocode?: boolean } = {},
): Promise<{ slug: string } | { region: { name: string; region: SearchParseRegion } }> => {
  const name = written.trim().slice(0, 200);
  if (!name) throw new NameError('a location must be a name or a slug');
  const slug = name.split('/').filter(Boolean).pop() ?? name;
  if (names.locations.has(slug)) return { slug };
  const node = await nodeBySlug(cmd, LOCATIONS_ROOT, name);
  if (node) {
    names.locations.set(slug, { name: node.name, path: `${LOCATIONS_ROOT}/${slug}` });
    return { slug };
  }
  const hits = await subjectSearch(cmd, 'search-location', name, names.locations);
  const best = hits.filter((hit) => hit.score >= NAME_MATCH).sort((a, b) => b.score - a.score)[0];
  if (best) return { slug: best.slug };
  if (!geocode) throw new NameError(`no location named ${JSON.stringify(name)}`);
  const known = names.regions.get(name.toLowerCase());
  if (known) return { region: known };
  const geocoded = await geocodeRegion(cmd, name);
  if (!geocoded) throw new NameError(`no location named ${JSON.stringify(name)}, and no area by that name either`);
  const region = { name, region: geocoded };
  names.regions.set(name.toLowerCase(), region);
  return { region };
};
