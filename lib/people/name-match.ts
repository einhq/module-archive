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
