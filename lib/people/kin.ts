/**
 * Kin words, Swedish and English, walked through the genealogy graph in code.
 *
 * "Min dotter", "vem är min moster", "mammas syster", "my father's brother": the model must
 * not guess at these, and it cannot read the graph itself. So a relation is a phrase in the
 * user's own words, and this module turns it into steps — up to a parent, down to a child, to
 * a partner, across to a sibling, each with the gender the word implies — and follows them from
 * a person through `@archive/people/genealogy`. A chain
 * ("farfars bror") is the terms one after the other, possessive `s` and all.
 *
 * Gender is a filter on each step, from the person's `gender` attr. Someone with no gender
 * recorded is kept only when nobody with the right gender was found: "dotter" must not hand a
 * search an ungendered son, but an archive with genders unfilled should still answer.
 */

import { type Ctx, datePart, getChildren, getGender, getParents, getPartners, kinship, render } from '@archive/people/genealogy';
import type { PersonAttrs, PersonGender } from '@archive/people/types';

type Gender = 'male' | 'female';
type Step = { dir: 'up' | 'down' | 'partner' | 'sibling'; gender?: Gender };
/** A word's meaning: one or more step chains (the alternatives are unioned), and what to leave out. */
type Term = { chains: Step[][]; exclude?: 'parents' | 'children' };

const up = (gender?: Gender): Step => ({ dir: 'up', ...(gender ? { gender } : {}) });
const down = (gender?: Gender): Step => ({ dir: 'down', ...(gender ? { gender } : {}) });
const partner = (gender?: Gender): Step => ({ dir: 'partner', ...(gender ? { gender } : {}) });
const sibling = (gender?: Gender): Step => ({ dir: 'sibling', ...(gender ? { gender } : {}) });
const one = (...steps: Step[]): Term => ({ chains: [steps] });
const either = (...chains: Step[][]): Term => ({ chains });

/** Kin words to what they mean, one entry per word so a lookup is one `get`. */
const TERMS: Record<string, Term> = {};
const define = (words: string, term: Term): void => {
  for (const word of words.split(' ')) TERMS[word] = term;
};

// Parents, children, siblings, partners.
define('far fader pappa father dad daddy', one(up('male')));
define('mor moder mamma mother mom mum mummy', one(up('female')));
define('förälder föräldrar föräldrarna parent parents', one(up()));
define('son söner sons', one(down('male')));
define('dotter döttrar daughter daughters', one(down('female')));
define('barn barnen child children kid kids', one(down()));
define('bror broder bröder brother brothers', one(sibling('male')));
define('syster systrar sister sisters', one(sibling('female')));
define('syskon sibling siblings', one(sibling()));
define('fru hustru maka wife', one(partner('female')));
define('make husband', one(partner('male')));
define('sambo partner spouse', one(partner()));
// Grandparents and grandchildren. Swedish says which side; English does not.
define('farfar', one(up('male'), up('male')));
define('farmor', one(up('male'), up('female')));
define('morfar', one(up('female'), up('male')));
define('mormor', one(up('female'), up('female')));
define('farföräldrar', one(up('male'), up()));
define('morföräldrar', one(up('female'), up()));
define('grandfather grandpa granddad', one(up(), up('male')));
define('grandmother grandma granny', one(up(), up('female')));
define('grandparent grandparents', one(up(), up()));
define('barnbarn grandchild grandchildren', one(down(), down()));
define('sonson', one(down('male'), down('male')));
define('sondotter', one(down('male'), down('female')));
define('dotterson', one(down('female'), down('male')));
define('dotterdotter', one(down('female'), down('female')));
define('grandson', one(down(), down('male')));
define('granddaughter', one(down(), down('female')));
// Aunts, uncles, cousins, nieces and nephews.
define('moster', one(up('female'), sibling('female')));
define('faster', one(up('male'), sibling('female')));
define('morbror', one(up('female'), sibling('male')));
define('farbror', one(up('male'), sibling('male')));
define('aunt aunts', one(up(), sibling('female')));
define('uncle uncles', one(up(), sibling('male')));
define('kusin kusiner cousin cousins', one(up(), sibling(), down()));
define('syskonbarn', one(sibling(), down()));
define('brorson', one(sibling('male'), down('male')));
define('brorsdotter', one(sibling('male'), down('female')));
define('systerson', one(sibling('female'), down('male')));
define('systerdotter', one(sibling('female'), down('female')));
define('nephew nephews', one(sibling(), down('male')));
define('niece nieces', one(sibling(), down('female')));
// In-laws: through a partner, or a relative's partner.
define('svärfar father-in-law', one(partner(), up('male')));
define('svärmor mother-in-law', one(partner(), up('female')));
define('svärföräldrar parents-in-law', one(partner(), up()));
define('svärson son-in-law', one(down(), partner('male')));
define('svärdotter daughter-in-law', one(down(), partner('female')));
define('svåger brother-in-law', either([sibling(), partner('male')], [partner(), sibling('male')]));
define('svägerska sister-in-law', either([sibling(), partner('female')], [partner(), sibling('female')]));
// Step relations: a parent's partner who is not a parent, a partner's child who is not one's own.
define('styvfar styvpappa stepfather stepdad', { chains: [[up(), partner('male')]], exclude: 'parents' });
define('styvmor styvmamma stepmother stepmom', { chains: [[up(), partner('female')]], exclude: 'parents' });
define('styvförälder stepparent', { chains: [[up(), partner()]], exclude: 'parents' });
define('styvson stepson', { chains: [[partner(), down('male')]], exclude: 'children' });
define('styvdotter stepdaughter', { chains: [[partner(), down('female')]], exclude: 'children' });
define('styvbarn stepchild stepchildren', { chains: [[partner(), down()]], exclude: 'children' });

// The whole immediate family: what "vilka är mina släktingar" and a model writing "alla" mean.
define('familj familjen family släkt släkten släktingar relatives alla all everyone närmaste', either([up()], [partner()], [down()]));

/** Every kin word, for the fast path to know a sentence needs the loop. */
export const KIN_WORDS: readonly string[] = Object.keys(TERMS);

/** Words a phrase may carry that say nothing about the relation: "min mammas syster", "my dad's brother". */
const FILLER = new Set(['min', 'mitt', 'mina', 'din', 'ditt', 'dina', 'hans', 'hennes', 'vår', 'vårt', 'våra', 'my', 'your', 'his', 'her', 'our', 'the', 'of', 'till', 'på']);

const lookup = (word: string): Term | undefined => {
  if (TERMS[word]) return TERMS[word];
  // Possessive: "mammas", "father's", "mothers'".
  const bare = word.replace(/['’]s$|s['’]$|s$/, '');
  return bare !== word ? TERMS[bare] : undefined;
};

/**
 * A relation phrase as its terms, in order. Undefined when any word is not a kin word: the
 * caller decides whether that is an error to explain or a name to search for.
 */
export const parseKin = (phrase: string): Term[] | undefined => {
  const words = phrase.toLowerCase().trim().split(/\s+/).filter((word) => word && !FILLER.has(word));
  if (words.length === 0) return undefined;
  const terms: Term[] = [];
  for (const word of words) {
    const term = lookup(word);
    if (!term) return undefined;
    terms.push(term);
  }
  return terms;
};

/**
 * The one kin phrase a message carries, when it carries exactly one: "vilka är mina kusiner?"
 * is "kusiner", "vem är min mammas syster" is "mammas syster". Two phrases, or none, is
 * undefined — the model's own word stands then. The 8B model copies the relation word from
 * whichever prompt example the question resembles ("vilka är mina kusiner" became "barn"), so
 * the tool checks its word against the user's and prefers the user's.
 */
export const kinInMessage = (message: string): string | undefined => {
  const tokens = message.toLowerCase().replace(/[?!.,:;"()]/g, ' ').split(/\s+/).filter(Boolean);
  const runs: string[][] = [];
  let run: string[] = [];
  for (const token of tokens) {
    if (lookup(token)) run.push(token);
    else if (run.length && FILLER.has(token)) continue;
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.length === 1 ? runs[0].join(' ') : undefined;
};

const attrsOf = async (ctx: Ctx, path: string): Promise<PersonAttrs | undefined> => {
  try {
    return (await ctx.vfs.get<PersonAttrs>(ctx.access, path)).attrs;
  } catch {
    return undefined;
  }
};

const neighbours = async (ctx: Ctx, path: string, dir: Step['dir']): Promise<string[]> => {
  switch (dir) {
    case 'up':
      return (await getParents(ctx, path)).map((e) => e.path);
    case 'down':
      return (await getChildren(ctx, path)).map((e) => e.path);
    case 'partner':
      return (await getPartners(ctx, path)).map((e) => e.path);
    case 'sibling': {
      const siblings = new Set<string>();
      for (const parent of await getParents(ctx, path)) {
        for (const child of await getChildren(ctx, parent.path)) if (child.path !== path) siblings.add(child.path);
      }
      return [...siblings];
    }
  }
};

/** One step from a set of people: the union of everyone it reaches, gender-filtered. */
const step = async (ctx: Ctx, from: Set<string>, { dir, gender }: Step): Promise<Set<string>> => {
  const reached = new Set<string>();
  for (const path of from) for (const next of await neighbours(ctx, path, dir)) reached.add(next);
  if (!gender) return reached;
  const exact = new Set<string>();
  const unknown = new Set<string>();
  for (const path of reached) {
    const g = await getGender(ctx, path);
    if (g === gender) exact.add(path);
    else if (g === 'unknown') unknown.add(path);
  }
  return exact.size > 0 ? exact : unknown;
};

export type Relative = {
  path: string;
  slug: string;
  name: string;
  gender?: PersonGender;
  born?: string;
  died?: string;
  /** What this person is to the one asked about, in both languages, from the graph itself. */
  relation: { sv: string; en: string };
};

/** More than this and the question was "who is my relative", which is a family tree, not an answer. */
const MAX_RELATIVES = 20;

/**
 * Everyone the phrase reaches from `start`, with what the graph says they are to them. The
 * relation is computed back from the graph rather than echoed from the phrase: "syskon" may
 * come back as "syster", "parent" as "father".
 */
export const walkKin = async (ctx: Ctx, start: string, terms: Term[]): Promise<Relative[]> => {
  let current = new Set([start]);
  for (const term of terms) {
    const next = new Set<string>();
    for (const chain of term.chains) {
      let set = current;
      for (const s of chain) set = await step(ctx, set, s);
      for (const path of set) next.add(path);
    }
    if (term.exclude) {
      for (const from of current) {
        const own = term.exclude === 'parents' ? await getParents(ctx, from) : await getChildren(ctx, from);
        for (const e of own) next.delete(e.path);
      }
    }
    current = next;
  }
  current.delete(start);

  const relatives: Relative[] = [];
  for (const path of [...current].slice(0, MAX_RELATIVES)) {
    const attrs = await attrsOf(ctx, path);
    const slug = path.split('/').filter(Boolean).pop() ?? path;
    const kin = await kinship(ctx, start, path);
    relatives.push({
      path,
      slug,
      name: attrs?.name ?? slug,
      ...(attrs?.gender ? { gender: attrs.gender } : {}),
      ...(attrs?.born ? { born: attrs.born } : {}),
      ...(attrs?.died ? { died: attrs.died } : {}),
      relation: { sv: render(kin, 'sv'), en: render(kin, 'en') },
    });
  }
  return relatives;
};

/**
 * The span of `takenAt` in which someone born on `born` was `age` years old — `to` exclusive,
 * as `search --to` reads it. A birth date without a day is left as coarse as it is: born
 * "1990", age 6 is 1996 through 1997, which is honest rather than falsely exact.
 */
export const ageSpan = (born: string, age: number): { from: string; to: string } | undefined => {
  const match = datePart(born).match(/^(\d{4})(-\d{2}(?:-\d{2})?)?$/);
  if (!match || !Number.isInteger(age) || age < 0 || age > 130) return undefined;
  const year = Number(match[1]);
  const rest = match[2] ?? '';
  return { from: `${year + age}${rest}`, to: `${year + age + 1}${rest}` };
};
