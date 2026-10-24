/**
 * How well words match a name, and what a name says: what the search providers rank names by, what
 * staging weighs a folder's label against a library album's title by, and whether a title says
 * the album is a catch-all.
 */

/** How well `query` (lower case) matches `field`: exact 1, prefix 0.8, substring by how much of it the query is (at least 0.5); 0 for none. */
export const quality = (query: string, field: string | undefined): number => {
  if (!field) return 0;
  const value = field.toLowerCase();
  if (value === query) return 1;
  if (value.startsWith(query)) return 0.8;
  if (value.includes(query)) return Math.max(0.5, query.length / value.length);
  return 0;
};

/** The text after a prefix continues the word it ended in. */
const WORD_GOES_ON = /^[\p{L}\p{N}]/u;

/**
 * How well a search's `query` (lower case) names `field`, on the `name` channel's scale: exact 1, a
 * prefix that ends where a word of the name does 0.8 ("anna" in "Anna Andersson"), a prefix inside a
 * word 0.7, and a substring by how much of the name it is, from 0.5 to 0.7; 0 for none. Only the
 * first two claim that this is what the query means: "fyr" starts "Fyrskeppsgatan" and says little.
 */
export const nameScore = (query: string, field: string | undefined): number => {
  if (!field) return 0;
  const value = field.toLowerCase();
  if (value === query) return 1;
  if (value.startsWith(query)) return WORD_GOES_ON.test(value.slice(query.length)) ? 0.7 : 0.8;
  if (value.includes(query)) return Math.min(0.7, Math.max(0.5, query.length / value.length));
  return 0;
};

/**
 * Words that say an album holds whatever was left over rather than one happening: unsorted,
 * miscellaneous, a camera roll or an upload, pictures from different years. English and Swedish.
 */
const UNSORTED = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:' + [
    'unsorted',
    'uncategori[sz]ed',
    'misc',
    'miscellaneous',
    'various',
    'assorted',
    'leftovers',
    'camera roll',
    'uploads?',
    'new folder',
    'from different years',
    'osorterad\\p{L}*',
    'osorterat',
    'blandad\\p{L}*',
    'blandat',
    'diverse',
    'övrig\\p{L}*',
    'udda',
    'uppladdning\\p{L}*',
    'från olika år',
  ].join('|') + ')(?![\\p{L}\\p{N}])',
  'iu',
);

/** Whether a name says it holds whatever was left over (`Unsorted 2019`, `Misc`, `Camera roll`). */
export const saysUnsorted = (name: string | undefined): boolean => name !== undefined && UNSORTED.test(name);
