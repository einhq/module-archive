/**
 * Display name -> path segment, matching what the server would choose.
 *
 * The rule **transliterates** rather than stripping, because dropping non-ASCII
 * turns "Åsa Öberg" into `sa-berg`. The UI needs the answer up front, to propose
 * a path to `person-create` and to know where to navigate afterwards; where the
 * two differ, the server's is the one the node gets.
 */

/** The server's transliteration table. */
const TRANSLITERATE: Record<string, string> = {
  å: 'a',
  ä: 'a',
  ö: 'o',
  é: 'e',
  è: 'e',
  ê: 'e',
  ü: 'u',
  ø: 'o',
  æ: 'ae',
  ß: 'ss',
  ñ: 'n',
  ç: 'c',
};

export function personSlug(name: string): string {
  const lowered = name.trim().toLowerCase().normalize('NFC');
  let out = '';
  for (const character of lowered) out += TRANSLITERATE[character] ?? character;
  return out
    // Anything still carrying an accent decomposes and loses it — the table
    // covers the letters that have no decomposition, this covers the rest.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
