/**
 * Whether what someone typed names a person, word by word: every word is in one of the person's
 * names, in any order and with other names between, so "Anna Andersson" finds "Anna B Andersson".
 * The words must all belong to the one person. Free of imports, so the pages use it as the
 * search providers do.
 */

/** The words of `query`, lower case, each once. */
export const nameWords = (query: string): string[] => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];

/** Every one of `words` (from `nameWords`) is in one of `names`; false for no words. */
export const namesHaveWords = (words: string[], names: (string | undefined)[]): boolean => {
  const lower = names.filter((name): name is string => !!name).map((name) => name.toLowerCase());
  return words.length > 0 && words.every((word) => lower.some((name) => name.includes(word)));
};

/** A name's whole words, lower case: split at spaces and hyphens, so "Runge-Broberg" holds "broberg". */
const wholeWords = (name: string): string[] => name.toLowerCase().split(/[\s-]+/).filter(Boolean);

/**
 * Whether `query` is two or more whole words of `name`, in any order and with other names between:
 * what a person types for someone whose name has more in it, "Anna Andersson" for "Anna B Andersson"
 * or "Anna Berg-Andersson". One word alone is not: a surname is a whole family's.
 */
export const nameHasWholeWords = (query: string, name: string | undefined): boolean => {
  const asked = wholeWords(query);
  if (!name || asked.length < 2) return false;
  const whole = new Set(wholeWords(name));
  return asked.every((word) => whole.has(word));
};

/** How well `word` matches one of `whole`: 0 a whole word, 1 the start of one, 2 inside one, 3 none. */
const wordFit = (word: string, whole: string[]): number => {
  let fit = 3;
  for (const candidate of whole) {
    if (candidate === word) return 0;
    if (candidate.startsWith(word)) fit = Math.min(fit, 1);
    else if (candidate.includes(word)) fit = Math.min(fit, 2);
  }
  return fit;
};

/**
 * How well `query` names a person whose names are `names`, the name they go by first: lower is
 * better, for ordering what `namesHaveWords` lets through. The name itself typed out comes first;
 * then each typed word scores by whether it is a whole word of a name, starts one or is inside one,
 * so "Johan Johansson" puts Johan Johansson before Abraham Johansson, whose "johansson" only starts
 * with "johan"; a word out of the name's order, or found only in a full or birth name, counts a
 * little against.
 */
export const nameMatchRank = (query: string, names: (string | undefined)[]): number => {
  const words = [...new Set(wholeWords(query))];
  const typed = wholeWords(query).join(' ');
  const [own, ...others] = names.map((name) => wholeWords(name ?? ''));
  if (own.join(' ') === typed) return 0;
  if (others.some((name) => name.join(' ') === typed)) return 1;
  const all = [own, ...others].flat();
  return 2 + words.reduce((sum, word, index) => {
    const inOwn = wordFit(word, own);
    const inAny = wordFit(word, all);
    if (inOwn > inAny) return sum + 10 * inAny + 3;
    // Typed in the name's order: "johan" fits Johanna Johansson's first word, Abraham's second.
    return sum + 10 * inOwn + (own[index] !== undefined && wordFit(word, [own[index]]) === inOwn ? 0 : 1);
  }, 0);
};

/**
 * `items` best match for `query` first (`nameMatchRank`), keeping their order among equals; each
 * item's names come from `namesOf`, the name it goes by first.
 */
export const byNameMatch = <T>(items: readonly T[], query: string, namesOf: (item: T) => (string | undefined)[]): T[] =>
  items
    .map((item, index) => ({ item, index, rank: nameMatchRank(query, namesOf(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
