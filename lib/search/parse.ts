/**
 * A written search, turned into search filters: `archive-parse`, the command `CFG_SEARCH_PARSER`
 * names for the search box and for whatever else reads a search through core's `parse-search`.
 *
 * "Bilder från Italien 2011 när Olof och Stina var där" becomes photos, 2011, the person Olof
 * (or every Olof, when the name is not one person), and Italy's box. Two passes, each doing
 * what it is sure of:
 *
 * - the rules (`rules.ts`) read years and kinds — a closed vocabulary, and "före 2010" is a bound
 *   they read more exactly than a model does;
 * - a language model, when `CFG_LANGUAGE_MODEL` names one (`proposal.ts`), proposes the people,
 *   the locations and the words that describe the pictures.
 *
 * A name resolves to one person when it is one person, a partial name (the union
 * `search --subject-name person:…` defines) when it is several, a location node, or — a country, a
 * city — a geocoded box (`names.ts`). A name that resolves to nothing stays in the text and is
 * reported, so the UI can say it was searched as words. The user and their family are read from
 * the user's own words, not the model's: "me", "mig", "my mother", "min mammas syster" are the
 * person the account is linked to, or who the family tree says is that relation of them. One that
 * resolves to nobody — no linked person, no such relative, two kin phrases — is reported the same
 * way.
 *
 * It never fails to produce a parse: without a model, or with an answer that does not hold up,
 * the rules pass is the answer (`source: 'rules'`).
 */

import type { Command } from '@ein/client';
import type { SearchParse, SearchParseRegion } from '@ein/api';
import { askForProposal } from './proposal.ts';
import { namesFor, resolveLocation, resolvePerson, selfInMessage } from './names.ts';
import { contentWords, parseWithRules, type RuleKind, stripNamedFilters } from './rules.ts';
import { KIN_WORDS, kinInMessage } from '@archive/people/kin';

type PersonMatch = { name: string; slug: string };

/** A name the search gave: `slug` when it is one person, otherwise every person it matches. */
type PersonRef = { name: string; slug?: string; matches: PersonMatch[] };

/** A location the search gave: a location node, or an area. */
type LocationRef = { name: string; slug?: string; region?: SearchParseRegion };

export type ParsedSearch = {
  /** What the pictures should show, for the semantic search; empty when nothing is left. */
  text: string;
  kinds: RuleKind[];
  from?: string;
  to?: string;
  people: PersonRef[];
  locations: LocationRef[];
  /** The one area among `locations`, when there is one: `search` takes a single box. */
  region?: SearchParseRegion;
  /** Names that matched nothing, searched as words instead. */
  unresolved: string[];
  source: 'llm' | 'rules';
  /** A one-line account of the filters, written from what resolved rather than what was proposed. */
  explain: string;
};

type ParseOptions = {
  /** Only the rules: no model, no name lookups. The search box's instant first pass. */
  rules?: boolean;
};

/**
 * A kin word in a search — "pappa", "moster" — that no person asked for carries. It is reported
 * rather than left out: whoever reads the parse knows it is not the whole of what was asked.
 */
const KIN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${KIN_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'giu');

const words = (text: string): string[] => text.toLocaleLowerCase('sv').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The model's description, when every word of it is the user's; a paraphrase is not. A word the
 * rules already made a filter of — "album", "2019", the glue beside them — is left out: it is
 * a kind or a year now, not something the pictures show.
 */
const writtenText = (input: string, text: string, rulesText: string): string | undefined => {
  const have = new Set(words(input));
  const rest = contentWords(text);
  if (!words(rest).every((word) => have.has(word))) return undefined;
  const kept = new Set(words(rulesText));
  const used = new Set(words(input).filter((word) => !kept.has(word)));
  return rest.split(/\s+/).filter((word) => !words(word).every((part) => used.has(part))).join(' ');
};

/** The account's words, in the two languages a search is written in here. */
const WORDS = {
  en: {
    kinds: { photo: 'photos', video: 'videos', audio: 'audio', document: 'documents', person: 'people', location: 'locations', album: 'albums' },
    everything: 'everything',
    and: 'and',
    matching: (text: string) => `matching "${text}"`,
    of: 'of',
    partly: 'with names containing',
    in: 'in',
    year: (year: string) => `from ${year}`,
    between: (from: string, to: string) => `between ${from} and ${to}`,
    since: (year: string) => `from ${year} onwards`,
    until: (year: string) => `up to ${year}`,
  },
  sv: {
    kinds: { photo: 'bilder', video: 'filmer', audio: 'ljud', document: 'dokument', person: 'personer', location: 'platser', album: 'album' },
    everything: 'allt',
    and: 'och',
    matching: (text: string) => `som matchar "${text}"`,
    of: 'på',
    partly: 'med namn som innehåller',
    in: 'i',
    year: (year: string) => `från ${year}`,
    between: (from: string, to: string) => `mellan ${from} och ${to}`,
    since: (year: string) => `från ${year} och framåt`,
    until: (year: string) => `till och med ${year}`,
  },
} satisfies Record<string, { kinds: Record<RuleKind, string> } & Record<string, unknown>>;

/** A search is Swedish when it has a Swedish word in it; otherwise the account is in English. */
const SWEDISH = /(?<![\p{L}\p{N}])(visa|hitta|bilder|bild|foton|filmer|på|från|och|med|till|mellan|före|efter|när|där|som|mig|min|mina|vi|oss|hemma)(?![\p{L}\p{N}])/iu;

/**
 * A one-line account of what the parse resolved, in the language the search is written in:
 * "photos of Anna in Göteborg from 2019", "bilder på Anna i Göteborg från 2019". The search box
 * shows it, and an answer can say it.
 */
const explain = (parsed: Omit<ParsedSearch, 'explain'>, query: string): string => {
  const sv = SWEDISH.test(query);
  const w = sv ? WORDS.sv : WORDS.en;
  const and = (names: string[]) => names.join(` ${w.and} `);
  const parts: string[] = [parsed.kinds.length > 0 ? and(parsed.kinds.map((kind) => w.kinds[kind])) : w.everything];
  // English has the words first, as it always has; Swedish after who, where and when.
  if (parsed.text && !sv) parts.push(w.matching(parsed.text));
  const exact = parsed.people.filter((person) => person.slug).map((person) => person.matches[0]?.name ?? person.name);
  const partial = parsed.people.filter((person) => !person.slug).map((person) => person.name);
  if (exact.length > 0) parts.push(`${w.of} ${and(exact)}`);
  if (partial.length > 0) parts.push(`${w.partly} ${and(partial)}`);
  if (parsed.locations.length > 0) parts.push(`${w.in} ${and(parsed.locations.map((location) => location.name))}`);
  if (parsed.from && parsed.to) parts.push(parsed.from === parsed.to ? w.year(parsed.from) : w.between(parsed.from, parsed.to));
  else if (parsed.from) parts.push(w.since(parsed.from));
  else if (parsed.to) parts.push(w.until(parsed.to));
  if (parsed.text && sv) parts.push(w.matching(parsed.text));
  return parts.join(' ');
};

export const parseSearch = async (cmd: Command, input: string, options: ParseOptions = {}): Promise<ParsedSearch> => {
  const query = input.trim();
  const done = (parsed: Omit<ParsedSearch, 'explain'>): ParsedSearch => ({ ...parsed, explain: explain(parsed, query) });
  const rules = parseWithRules(query);
  const byRules = (): ParsedSearch =>
    done({
      text: rules.text,
      kinds: rules.kinds,
      ...(rules.from ? { from: rules.from } : {}),
      ...(rules.to ? { to: rules.to } : {}),
      people: [],
      locations: [],
      unresolved: [],
      source: 'rules',
    });
  if (options.rules || !query) return byRules();

  const parsed = await askForProposal(cmd, query);
  if (!parsed) return byRules();
  const { request } = parsed;
  const names = namesFor(query);

  // The model proposes no pronoun or kin word, so the user's own are added to its people.
  const asker = [selfInMessage(query), kinInMessage(query)].filter((phrase): phrase is string =>
    phrase !== undefined && !request.people.some((name) => name.toLowerCase().includes(phrase.toLowerCase()))
  );
  const wanted = [...request.people, ...asker];

  const unresolved: string[] = [];
  /** A proposed person who is nobody, but whose name is a location node: typed bare, two names are hard to tell apart. */
  const asLocation: LocationRef[] = [];
  const [people, locations] = await Promise.all([
    Promise.all(wanted.map(async (name): Promise<PersonRef | undefined> => {
      try {
        const person = await resolvePerson(cmd, name, names);
        // "mig" or "min mamma" is shown as who it turned out to be.
        if ('slug' in person) return { name: asker.includes(name) ? person.name : name, slug: person.slug, matches: [{ name: person.name, slug: person.slug }] };
        return { name, matches: person.matches };
      } catch {
        // Only a location node, never a geocoded area: a misspelt name is somewhere on Earth.
        const location = await resolveLocation(cmd, name, names, { geocode: false }).catch(() => undefined);
        if (location && 'slug' in location) asLocation.push({ name: names.locations.get(location.slug)?.name ?? name, slug: location.slug });
        else unresolved.push(name);
        return undefined;
      }
    })),
    Promise.all(request.locations.map(async (name): Promise<LocationRef | undefined> => {
      try {
        const location = await resolveLocation(cmd, name, names);
        return 'slug' in location ? { name: names.locations.get(location.slug)?.name ?? name, slug: location.slug } : { name, region: location.region.region };
      } catch {
        unresolved.push(name);
        return undefined;
      }
    })),
  ]);
  // One person asked for twice, "Anna and me" when the user is Anna, is one subject.
  const resolvedPeople = people.filter((person, i): person is PersonRef =>
    person !== undefined && (person.slug === undefined || people.findIndex((other) => other?.slug === person.slug) === i)
  );
  for (const [kin] of query.matchAll(KIN)) {
    const word = kin.toLowerCase();
    if (!wanted.some((name) => name.toLowerCase().includes(word)) && !unresolved.includes(kin)) unresolved.push(kin);
  }
  // `search` takes one box: a second area is reported rather than silently dropped.
  let region: SearchParseRegion | undefined;
  const resolvedLocations: LocationRef[] = [...asLocation];
  for (const location of locations) {
    if (!location) continue;
    if (location.region) {
      if (region) {
        unresolved.push(location.name);
        continue;
      }
      region = location.region;
    }
    resolvedLocations.push(location);
  }

  // Years and kinds from the rules when they found any: they read "före 2010" as a bound.
  const fromRules = rules.from !== undefined || rules.to !== undefined;
  const from = fromRules ? rules.from : request.from;
  const to = fromRules ? rules.to : request.to;
  const kinds: RuleKind[] = rules.kinds.length ? rules.kinds : request.kinds;
  // The words that describe the pictures: the model's, when they are the user's own; otherwise
  // the user's words with the kinds, years and resolved names taken out.
  const named = [...request.people, ...request.locations].filter((name) => !unresolved.includes(name));
  // The user's pronoun and kin phrase are not something the pictures show, resolved or not: one
  // that is nobody comes back below, as what was not found.
  const described = stripNamedFilters(writtenText(query, request.text, rules.text) ?? contentWords(stripNamedFilters(rules.text, named)), asker);
  const text = [described, ...new Set(unresolved)].filter(Boolean).join(' ');

  return done({
    text,
    kinds,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    people: resolvedPeople,
    locations: resolvedLocations,
    ...(region ? { region } : {}),
    unresolved,
    source: 'llm',
  });
};

/**
 * The parse as core's `parse-search` hands it on (`SearchParse`): people and location nodes as
 * subjects; an area is only the `region`.
 */
export const toSearchParse = ({ people, locations, ...parsed }: ParsedSearch): SearchParse => ({
  ...parsed,
  subjects: [
    ...people.map((person) => ({
      kind: 'person',
      name: person.name,
      ...(person.slug ? { ref: person.slug } : {}),
      matches: person.matches.map((match) => ({ name: match.name, ref: match.slug })),
    })),
    ...locations.flatMap((location) =>
      location.slug ? [{ kind: 'location', name: location.name, ref: location.slug, matches: [{ name: location.name, ref: location.slug }] }] : []
    ),
  ],
});
