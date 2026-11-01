/**
 * Bringing a GEDCOM file's people into the archive: which of its individuals are people the
 * archive has already (`matchIndividuals`), and the import itself (`importGedcom`) — people made
 * for the rest, attrs the archive lacks filled in, the file's parents and partners added where
 * they are missing, and every person it describes linked to the file from their `sources/`.
 *
 * An individual is the person who links the same file with the same xref, or a link of any GEDCOM
 * file with one of its `_UID`s: an import made again, or a newer export of the same tree, finds
 * the people the last one made. Otherwise the names and the dates decide (`score`), and a match
 * the names alone suggest is taken only when a relative already matched says the same.
 */
import { type Command, verifyAccess } from '@ein/client';
import { PEOPLE_ROOT } from '@archive/paths';
import { CHILDREN_DIR, createRelationPair, datePart, makeCtx, PARENTS_DIR, PARTNERS_DIR, wouldCreateCycle } from '@archive/people/genealogy';
import type { Gedcom, GedcomDate, GedcomIndividual } from '@archive/people/gedcom';
import { slugifyName } from '@archive/people/person';
import type { PersonAttrs } from '@archive/people/types';
import type { GedcomImportResult } from '@archive/people/api';
import { freeName, linkSource, SOURCES_DIR } from '@archive/sources';
import { basename } from '@std/path';

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

/** How an individual was found among the archive's people. */
type MatchHow = GedcomImportResult['matched'][number]['how'];

type Match = { path: string; how: MatchHow; score: number };

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

// ---------- matching ----------

/**
 * The archive's person for each individual that has one. An earlier import's link settles an
 * individual first; then the surest fits are taken, best first, each person going to one
 * individual only and a tie taking neither; then a fit no better than a name is taken where a
 * parent, partner or child of the individual has matched the same relative of the person, until
 * nothing more is found.
 */
export const matchIndividuals = (gedcom: Gedcom, people: ArchivePerson[], source: string): Map<string, Match> => {
  const matches = new Map<string, Match>();
  const taken = new Set<string>();
  const take = (xref: string, match: Match) => {
    matches.set(xref, match);
    taken.add(match.path);
  };

  for (const indi of gedcom.individuals) {
    const bySource = people.find((p) => !taken.has(p.path) && p.gedcom.some((link) => link.target === source && link.xref === indi.xref));
    const byUid = bySource ?? people.find((p) => !taken.has(p.path) && p.gedcom.some((link) => link.uids.some((uid) => indi.uids.includes(uid))));
    if (bySource) take(indi.xref, { path: bySource.path, how: 'source', score: Infinity });
    else if (byUid) take(indi.xref, { path: byUid.path, how: 'uid', score: Infinity });
  }

  const fits = new Map<string, { path: string; score: number }[]>();
  for (const indi of gedcom.individuals) {
    if (matches.has(indi.xref)) continue;
    const ranked = people.map((p) => ({ path: p.path, score: score(p, indi) })).filter((fit) => fit.score > 0).sort((a, b) => b.score - a.score);
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
      if (matches.has(indi.xref)) continue;
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

const targetsOf = (settled: PromiseSettledResult<{ node: { props: { softlink?: string } } }[]>): string[] =>
  settled.status === 'fulfilled' ? settled.value.flatMap((entry) => entry.node.props.softlink ? [entry.node.props.softlink] : []) : [];

/** Every named person of the archive (the direct children of `PEOPLE_ROOT`), with relatives and GEDCOM links. */
async function loadPeople(vfs: Vfs, access: Access): Promise<ArchivePerson[]> {
  const entries = (await vfs.children<PersonAttrs>(access, PEOPLE_ROOT)).filter((entry) => entry.node.type === 'person');
  const paths = entries.map((entry) => `${PEOPLE_ROOT}/${entry.name}`);
  const read = (dir: string) => vfs.childrenMany(access, paths.map((path) => `${path}/${dir}`), { follow: false });
  const [parents, children, partners, sources] = await Promise.all([read(PARENTS_DIR), read(CHILDREN_DIR), read(PARTNERS_DIR), read(SOURCES_DIR)]);
  return entries.map((entry, i) => ({
    path: paths[i],
    attrs: entry.node.attrs,
    parents: targetsOf(parents[i]),
    children: targetsOf(children[i]),
    partners: targetsOf(partners[i]),
    writable: verifyAccess(access, entry.node.props, 'w'),
    gedcom: sources[i].status === 'fulfilled'
      ? sources[i].value.flatMap((link) => {
        const attrs = (link.node.attrs as Partial<GedcomLinkAttrs>).gedcom;
        return link.node.props.softlink && attrs?.xref ? [{ target: link.node.props.softlink, xref: attrs.xref, uids: attrs.uids ?? [] }] : [];
      })
      : [],
  }));
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
  };
};

/**
 * The attrs of `attrs` a person lacks; what they have already is never changed. A full name
 * that is only their name again says nothing.
 */
const missing = (have: PersonAttrs, attrs: PersonAttrs): Partial<PersonAttrs> => {
  const out: Record<string, unknown> = {};
  for (const key of ['fullname', 'birthname', 'gender', 'born', 'died'] as const) {
    if (attrs[key] && !have[key]) out[key] = attrs[key];
  }
  if (out.fullname === have.name) delete out.fullname;
  return out as Partial<PersonAttrs>;
};

type ImportOptions = { dryRun?: boolean };

/**
 * Bring `gedcom`, kept at `source`, into the archive as `access` (see the file's comment). A
 * person `access` may not change is matched all the same, and what the import would write on them
 * is left out and said in `skipped`. With `dryRun`, nothing is written and the answer says what
 * would be: the paths of people to be made, and the relations that would be added.
 */
export async function importGedcom(vfs: Vfs, access: Access, gedcom: Gedcom, source: string, opts: ImportOptions = {}): Promise<GedcomImportResult> {
  const people = await loadPeople(vfs, access);
  const matches = matchIndividuals(gedcom, people, source);
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

  // What the file's last import found, kept on the file by whoever may change it.
  if (!opts.dryRun && verifyAccess(access, (await vfs.get(access, source)).props, 'w')) {
    await vfs.update(access, source, {
      attrs: { gedcomImport: { at: new Date().toISOString(), individuals: result.individuals, matched: result.matched.length, created: result.created.length } },
    });
  }
  return result;
}
