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
