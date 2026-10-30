/**
 * The deterministic parse: what can be extracted from a search without a model — years and content
 * kinds, in English and Swedish. Those two have a closed, unambiguous vocabulary, and a year written
 * "före 2010" is a bound the rules read more exactly than a model does. It is the search box's
 * instant first pass, and the whole parse when the model is unavailable.
 */

/** The content kinds a search can be narrowed to. */
export type RuleKind = 'photo' | 'video' | 'audio' | 'document' | 'person' | 'location' | 'album';
type Kind = RuleKind;

/** What the rules find: years, kinds, and the words left over. */
type RulesParse = { text: string; kinds: Kind[]; from?: string; to?: string };

/** Words that name a content kind. Swedish included: the library and its users are Swedish. */
const KIND_WORDS: Record<string, Kind> = {
  photo: 'photo',
  photos: 'photo',
  photograph: 'photo',
  photographs: 'photo',
  picture: 'photo',
  pictures: 'photo',
  pic: 'photo',
  pics: 'photo',
  image: 'photo',
  images: 'photo',
  foto: 'photo',
  foton: 'photo',
  fotografi: 'photo',
  fotografier: 'photo',
  bild: 'photo',
  bilder: 'photo',
  kort: 'photo',
  video: 'video',
  videos: 'video',
  videor: 'video',
  film: 'video',
  films: 'video',
  filmer: 'video',
  movie: 'video',
  movies: 'video',
  clip: 'video',
  clips: 'video',
  audio: 'audio',
  recording: 'audio',
  recordings: 'audio',
  ljud: 'audio',
  inspelning: 'audio',
  inspelningar: 'audio',
  document: 'document',
  documents: 'document',
  dokument: 'document',
  album: 'album',
  albums: 'album',
  person: 'person',
  people: 'person',
  personer: 'person',
  location: 'location',
  locations: 'location',
  plats: 'location',
  platser: 'location',
};

/** A four-digit year in a plausible range. Bounded so a house number cannot become a year. */
const YEAR = /\b(1[89]\d{2}|20\d{2})\b/g;

/** Words left dangling at an edge after a kind, year, person, or location is removed. */
const FILTER_GLUE = new Set([
  'a',
  'an',
  'and',
  'after',
  'are',
  'at',
  'av',
  'before',
  'between',
  'by',
  'efter',
  'en',
  'ett',
  'for',
  'from',
  'från',
  'före',
  'i',
  'in',
  'innan',
  'is',
  'med',
  'mellan',
  'min',
  'mina',
  'mitt',
  'my',
  'near',
  'och',
  'of',
  'on',
  'på',
  'sedan',
  'since',
  'som',
  'the',
  'there',
  'till',
  'to',
  'var',
  'was',
  'were',
  'when',
  'with',
  'där',
]);

const bareWord = (word: string): string => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLocaleLowerCase();

/** Remove connector fragments which only attached a filter at either edge. */
const trimFilterGlue = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 0 && FILTER_GLUE.has(bareWord(words[0]))) words.shift();
  while (words.length > 0 && FILTER_GLUE.has(bareWord(words.at(-1)!))) words.pop();
  return words.join(' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '');
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

const namedFilterPattern = (name: string): RegExp => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(name)}(?=$|[^\\p{L}\\p{N}])`, 'iu');

/**
 * Remove model-proposed names from the semantic half of a query.
 *
 * Whole-span matching matters: removing a person named `Ann` from `annual` would damage the
 * actual visual query.
 */
export const stripNamedFilters = (text: string, names: readonly string[]): string => {
  let rest = text;
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const pattern = new RegExp(namedFilterPattern(trimmed).source, 'giu');
    rest = rest.replace(pattern, '$1');
  }
  return trimFilterGlue(rest);
};

/**
 * Extract what is unambiguous, leave the rest as text.
 *
 * Matched year and kind words are removed from `text` so they are not also embedded as part
 * of the semantic query — "photos from 2011" should search for nothing in particular within
 * 2011, not for the concept of photos-from-2011.
 */
export const parseWithRules = (input: string): RulesParse => {
  const extraction: RulesParse = { text: '', kinds: [] };
  let text = input.trim();
  if (!text) return extraction;
  let removed = false;

  const currentYear = new Date().getFullYear();
  const yearMatches = [...text.matchAll(YEAR)].filter((match) => Number(match[1]) <= currentYear + 1);
  const years = yearMatches.map((match) => Number(match[1]));

  if (years.length > 0) {
    if (years.length === 1) {
      const year = String(years[0]);
      const before = text.slice(0, yearMatches[0].index).match(/(?:^|\s)(?:before|until|före|innan)\s*$/iu);
      const after = text.slice(0, yearMatches[0].index).match(/(?:^|\s)(?:after|since|efter|sedan)\s*$/iu);
      if (before) extraction.to = year;
      else if (after) extraction.from = year;
      else extraction.from = extraction.to = year;
    } else {
      // Several years mean a span, irrespective of the order in which they were typed.
      extraction.from = String(Math.min(...years));
      extraction.to = String(Math.max(...years));
    }
    text = text.replace(YEAR, ' ');
    removed = true;
  }

  const kept: string[] = [];
  for (const word of text.split(/\s+/)) {
    const bare = word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const kind = bare ? KIND_WORDS[bare] : undefined;
    if (kind) {
      if (!extraction.kinds.includes(kind)) extraction.kinds.push(kind);
      removed = true;
      continue;
    }
    if (word.trim()) kept.push(word);
  }

  const remaining = kept.join(' ').replace(/\s+/g, ' ').trim();
  extraction.text = removed ? trimFilterGlue(remaining) : remaining;
  return extraction;
};

/**
 * What is left of the sentence once the request verb, the kind word and the glue are gone —
 * the visual content, if any. The parse is told to leave the verb out of `text`, but a model
 * that keeps it ("Visa bilder") would have the semantic search rank the pictures by the word
 * "visa", which is nothing at all.
 */
export const contentWords = (text: string): string => {
  let rest = text.trim();
  rest = rest.replace(/^(visa|hitta|leta (upp|efter|fram)|ge mig|show|find|get)\b\s*(mig|me|oss|us)?\s*/i, '');
  // A count, "fler", "nya": how many and that they should be new, not what they show.
  rest = rest.replace(/^((\d+|alla|all|några|some|the|fler|flera|more|another|ytterligare|nya|new|andra|other)(\s+|$))+/i, '');
  rest = rest.replace(/^(bilder|bilderna|foton|fotona|filmer|filmerna|pictures|photos|videos|images)\b\s*/i, '');
  // `\b` is not Unicode-aware, so "på" needs a spelled-out boundary.
  rest = rest.replace(/^(på|av|med|of|with|från|from|i|in)(?=\s|$)\s*/i, '');
  rest = rest.replace(/(?:^|\s)(på|av|med|of|with|från|from|i|in|och|and)$/i, '');
  return rest.trim();
};
