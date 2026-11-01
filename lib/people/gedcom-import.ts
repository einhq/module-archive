/**
 * Bringing a GEDCOM file's people into the archive: which of its individuals are people the
 * archive has already (`matchIndividuals`), and the import itself (`importGedcom`) — people made
 * for the rest, attrs the archive lacks filled in (a person's notes as their description), the
 * file's parents and partners added where they are missing, its events and facts written as the
 * person's events, its residences as homes, and every person it describes linked to the file from
 * their `sources/`.
 *
 * An individual is the person who links the same file with the same xref, or a link of any GEDCOM
 * file with one of its `_UID`s: an import made again, or a newer export of the same tree, finds
 * the people the last one made. Otherwise the names and the dates decide (`score`), and a match
 * the names alone suggest is taken only when a relative already matched says the same. Whoever
 * imports can settle an individual first (`GedcomChoices`): this person, a new one, or nobody.
 */
import { accessOfUser, type Command, isAdmin, verifyAccess } from '@ein/client';
import { GENEALOGY_SOURCES, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { createEvent, EVENTS_DIR, newEventName } from '@archive/people/events';
import { CHILDREN_DIR, createRelationPair, datePart, makeCtx, PARENTS_DIR, PARTNERS_DIR, wouldCreateCycle } from '@archive/people/genealogy';
import { type Gedcom, type GedcomDate, type GedcomEvent, type GedcomIndividual, readGedcom } from '@archive/people/gedcom';
import { createResidence, homeLink } from '@archive/people/residence';
import { slugifyName } from '@archive/people/person';
import type { PersonAttrs } from '@archive/people/types';
import type { GedcomChoice, GedcomImportResult, GedcomMatchHow, GedcomPlan, GedcomPlanPerson } from '@archive/people/api';
import { freeName, linkSource, sha256Hex, SOURCES_DIR } from '@archive/sources';
import { POSITION_CHILD } from '@archive/location/location-link';
import { parseStagedPath } from '@archive/staging/paths';
import { basename, dirname, resolve } from '@std/path';
import { toArrayBuffer } from '@std/streams/to-array-buffer';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** What a person's link to a GEDCOM file says: the record they are in it, and its `_UID`s. */
type GedcomLinkAttrs = { gedcom: { xref: string; uids?: string[] } };

/** A named person of the archive, with their relatives and the GEDCOM records they come from. */
export type ArchivePerson = {
  path: string;
  attrs: PersonAttrs;
  parents: string[];
  children: string[];
  partners: string[];
  /** Whether the import may change them: fill in their attrs, link the file, add relations. */
  writable: boolean;
  /** Their links to GEDCOM files: the file and what the link says of the record. */
  gedcom: { target: string; xref: string; uids: string[] }[];
};

type Match = { path: string; how: GedcomMatchHow; score: number };

/** What was said of individuals before the import, by xref; the rest are matched as usual. */
type GedcomChoices = ReadonlyMap<string, GedcomChoice>;

// ---------- names and dates ----------

/** Lower-case words without diacritics: `Åsa Öberg` and `asa oberg` read the same. */
const words = (text: string | null | undefined): string[] => (text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The surname an individual goes by now: the married one, else the one they were born with. */
const currentSurname = (indi: GedcomIndividual): string | undefined => indi.marriedSurname ?? indi.surname;

/** The name an individual is shown by: their call name and the surname they go by. */
const displayName = (indi: GedcomIndividual): string => [indi.callName, currentSurname(indi)].filter(Boolean).join(' ');

const year = (date: string | null | undefined): number | undefined => {
  const y = date ? Number(datePart(date).slice(0, 4)) : NaN;
  return Number.isInteger(y) ? y : undefined;
};

/** The years an individual's birth or death can be in, a christening or burial standing in. */
const span = (event: GedcomDate | undefined, stand: GedcomDate | undefined): GedcomDate | undefined => event ?? (stand ? { from: stand.from - 1, to: stand.to } : undefined);

/** How a date of the archive and one of the file agree: `exact`, `year`, `conflict`, or unknown. */
const compareDate = (ours: string | null | undefined, theirs: GedcomDate | undefined): 'exact' | 'year' | 'conflict' | undefined => {
  const y = year(ours);
  if (y === undefined || !theirs) return undefined;
  if (y < theirs.from || y > theirs.to) return 'conflict';
  if (ours && theirs.date && datePart(ours).length === 10 && datePart(ours) === theirs.date) return 'exact';
  return 'year';
};

/**
 * How well a person of the archive fits an individual, or 0 when they cannot be the same. The
 * first word of the person's name must be one of the individual's given names, no other word of
 * it may be foreign to the individual's names, and no date or gender may contradict. Then one for
 * the first name, two for a shared surname, three for the same day of birth (one for the year),
 * two for the same day of death (one for the year). A name and a year of birth, or a first name
 * and a day of birth, reach `SURE`: enough to take the match without a relative confirming it.
 */
export const score = (person: Pick<ArchivePerson, 'attrs'>, indi: GedcomIndividual): number => {
  const { attrs } = person;
  const nameWords = words(attrs.name);
  const ours = new Set([...nameWords, ...words(attrs.fullname), ...words(attrs.birthname)]);
  const given = new Set([...indi.given.flatMap(words), ...words(indi.callName)]);
  const surnames = new Set([...words(indi.surname), ...words(indi.marriedSurname)]);
  if (nameWords.length === 0 || !given.has(nameWords[0])) return 0;
  if (nameWords.slice(1).some((word) => !given.has(word) && !surnames.has(word))) return 0;
  if (attrs.gender && indi.gender && ['male', 'female'].includes(attrs.gender) && ['male', 'female'].includes(indi.gender) && attrs.gender !== indi.gender) return 0;

  const born = compareDate(attrs.born, span(indi.born, indi.christened));
  const died = compareDate(attrs.died, span(indi.died, indi.buried));
  if (born === 'conflict' || died === 'conflict') return 0;

  let points = 1;
  if ([...surnames].some((word) => ours.has(word))) points += 2;
  if (born) points += born === 'exact' ? 3 : 1;
  if (died) points += died === 'exact' ? 2 : 1;
  return points;
};

/** What `score` takes without a relative to confirm it. */
const SURE = 4;

/** The people who could be `indi`, best first: every one `score` does not rule out. */
const rankFits = (indi: GedcomIndividual, people: ArchivePerson[]): { path: string; score: number }[] =>
  people.map((p) => ({ path: p.path, score: score(p, indi) })).filter((fit) => fit.score > 0).sort((a, b) => b.score - a.score);

// ---------- matching ----------

/**
 * The archive's person for each individual that has one. The `choices` come first: a chosen person
 * is theirs, and one chosen to be new or left out is matched to nobody. Then an earlier import's
 * link settles an individual; then the surest fits are taken, best first, each person going to one
 * individual only and a tie taking neither; then a fit no better than a name is taken where a
 * parent, partner or child of the individual has matched the same relative of the person, until
 * nothing more is found.
 */
export const matchIndividuals = (gedcom: Gedcom, people: ArchivePerson[], source: string, choices: GedcomChoices = new Map()): Map<string, Match> => {
  const matches = new Map<string, Match>();
  const taken = new Set<string>();
  const take = (xref: string, match: Match) => {
    matches.set(xref, match);
    taken.add(match.path);
  };
  const settled = (xref: string) => matches.has(xref) || choices.has(xref);

  for (const [xref, choice] of choices) if (choice.kind === 'person') take(xref, { path: choice.person, how: 'chosen', score: Infinity });

  for (const indi of gedcom.individuals) {
    if (settled(indi.xref)) continue;
    const bySource = people.find((p) => !taken.has(p.path) && p.gedcom.some((link) => link.target === source && link.xref === indi.xref));
    const byUid = bySource ?? people.find((p) => !taken.has(p.path) && p.gedcom.some((link) => link.uids.some((uid) => indi.uids.includes(uid))));
    if (bySource) take(indi.xref, { path: bySource.path, how: 'source', score: Infinity });
    else if (byUid) take(indi.xref, { path: byUid.path, how: 'uid', score: Infinity });
  }

  const fits = new Map<string, { path: string; score: number }[]>();
  for (const indi of gedcom.individuals) {
    if (settled(indi.xref)) continue;
    const ranked = rankFits(indi, people);
    if (ranked.length > 0) fits.set(indi.xref, ranked);
  }

  const sure = [...fits].filter(([, ranked]) => ranked[0].score >= SURE && (ranked.length === 1 || ranked[1].score < ranked[0].score))
    .sort((a, b) => b[1][0].score - a[1][0].score);
  const claimed = new Map<string, number>();
  for (const [, ranked] of sure) claimed.set(ranked[0].path, (claimed.get(ranked[0].path) ?? 0) + 1);
  for (const [xref, ranked] of sure) {
    const best = ranked[0];
    // Two individuals both surest of one person: neither is taken on the names and dates.
    if (claimed.get(best.path)! > 1 || taken.has(best.path)) continue;
    take(xref, { path: best.path, how: 'name-date', score: best.score });
  }

  const byPath = new Map(people.map((p) => [p.path, p]));
  const families = new Map(gedcom.families.map((family) => [family.xref, family]));
  const relativesOf = (indi: GedcomIndividual) => ({
    parents: indi.childOf.flatMap(({ family }) => families.get(family)?.partners ?? []),
    children: indi.partnerIn.flatMap((family) => families.get(family)?.children ?? []),
    partners: indi.partnerIn.flatMap((family) => families.get(family)?.partners ?? []).filter((xref) => xref !== indi.xref),
  });

  for (let found = true; found;) {
    found = false;
    for (const indi of gedcom.individuals) {
      if (settled(indi.xref)) continue;
      const relatives = relativesOf(indi);
      const confirmed = (fits.get(indi.xref) ?? []).filter((fit) => {
        if (taken.has(fit.path)) return false;
        const person = byPath.get(fit.path)!;
        return (['parents', 'children', 'partners'] as const).some((kind) =>
          relatives[kind].some((xref) => {
            const relative = matches.get(xref);
            return relative !== undefined && person[kind].includes(relative.path);
          })
        );
      });
      if (confirmed.length !== 1) continue;
      take(indi.xref, { path: confirmed[0].path, how: 'relatives', score: confirmed[0].score });
      found = true;
    }
  }
  return matches;
};

// ---------- reading the archive ----------

/** How many links a page of `loadPeople`'s query holds. */
const LINK_PAGE = 5000;

/**
 * Every named person of the archive (the direct children of `PEOPLE_ROOT`), with relatives and
 * GEDCOM links. The links are read by one paged query of every softlink under `PEOPLE_ROOT`, not
 * by listing four directories of each person: those are thousands of path lookups, most of them of
 * a directory a person does not have.
 */
async function loadPeople(vfs: Vfs, access: Access): Promise<ArchivePerson[]> {
  const entries = (await vfs.children<PersonAttrs>(access, PEOPLE_ROOT)).filter((entry) => entry.node.type === 'person');
  const people = new Map(entries.map((entry): [string, ArchivePerson] => {
    const path = `${PEOPLE_ROOT}/${entry.name}`;
    return [path, { path, attrs: entry.node.attrs, parents: [], children: [], partners: [], writable: verifyAccess(access, entry.node.props, 'w'), gedcom: [] }];
  }));

  for (let after: string | undefined;;) {
    const page = await vfs.query(access, {
      types: ['softlink'],
      within: PEOPLE_ROOT,
      limit: LINK_PAGE,
      ...(after !== undefined ? { after: { value: null, id: after } } : {}),
    });
    for (const hit of page) {
      // `<person>/<dir>/<link>` directly under the root; a link anywhere deeper is no relation.
      const [slug, dir, name, deeper] = hit.absPath.slice(PEOPLE_ROOT.length + 1).split('/');
      const person = people.get(`${PEOPLE_ROOT}/${slug}`);
      const target = hit.node.props.softlink;
      if (!person || !target || !name || deeper !== undefined) continue;
      if (dir === PARENTS_DIR) person.parents.push(target);
      else if (dir === CHILDREN_DIR) person.children.push(target);
      else if (dir === PARTNERS_DIR) person.partners.push(target);
      else if (dir === SOURCES_DIR) {
        const attrs = (hit.node.attrs as Partial<GedcomLinkAttrs>).gedcom;
        if (attrs?.xref) person.gedcom.push({ target, xref: attrs.xref, uids: attrs.uids ?? [] });
      }
    }
    if (page.length < LINK_PAGE) break;
    after = page[page.length - 1].id;
  }
  for (const person of people.values()) for (const list of [person.parents, person.children, person.partners]) list.sort();
  return [...people.values()];
}

// ---------- choices ----------

/** `@I1@`, `I1` and `i1` name the same record: xrefs are compared upper-case and between `@`s. */
const xrefOf = (text: string): string => `@${text.trim().replace(/^@|@$/g, '').toUpperCase()}@`;

/**
 * The choices `--match <xref>=<person>`, `--new <xref>` and `--skip <xref>` say. A person is a
 * path, or the name of one directly under `PEOPLE_ROOT`.
 */
export const choicesFromFlags = (flags: { match?: string[]; new?: string[]; skip?: string[] }, cwd: string): Map<string, GedcomChoice> => {
  const choices = new Map<string, GedcomChoice>();
  const say = (xref: string, choice: GedcomChoice) => {
    if (choices.has(xref)) throw new Error(`${xref} is chosen twice`);
    choices.set(xref, choice);
  };
  for (const pair of flags.match ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) throw new Error(`--match wants <xref>=<person>, not '${pair}'`);
    const person = pair.slice(eq + 1).trim();
    say(xrefOf(pair.slice(0, eq)), { kind: 'person', person: person.includes('/') ? resolve(cwd, person) : `${PEOPLE_ROOT}/${person}` });
  }
  for (const xref of flags.new ?? []) say(xrefOf(xref), { kind: 'new' });
  for (const xref of flags.skip ?? []) say(xrefOf(xref), { kind: 'skip' });
  return choices;
};

/** Throws unless every choice names an individual of the file, and every chosen person is a named person chosen once. */
const checkChoices = (gedcom: Gedcom, people: ArchivePerson[], choices: GedcomChoices): void => {
  const xrefs = new Set(gedcom.individuals.map((indi) => indi.xref));
  const paths = new Set(people.map((p) => p.path));
  const chosen = new Map<string, string>();
  for (const [xref, choice] of choices) {
    if (!xrefs.has(xref)) throw new Error(`the file has no individual ${xref}`);
    if (choice.kind !== 'person') continue;
    if (!paths.has(choice.person)) throw new Error(`${choice.person} is not a person directly under ${PEOPLE_ROOT}`);
    const other = chosen.get(choice.person);
    if (other) throw new Error(`${choice.person} is chosen for both ${other} and ${xref}`);
    chosen.set(choice.person, xref);
  }
};

// ---------- the plan ----------

/** How many of an individual's fits a plan lists. */
const CANDIDATES = 5;

/** The attrs a plan shows of a person or an individual. */
const attrsOnly = (attrs: PersonAttrs) => ({
  name: attrs.name,
  ...(attrs.fullname ? { fullname: attrs.fullname } : {}),
  ...(attrs.birthname ? { birthname: attrs.birthname } : {}),
  ...(attrs.gender ? { gender: attrs.gender } : {}),
  ...(attrs.born ? { born: attrs.born } : {}),
  ...(attrs.died ? { died: attrs.died } : {}),
});

const personOf = (p: ArchivePerson): GedcomPlanPerson => ({
  ...attrsOnly(p.attrs),
  parents: p.parents,
  children: p.children,
  partners: p.partners,
  writable: p.writable,
});

/**
 * Who each individual of `gedcom` would be if it were imported now with `choices` (see the file's
 * comment): matched to a person, made one, or left out, with the people that could be them. The
 * archive's side is in `people`: everyone matched or a candidate, and the parents, children and
 * partners of everyone matched.
 */
export async function planGedcom(vfs: Vfs, access: Access, gedcom: Gedcom, file: string, source: string, choices: GedcomChoices = new Map()): Promise<GedcomPlan> {
  const people = await loadPeople(vfs, access);
  checkChoices(gedcom, people, choices);
  const matches = matchIndividuals(gedcom, people, source, choices);
  const byPath = new Map(people.map((p) => [p.path, p]));
  const families = new Map(gedcom.families.map((family) => [family.xref, family]));

  const shown = new Set<string>();
  const individuals = gedcom.individuals.map((indi): GedcomPlan['individuals'][number] => {
    const attrs = attrsFor(indi);
    const match = matches.get(indi.xref);
    const choice = choices.get(indi.xref);
    const candidates = rankFits(indi, people).slice(0, CANDIDATES).map((fit) => ({ person: fit.path, score: fit.score }));
    for (const fit of candidates) shown.add(fit.person);
    if (match) {
      const person = byPath.get(match.path)!;
      for (const path of [match.path, ...person.parents, ...person.children, ...person.partners]) shown.add(path);
    }
    const unique = (xrefs: string[]) => [...new Set(xrefs)].filter((xref) => xref !== indi.xref);
    return {
      xref: indi.xref,
      ...attrsOnly(attrs),
      parents: unique(indi.childOf.flatMap(({ family }) => families.get(family)?.partners ?? [])),
      children: unique(indi.partnerIn.flatMap((family) => families.get(family)?.children ?? [])),
      partners: unique(indi.partnerIn.flatMap((family) => families.get(family)?.partners ?? [])),
      action: match ? 'match' : choice?.kind === 'skip' || !attrs.name ? 'skip' : 'new',
      chosen: choice !== undefined,
      ...(match ? { person: match.path, how: match.how } : {}),
      candidates,
    };
  });

  return {
    file,
    source,
    individuals,
    people: Object.fromEntries([...shown].flatMap((path) => byPath.has(path) ? [[path, personOf(byPath.get(path)!)]] : [])),
  };
}

// ---------- the file ----------

/** The type a GEDCOM file is given, waiting or kept, which keeps it out of text extraction. */
export const GEDCOM_MIMETYPE = 'application/x-gedcom';

/** A GEDCOM file read from the archive: what it says, and the hash its kept copy is known by. */
export async function readGedcomAt(vfs: Vfs, access: Access, path: string): Promise<{ gedcom: Gedcom; sha256: string }> {
  const handle = await vfs.open(access, path, { mode: 'r' });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await toArrayBuffer(handle.readable));
  } finally {
    await handle.close();
  }
  const gedcom = readGedcom(bytes);
  if (gedcom.individuals.length === 0) throw new Error(`${path}: no individuals found; is it a GEDCOM file?`);
  return { gedcom, sha256: await sha256Hex(bytes) };
}

/**
 * Where the people of the file at `path` link it before it is kept: the copy of the same bytes in
 * `GENEALOGY_SOURCES` when there is one, else `path` itself.
 */
export async function heldSource(vfs: Vfs, access: Access, path: string, sha256: string): Promise<string> {
  if (dirname(path) === GENEALOGY_SOURCES) return path;
  const held = await vfs.children(access, GENEALOGY_SOURCES, { follow: false }).catch(() => []);
  const same = held.find((entry) => (entry.node.attrs as { sha256?: unknown }).sha256 === sha256);
  return same ? `${GENEALOGY_SOURCES}/${same.name}` : path;
}

/**
 * Whose access a GEDCOM file is read and imported with: a staged file's owner's, when `access`
 * is an administrator's (the pipeline's), so the import changes only the people its owner may.
 */
export async function importerOf(vfs: Vfs, access: Access, path: string): Promise<Access> {
  const place = parseStagedPath(path);
  return place && isAdmin(access) ? await accessOfUser(vfs, access, place.user) : access;
}

// ---------- the import ----------

/** What the file says of an individual, as person attrs; `fullname` even where it is their name. */
const attrsFor = (indi: GedcomIndividual): PersonAttrs => {
  const fullname = [...indi.given, currentSurname(indi)].filter(Boolean).join(' ');
  const birthname = indi.marriedSurname && indi.surname ? [...indi.given, indi.surname].join(' ') : undefined;
  return {
    name: displayName(indi),
    ...(fullname ? { fullname } : {}),
    ...(birthname ? { birthname } : {}),
    ...(indi.gender && indi.gender !== 'unknown' ? { gender: indi.gender } : {}),
    ...(indi.born?.date ? { born: indi.born.date } : {}),
    ...(indi.died?.date ? { died: indi.died.date } : {}),
    ...(indi.notes.length ? { description: indi.notes.join('\n\n') } : {}),
  };
};

/**
 * The attrs of `attrs` a person lacks; what they have already is never changed. A full name
 * that is only their name again says nothing.
 */
const missing = (have: PersonAttrs, attrs: PersonAttrs): Partial<PersonAttrs> => {
  const out: Record<string, unknown> = {};
  for (const key of ['fullname', 'birthname', 'description', 'gender', 'born', 'died'] as const) {
    if (attrs[key] && !have[key]) out[key] = attrs[key];
  }
  if (out.fullname === have.name) delete out.fullname;
  return out as Partial<PersonAttrs>;
};

// ---------- events, homes and places ----------

/** The event types of the tags that have one; every other tag is a `generic` event. */
const EVENT_TYPES: Record<string, string> = { BIRT: 'birth', DEAT: 'death', MARR: 'marriage', ENGA: 'engagement' };

/** What each tag is called as an event's title. */
const EVENT_TITLES: Record<string, string> = {
  BIRT: 'Birth',
  CHR: 'Christening',
  BAPM: 'Baptism',
  CONF: 'Confirmation',
  FCOM: 'First communion',
  BARM: 'Bar mitzvah',
  BASM: 'Bat mitzvah',
  ADOP: 'Adoption',
  ORDN: 'Ordination',
  GRAD: 'Graduation',
  EDUC: 'Education',
  OCCU: 'Occupation',
  RETI: 'Retirement',
  RELI: 'Religion',
  TITL: 'Title',
  NATI: 'Nationality',
  NATU: 'Naturalisation',
  EMIG: 'Emigration',
  IMMI: 'Immigration',
  CENS: 'Census',
  RESI: 'Residence',
  WILL: 'Will',
  PROB: 'Probate',
  DEAT: 'Death',
  BURI: 'Burial',
  CREM: 'Cremation',
  ENGA: 'Engagement',
  MARB: 'Marriage banns',
  MARC: 'Marriage contract',
  MARL: 'Marriage licence',
  MARS: 'Marriage settlement',
  MARR: 'Marriage',
  DIV: 'Divorce',
  DIVF: 'Divorce filed',
  ANUL: 'Annulment',
  EVEN: 'Event',
  FACT: 'Fact',
};

/**
 * The tags whose date the archive keeps already, as `born`, `died` or the partner relation's
 * span: their event is written only for what else it says, a place, a cause or a note.
 */
const DATED_ELSEWHERE = new Set(['BIRT', 'DEAT', 'MARR', 'DIV']);

/** An event as it is to be written under a person's `events/`. */
type PlannedEvent = { eventType: string; title: string; kind: string; date?: string; body?: string };

/** An event a person has: enough to tell whether the file's is the same one. */
type HeldEvent = { eventType: string; title?: string; date?: string };

type LatLng = { lat: number; lng: number };

/** A location of the archive a GEDCOM place names. */
type Place = { path: string; writable: boolean };

const placeKey = (text: string): string => words(text).join(' ');

/** The point of a `position` node, when it holds one. */
async function readPoint(vfs: Vfs, access: Access, path: string): Promise<LatLng | undefined> {
  try {
    const handle = await vfs.open(access, path, { mode: 'r' });
    try {
      const point = JSON.parse(new TextDecoder().decode(await toArrayBuffer(handle.readable))) as { lat?: unknown; lng?: unknown };
      return typeof point.lat === 'number' && typeof point.lng === 'number' ? { lat: point.lat, lng: point.lng } : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * The archive's locations, found by a GEDCOM place: the whole place (`Exempelby, Exempel
 * socken`) named as a location, else its first part (`Exempelby`). Names compare as `words`
 * does, a location going by its `name` attr and its own name; a name two locations share finds
 * neither. `point` is where a location is, read once.
 */
async function loadPlaces(vfs: Vfs, access: Access): Promise<{ find: (place: string) => Place | undefined; point: (path: string) => Promise<LatLng | undefined> }> {
  const entries = (await vfs.children<{ name?: unknown }>(access, LOCATIONS_ROOT).catch(() => [])).filter((entry) => entry.node.type === 'location');
  const byName = new Map<string, Set<number>>();
  entries.forEach((entry, i) => {
    for (const name of [entry.node.attrs.name, entry.name]) {
      const key = typeof name === 'string' ? placeKey(name) : '';
      if (key) byName.set(key, (byName.get(key) ?? new Set()).add(i));
    }
  });
  const only = (key: string): number | undefined => {
    const hits = byName.get(key);
    return hits?.size === 1 ? [...hits][0] : undefined;
  };
  const points = new Map<string, Promise<LatLng | undefined>>();
  return {
    find: (place) => {
      const i = only(placeKey(place)) ?? only(placeKey(place.split(',')[0]));
      return i === undefined ? undefined : { path: `${LOCATIONS_ROOT}/${entries[i].name}`, writable: verifyAccess(access, entries[i].node.props, 'w') };
    },
    point: (path) => {
      if (!points.has(path)) points.set(path, readPoint(vfs, access, `${path}/${POSITION_CHILD}`));
      return points.get(path)!;
    },
  };
}

/** A person's events, as `HeldEvent`s. */
async function loadEvents(vfs: Vfs, access: Access, person: string): Promise<HeldEvent[]> {
  const entries = await vfs.children(access, `${person}/${EVENTS_DIR}`, { follow: false }).catch(() => []);
  return entries.map((entry) => {
    const attrs = entry.node.attrs as { eventType?: unknown; name?: unknown; date?: unknown };
    return {
      eventType: typeof attrs.eventType === 'string' ? attrs.eventType : 'generic',
      ...(typeof attrs.name === 'string' ? { title: attrs.name } : {}),
      ...(typeof attrs.date === 'string' ? { date: attrs.date } : {}),
    };
  });
}

/** Whether a person has the event already: one birth or death each, else the same type (or title) on the same day. */
const holds = (held: HeldEvent[], event: PlannedEvent): boolean =>
  held.some((have) => {
    if (have.eventType !== event.eventType) return false;
    if (event.eventType === 'birth' || event.eventType === 'death') return true;
    return have.date === event.date && (event.eventType !== 'generic' || have.title === event.title);
  });

/**
 * A GEDCOM event as it is written on a person, or undefined when it says nothing the archive
 * does not keep elsewhere. `lifeDate` is the person's `born` or `died`, which a birth or death
 * event takes so that the two agree. The place opens the body, then the cause and the notes.
 */
const planEvent = (event: GedcomEvent, lifeDate?: string): PlannedEvent | undefined => {
  const eventType = EVENT_TYPES[event.tag] ?? 'generic';
  const label = (event.tag === 'EVEN' || event.tag === 'FACT') && event.type ? event.type : EVENT_TITLES[event.tag] ?? event.tag;
  const body = [event.place, event.cause && `Cause: ${event.cause}`, ...event.notes].filter(Boolean).join('\n\n');
  if (DATED_ELSEWHERE.has(event.tag) && !body) return undefined;
  const date = lifeDate ?? event.date?.date ?? event.date?.since;
  if (!date && !body && !event.value) return undefined;
  return {
    eventType,
    title: event.value ? `${label}: ${event.value}` : label,
    kind: eventType === 'generic' ? label : eventType,
    ...(date ? { date } : {}),
    ...(body ? { body } : {}),
  };
};

type ImportOptions = { dryRun?: boolean; choices?: GedcomChoices };

/** Where the file is kept, or how to keep it, called once the choices are known to hold; it answers where. */
type KeptAt = string | (() => Promise<string>);

/**
 * Bring `gedcom`, kept at `keptAt`, into the archive as `access` (see the file's comment), with
 * the `choices` made of its individuals. A person `access` may not change is matched all the same, and what the import would write on them
 * is left out and said in `skipped`. With `dryRun`, nothing is written and the answer says what
 * would be: the paths of people to be made, and the relations that would be added.
 */
export async function importGedcom(vfs: Vfs, access: Access, gedcom: Gedcom, keptAt: KeptAt, opts: ImportOptions = {}): Promise<GedcomImportResult> {
  const people = await loadPeople(vfs, access);
  const choices = opts.choices ?? new Map();
  checkChoices(gedcom, people, choices);
  const source = typeof keptAt === 'string' ? keptAt : await keptAt();
  const matches = matchIndividuals(gedcom, people, source, choices);
  const byPath = new Map(people.map((p) => [p.path, p]));
  const result: GedcomImportResult = {
    source,
    individuals: gedcom.individuals.length,
    families: gedcom.families.length,
    matched: [],
    created: [],
    skipped: [],
    parents: 0,
    partners: 0,
    events: 0,
    homes: 0,
    dryRun: Boolean(opts.dryRun),
  };

  // Who each individual is, made where nobody is.
  const pathOf = new Map<string, string>();
  const writable = new Set(people.filter((p) => p.writable).map((p) => p.path));
  const slugs = new Set(people.map((p) => basename(p.path)));
  for (const indi of gedcom.individuals) {
    const attrs = attrsFor(indi);
    const match = matches.get(indi.xref);
    if (match) {
      pathOf.set(indi.xref, match.path);
      result.matched.push({ xref: indi.xref, name: attrs.name, person: match.path, how: match.how });
      if (!writable.has(match.path)) {
        result.skipped.push({ xref: indi.xref, reason: `may not change ${match.path}` });
        continue;
      }
      const fill = missing(byPath.get(match.path)!.attrs, attrs);
      if (!opts.dryRun && Object.keys(fill).length > 0) await vfs.update(access, match.path, { attrs: fill });
      continue;
    }
    if (choices.get(indi.xref)?.kind === 'skip') {
      result.skipped.push({ xref: indi.xref, reason: 'left out' });
      continue;
    }
    if (!attrs.name) {
      result.skipped.push({ xref: indi.xref, reason: 'no name' });
      continue;
    }
    let slug = slugifyName(attrs.name) || 'person';
    slug = freeName(slug, slugs);
    slugs.add(slug);
    if (!opts.dryRun) {
      while (await vfs.exists(access, `${PEOPLE_ROOT}/${slug}`, { follow: false })) slugs.add(slug = freeName(slug, slugs));
      await vfs.createTree(access, PEOPLE_ROOT, [{
        type: 'person',
        name: slug,
        attrs: { name: attrs.name, ...missing({ name: attrs.name }, attrs) },
        children: [{ type: 'directory', name: 'events' }],
      }]);
    }
    const path = `${PEOPLE_ROOT}/${slug}`;
    pathOf.set(indi.xref, path);
    writable.add(path);
    result.created.push({ xref: indi.xref, name: attrs.name, person: path });
  }

  if (!opts.dryRun) {
    for (const indi of gedcom.individuals) {
      const path = pathOf.get(indi.xref);
      if (!path || !writable.has(path)) continue;
      const attrs: GedcomLinkAttrs = { gedcom: { xref: indi.xref, ...(indi.uids.length ? { uids: indi.uids } : {}) } };
      await linkSource(vfs, access, path, source, attrs);
    }
  }

  // The relations the file gives that the archive lacks. A person made by this import has none.
  const parentsOf = new Map<string, Set<string>>();
  const partnersOf = new Map<string, Set<string>>();
  const known = (of: Map<string, Set<string>>, path: string, kind: 'parents' | 'partners'): Set<string> => {
    if (!of.has(path)) of.set(path, new Set(byPath.get(path)?.[kind] ?? []));
    return of.get(path)!;
  };
  /** Whether both ends of a relation may be written; when not, it is said in `skipped`. */
  const mayRelate = (xref: string, a: string, b: string): boolean => {
    const refused = [a, b].find((path) => !writable.has(path));
    if (refused) result.skipped.push({ xref, reason: `may not change ${refused}, not relating ${a === refused ? b : a}` });
    return !refused;
  };
  const ctx = makeCtx(vfs, access);
  const individuals = new Map(gedcom.individuals.map((indi) => [indi.xref, indi]));

  for (const family of gedcom.families) {
    const partners = [...new Set(family.partners.map((xref) => pathOf.get(xref)).filter((p): p is string => Boolean(p)))];
    if (partners.length === 2) {
      const [a, b] = partners;
      if (!known(partnersOf, a, 'partners').has(b) && mayRelate(family.xref, a, b)) {
        known(partnersOf, a, 'partners').add(b);
        known(partnersOf, b, 'partners').add(a);
        result.partners++;
        if (!opts.dryRun) {
          await createRelationPair(vfs, access, {
            aLink: `${a}/${PARTNERS_DIR}/${basename(b)}`,
            aTarget: b,
            bLink: `${b}/${PARTNERS_DIR}/${basename(a)}`,
            bTarget: a,
            kind: family.married ? 'married' : undefined,
            from: family.marriedOn,
            to: family.divorcedOn,
          });
        }
      }
    }

    for (const childXref of family.children) {
      const child = pathOf.get(childXref);
      if (!child) continue;
      const kind = individuals.get(childXref)?.childOf.find((tie) => tie.family === family.xref)?.kind ?? 'blood';
      const parents = known(parentsOf, child, 'parents');
      for (const parent of partners) {
        if (parent === child || parents.has(parent)) continue;
        if (!mayRelate(childXref, child, parent)) continue;
        if (kind === 'blood' && parents.size >= 2) {
          result.skipped.push({ xref: childXref, reason: `has two parents already, not adding ${parent}` });
          continue;
        }
        if (!opts.dryRun && await wouldCreateCycle(ctx, child, parent)) {
          result.skipped.push({ xref: childXref, reason: `${parent} is their descendant` });
          continue;
        }
        parents.add(parent);
        result.parents++;
        if (!opts.dryRun) {
          await createRelationPair(vfs, access, {
            aLink: `${child}/${PARENTS_DIR}/${basename(parent)}`,
            aTarget: parent,
            bLink: `${parent}/${CHILDREN_DIR}/${basename(child)}`,
            bTarget: child,
            kind: kind !== 'blood' ? kind : undefined,
          });
        }
      }
    }
  }

  // The events and residences the file gives that the archive lacks.
  const places = await loadPlaces(vfs, access);
  const heldBy = new Map<string, Promise<HeldEvent[]>>();
  const heldOf = (path: string): Promise<HeldEvent[]> => {
    if (!heldBy.has(path)) heldBy.set(path, loadEvents(vfs, access, path));
    return heldBy.get(path)!;
  };
  const homed = new Set<string>();

  /** Write `event` on `owner` unless they, or one of `others`, have it. */
  const addEvent = async (owner: string, others: string[], event: GedcomEvent, lifeDate?: string): Promise<void> => {
    const planned = planEvent(event, lifeDate);
    if (!planned) return;
    for (const path of [owner, ...others]) if (holds(await heldOf(path), planned)) return;
    (await heldOf(owner)).push(planned);
    result.events++;
    if (opts.dryRun) return;
    const place = event.place ? places.find(event.place) : undefined;
    const latlng = place ? await places.point(place.path) : undefined;
    await createEvent(vfs, access, owner, await newEventName(vfs, access, owner, planned.kind, planned.date), {
      displayName: planned.title,
      eventType: planned.eventType,
      date: planned.date,
      body: planned.body,
      latlng,
    });
  };

  /**
   * A residence at a location of the archive as the person's home, from and to the ends of its
   * period; false when its place names no location `access` may change, and it is an event instead.
   */
  const addHome = async (xref: string, person: string, event: GedcomEvent): Promise<boolean> => {
    const place = event.place ? places.find(event.place) : undefined;
    if (!place?.writable) return false;
    const link = homeLink(person, place.path);
    if (homed.has(link) || await vfs.exists(access, link, { follow: false })) return true;
    homed.add(link);
    try {
      if (!opts.dryRun) await createResidence(vfs, access, person, place.path, { from: event.date?.since, to: event.date?.until });
      result.homes++;
    } catch (error) {
      result.skipped.push({ xref, reason: `not making ${place.path} a home: ${error instanceof Error ? error.message : String(error)}` });
    }
    return true;
  };

  for (const indi of gedcom.individuals) {
    const path = pathOf.get(indi.xref);
    if (!path || !writable.has(path)) continue;
    const had = byPath.get(path)?.attrs;
    const lifeDates: Record<string, string | undefined> = { BIRT: had?.born ?? indi.born?.date, DEAT: had?.died ?? indi.died?.date };
    for (const event of indi.events) {
      if (event.tag === 'RESI' && await addHome(indi.xref, path, event)) continue;
      await addEvent(path, [], event, lifeDates[event.tag]);
    }
  }

  // A family's event is written on its first partner who may be changed, unless a partner has it.
  for (const family of gedcom.families) {
    const partners = [...new Set(family.partners.map((xref) => pathOf.get(xref)).filter((p): p is string => Boolean(p)))];
    const owners = partners.filter((path) => writable.has(path));
    if (owners.length === 0) continue;
    for (const event of family.events) {
      if (event.tag === 'RESI') {
        let home = false;
        for (const path of owners) home = await addHome(family.xref, path, event) || home;
        if (home) continue;
      }
      await addEvent(owners[0], partners.filter((path) => path !== owners[0]), event);
    }
  }

  // What the file's last import found, kept on the file by whoever may change it.
  if (!opts.dryRun && verifyAccess(access, (await vfs.get(access, source)).props, 'w')) {
    await vfs.update(access, source, {
      attrs: { gedcomImport: { at: new Date().toISOString(), individuals: result.individuals, matched: result.matched.length, created: result.created.length } },
    });
  }
  return result;
}
