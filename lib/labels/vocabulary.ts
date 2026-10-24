/**
 * The words a label can start from before anyone has used it: things a family archive's pictures
 * show, each with the sentence it is scored by in the picture space and the label it becomes in
 * each language the archive can be in (`CFG_LANGUAGE`).
 *
 * A word is a label as `label` takes one: no spaces or slashes. A language left out of a concept
 * has no word for it, and an archive in that language is not offered it.
 */

/** The languages the vocabulary has words in. */
type Language = 'en' | 'sv';

type Concept = { prompt: string; words: Partial<Record<Language, string>> };

const concept = (prompt: string, en: string, sv: string): Concept => ({ prompt, words: { en, sv } });

export const VOCABULARY: Concept[] = [
  // Seasons, weather and light
  concept('a photo of snow', 'snow', 'snö'),
  concept('a photo of a winter landscape', 'winter', 'vinter'),
  concept('a photo of autumn leaves', 'autumn', 'höst'),
  concept('a photo of a sunset', 'sunset', 'solnedgång'),
  concept('a photo taken at night', 'night', 'natt'),
  concept('a photo of rain', 'rain', 'regn'),
  concept('a photo of fireworks', 'fireworks', 'fyrverkeri'),
  // Places
  concept('a photo of a beach', 'beach', 'strand'),
  concept('a photo of the sea', 'sea', 'hav'),
  concept('a photo of a lake', 'lake', 'sjö'),
  concept('a photo of a forest', 'forest', 'skog'),
  concept('a photo of mountains', 'mountains', 'fjäll'),
  concept('a photo of a city street', 'city', 'stad'),
  concept('a photo of a garden', 'garden', 'trädgård'),
  concept('a photo of a field', 'field', 'åker'),
  concept('a photo of an archipelago with rocky islands', 'archipelago', 'skärgård'),
  concept('a photo of a harbour', 'harbour', 'hamn'),
  concept('a photo of a church', 'church', 'kyrka'),
  concept('a photo of a castle', 'castle', 'slott'),
  concept('a photo of a museum', 'museum', 'museum'),
  concept('a photo of a playground', 'playground', 'lekplats'),
  concept('a photo of a swimming pool', 'pool', 'pool'),
  concept('a photo of a kitchen', 'kitchen', 'kök'),
  concept('a photo of a summer cottage', 'cottage', 'stuga'),
  concept('a photo of a campsite with a tent', 'camping', 'camping'),
  concept('a photo of an airport or an aeroplane', 'airport', 'flygplats'),
  concept('a photo of a school classroom', 'school', 'skola'),
  // Occasions
  concept('a photo of a birthday party', 'birthday', 'födelsedag'),
  concept('a photo of a birthday cake with candles', 'birthday_cake', 'tårta'),
  concept('a photo of a wedding', 'wedding', 'bröllop'),
  concept('a photo of a christmas tree', 'christmas', 'jul'),
  concept('a photo of a midsummer celebration with a maypole', 'midsummer', 'midsommar'),
  concept('a photo of easter eggs', 'easter', 'påsk'),
  concept('a photo of a graduation', 'graduation', 'examen'),
  concept('a photo of a party', 'party', 'fest'),
  concept('a photo of a dinner party', 'dinner', 'middag'),
  concept('a photo of a baptism', 'baptism', 'dop'),
  concept('a photo of a concert', 'concert', 'konsert'),
  concept('a photo of a picnic', 'picnic', 'picknick'),
  concept('a photo of a crayfish party', 'crayfish_party', 'kräftskiva'),
  // Activities
  concept('a photo of people swimming', 'swimming', 'bad'),
  concept('a photo of skiing', 'skiing', 'skidor'),
  concept('a photo of ice skating', 'skating', 'skridskor'),
  concept('a photo of a sailing boat', 'sailing', 'segling'),
  concept('a photo of fishing', 'fishing', 'fiske'),
  concept('a photo of hiking', 'hiking', 'vandring'),
  concept('a photo of cycling', 'cycling', 'cykling'),
  concept('a photo of football', 'football', 'fotboll'),
  concept('a photo of horse riding', 'riding', 'ridning'),
  concept('a photo of people dancing', 'dancing', 'dans'),
  concept('a photo of people playing music', 'music', 'musik'),
  concept('a photo of cooking', 'cooking', 'matlagning'),
  concept('a photo of a board game', 'games', 'spel'),
  // People in the picture
  concept('a photo of a baby', 'baby', 'bebis'),
  concept('a photo of children playing', 'children', 'barn'),
  concept('a group photo of many people', 'group_photo', 'gruppbild'),
  concept('a portrait photo of one person', 'portrait', 'porträtt'),
  // Animals
  concept('a photo of a dog', 'dog', 'hund'),
  concept('a photo of a cat', 'cat', 'katt'),
  concept('a photo of a horse', 'horse', 'häst'),
  concept('a photo of a bird', 'bird', 'fågel'),
  concept('a photo of cows', 'cows', 'kor'),
  concept('a photo of a moose', 'moose', 'älg'),
  // Things
  concept('a photo of a boat', 'boat', 'båt'),
  concept('a photo of a car', 'car', 'bil'),
  concept('a photo of a motorhome', 'motorhome', 'husbil'),
  concept('a photo of a caravan', 'caravan', 'husvagn'),
  concept('a photo of a train', 'train', 'tåg'),
  concept('a photo of a bicycle', 'bicycle', 'cykel'),
  concept('a photo of a tractor', 'tractor', 'traktor'),
  concept('a photo of flowers', 'flowers', 'blommor'),
  concept('a photo of food on a plate', 'food', 'mat'),
  concept('a photo of a cake', 'cake', 'kaka'),
  concept('a photo of a christmas present', 'presents', 'paket'),
  concept('a photo of a house', 'house', 'hus'),
  concept('a photo of a bonfire', 'bonfire', 'brasa'),
  // Pictures of pictures
  concept('a scanned old black and white photograph', 'black_and_white', 'svartvitt'),
  concept('a scanned document with text', 'document', 'dokument'),
  concept('a screenshot of a phone or computer screen', 'screenshot', 'skärmbild'),
  concept('a photo of a drawing or painting', 'drawing', 'teckning'),
  concept('a photo of a map', 'map', 'karta'),
];

/** The concepts with a word in `language`, as label and prompt. */
export const vocabularyFor = (language: string): { label: string; prompt: string }[] =>
  VOCABULARY.flatMap((entry) => {
    const word = entry.words[language as Language];
    return word ? [{ label: word, prompt: entry.prompt }] : [];
  });
