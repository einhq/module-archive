/**
 * Reading a GEDCOM file, the genealogy exchange format (5.5, 5.5.1 and 7): its bytes to text in
 * the character set it declares, its lines to a tree of records, and the records to the
 * individuals and families the import uses. Pure: no VFS, so the tests read files directly.
 */

/** One line of a GEDCOM file with the lines under it: `1 BIRT` holding `2 DATE 1 JAN 1900`. */
type GedcomLine = { tag: string; xref?: string; value: string; children: GedcomLine[] };

// ---------- bytes to text ----------

/** ANSEL's spacing characters above ASCII, as GEDCOM uses them. */
const ANSEL_SPACING: Record<number, string> = {
  0xA1: 'Ł',
  0xA2: 'Ø',
  0xA3: 'Đ',
  0xA4: 'Þ',
  0xA5: 'Æ',
  0xA6: 'Œ',
  0xA7: 'ʹ',
  0xA8: '·',
  0xA9: '♭',
  0xAA: '®',
  0xAB: '±',
  0xAC: 'Ơ',
  0xAD: 'Ư',
  0xAE: 'ʼ',
  0xB0: 'ʻ',
  0xB1: 'ł',
  0xB2: 'ø',
  0xB3: 'đ',
  0xB4: 'þ',
  0xB5: 'æ',
  0xB6: 'œ',
  0xB7: 'ʺ',
  0xB8: 'ı',
  0xB9: '£',
  0xBA: 'ð',
  0xBC: 'ơ',
  0xBD: 'ư',
  0xBE: '□',
  0xBF: '■',
  0xC0: '°',
  0xC1: 'ℓ',
  0xC2: '℗',
  0xC3: '©',
  0xC4: '♯',
  0xC5: '¿',
  0xC6: '¡',
  0xC7: 'ß',
  0xC8: '€',
  0xCD: 'e',
  0xCE: 'o',
  0xCF: 'ß',
};

/** ANSEL's combining marks, which come before the letter they sit on, as their Unicode code points. */
const ANSEL_COMBINING: Record<number, number> = {
  0xE0: 0x0309,
  0xE1: 0x0300,
  0xE2: 0x0301,
  0xE3: 0x0302,
  0xE4: 0x0303,
  0xE5: 0x0304,
  0xE6: 0x0306,
  0xE7: 0x0307,
  0xE8: 0x0308,
  0xE9: 0x030C,
  0xEA: 0x030A,
  0xEB: 0xFE20,
  0xEC: 0xFE21,
  0xED: 0x0315,
  0xEE: 0x030B,
  0xEF: 0x0310,
  0xF0: 0x0327,
  0xF1: 0x0328,
  0xF2: 0x0323,
  0xF3: 0x0324,
  0xF4: 0x0325,
  0xF5: 0x0333,
  0xF6: 0x0332,
  0xF7: 0x0326,
  0xF8: 0x031C,
  0xF9: 0x032E,
  0xFA: 0xFE22,
  0xFB: 0xFE23,
  0xFE: 0x0313,
};

/** ANSEL to text: a mark is moved after the letter it precedes, and the result composed (NFC). */
export const decodeAnsel = (bytes: Uint8Array): string => {
  let out = '';
  let marks = '';
  for (const byte of bytes) {
    const mark = ANSEL_COMBINING[byte];
    if (mark) {
      marks += String.fromCharCode(mark);
      continue;
    }
    out += (byte < 0x80 ? String.fromCharCode(byte) : ANSEL_SPACING[byte] ?? String.fromCharCode(0xFFFD)) + marks;
    marks = '';
  }
  return (out + marks).normalize('NFC');
};

const isUtf8 = (bytes: Uint8Array): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * A GEDCOM file's text. A byte order mark settles it; otherwise the header's `CHAR` does, except
 * that a file that is valid UTF-8 is read as UTF-8 whatever it declares, since programs that write
 * `ANSI` or `IBMPC` often write UTF-8. `ANSEL` is decoded as such, and every other single-byte set
 * as Windows-1252.
 */
export const decodeGedcom = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0x30 && bytes[1] === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0x00 && bytes[1] === 0x30) return new TextDecoder('utf-16be').decode(bytes);

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const declared = head.match(/^\s*1\s+CHAR\s+(\S+)/m)?.[1]?.toUpperCase();
  if (isUtf8(bytes)) return new TextDecoder('utf-8').decode(bytes);
  if (declared === 'ANSEL') return decodeAnsel(bytes);
  return new TextDecoder('windows-1252').decode(bytes);
};

// ---------- text to records ----------

const LINE = /^\s*(\d+)\s+(?:(@[^@]+@)\s+)?([A-Za-z0-9_]+)(?: (.*))?$/;

/**
 * The records of a GEDCOM text, each with the lines under it. `CONT` and `CONC` are folded into
 * the value they continue (a new line, or straight on); a line that is not GEDCOM is skipped.
 */
const parseGedcomLines = (text: string): GedcomLine[] => {
  const records: GedcomLine[] = [];
  const stack: GedcomLine[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const match = raw.match(LINE);
    if (!match) continue;
    const level = Number(match[1]);
    const tag = match[3].toUpperCase();
    const value = (match[4] ?? '').replace(/@@/g, '@');
    if ((tag === 'CONT' || tag === 'CONC') && level > 0 && stack[level - 1]) {
      stack[level - 1].value += (tag === 'CONT' ? '\n' : '') + value;
      continue;
    }
    const line: GedcomLine = { tag, value, children: [], ...(match[2] ? { xref: match[2] } : {}) };
    if (level === 0) records.push(line);
    else if (stack[level - 1]) stack[level - 1].children.push(line);
    else continue;
    stack[level] = line;
    stack.length = level + 1;
  }
  return records;
};

const child = (line: GedcomLine, tag: string): GedcomLine | undefined => line.children.find((c) => c.tag === tag);
const childrenOf = (line: GedcomLine, tag: string): GedcomLine[] => line.children.filter((c) => c.tag === tag);

// ---------- dates ----------

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * A GEDCOM date as EiN keeps one, and the years it can be in. `date` (`YYYY`, `YYYY-MM` or
 * `YYYY-MM-DD`) is set only for a date given without a qualifier or as calculated; an
 * approximate, bounded or ranged date gives only the span of years, for matching.
 */
export type GedcomDate = { date?: string; from: number; to: number };

const point = (text: string): { date: string; year: number } | undefined => {
  // A calendar is named as `@#DJULIAN@` (5.5) or `JULIAN` (7); the date is read as written in it.
  const parts = text.replace(/@#D[^@]*@/g, '').replace(/^\s*(GREGORIAN|JULIAN)\s+/i, '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const year = Number(parts.pop()?.split('/')[0]);
  if (!Number.isInteger(year) || year <= 0) return undefined;
  const month = parts.length ? MONTHS[parts.pop()!] : undefined;
  const day = parts.length ? Number(parts.pop()) : undefined;
  const yyyy = String(year).padStart(4, '0');
  if (!month) return { date: yyyy, year };
  const mm = String(month).padStart(2, '0');
  if (!day || !Number.isInteger(day) || day < 1 || day > 31) return { date: `${yyyy}-${mm}`, year };
  return { date: `${yyyy}-${mm}-${String(day).padStart(2, '0')}`, year };
};

/** Read a GEDCOM `DATE` value; undefined when it names no year (`UNKNOWN`, a phrase). */
export const parseGedcomDate = (value: string): GedcomDate | undefined => {
  const text = value.replace(/\(.*\)/g, '').trim().toUpperCase();
  const between = text.match(/^(?:BET|FROM)\s+(.+?)\s+(?:AND|TO)\s+(.+)$/);
  if (between) {
    const [a, b] = [point(between[1]), point(between[2])];
    return a && b ? { from: Math.min(a.year, b.year), to: Math.max(a.year, b.year) } : undefined;
  }
  const qualified = text.match(/^(ABT|EST|CAL|BEF|AFT|FROM|TO|INT)\s+(.+)$/);
  if (!qualified) {
    const p = point(text);
    return p && { date: p.date, from: p.year, to: p.year };
  }
  const p = point(qualified[2]);
  if (!p) return undefined;
  switch (qualified[1]) {
    case 'CAL':
    case 'INT':
      return { date: p.date, from: p.year, to: p.year };
    case 'BEF':
    case 'TO':
      return { from: p.year - 100, to: p.year };
    case 'AFT':
    case 'FROM':
      return { from: p.year, to: p.year + 100 };
    default:
      return { from: p.year - 2, to: p.year + 2 };
  }
};

// ---------- individuals and families ----------

/** A parent tie in a GEDCOM file as EiN names it: `blood`, `adoptive` or `foster`. */
type GedcomParentKind = 'blood' | 'adoptive' | 'foster';

/** An individual (`INDI`) as the import reads it. */
export type GedcomIndividual = {
  xref: string;
  /** Every given name, in order, with the call name's marks (`*`, quotes) taken off. */
  given: string[];
  /** The name the person goes by: the marked call name, the nickname, else the first given name. */
  callName?: string;
  /** The surname they were born with: of the birth name, else of the first name record. */
  surname?: string;
  /** The surname of a married name record, when it is another. */
  marriedSurname?: string;
  gender?: 'male' | 'female' | 'other' | 'unknown';
  born?: GedcomDate;
  died?: GedcomDate;
  /** The years of a christening or a burial, which bound the birth and death for matching. */
  christened?: GedcomDate;
  buried?: GedcomDate;
  /** The file's own identifiers for the person (`_UID`, `UID`), which survive between exports. */
  uids: string[];
  /** The families they are a child (`FAMC`) and a partner (`FAMS`) in. */
  childOf: { family: string; kind: GedcomParentKind }[];
  partnerIn: string[];
};

/** A family (`FAM`): its partners, its children and when it began and ended. */
type GedcomFamily = {
  xref: string;
  partners: string[];
  children: string[];
  married: boolean;
  marriedOn?: string;
  divorcedOn?: string;
};

export type Gedcom = { individuals: GedcomIndividual[]; families: GedcomFamily[] };

const PEDIGREE: Record<string, GedcomParentKind> = { BIRTH: 'blood', ADOPTED: 'adoptive', FOSTER: 'foster' };

/** Given names as written, the call name marked with a trailing `*` or in quotes. */
const readGiven = (text: string): { given: string[]; marked?: string } => {
  let marked: string | undefined;
  const given = text.split(/\s+/).filter(Boolean).map((word) => {
    const bare = word.replace(/^["“”']+|["“”']+$/g, '').replace(/\*$/, '');
    if (bare !== word && !marked) marked = bare;
    return bare;
  }).filter(Boolean);
  return { given, marked };
};

const readName = (line: GedcomLine): { given: string[]; marked?: string; surname?: string; nick?: string; type?: string } => {
  const slashed = line.value.match(/^([^/]*)\/([^/]*)\/?(.*)$/);
  const givenText = child(line, 'GIVN')?.value ?? (slashed ? slashed[1] : line.value);
  const surname = (child(line, 'SURN')?.value ?? slashed?.[2] ?? '').trim().replace(/\s+/g, ' ');
  return {
    ...readGiven(givenText.trim()),
    ...(surname ? { surname } : {}),
    ...(child(line, 'NICK')?.value.trim() ? { nick: child(line, 'NICK')!.value.trim() } : {}),
    ...(child(line, 'TYPE')?.value ? { type: child(line, 'TYPE')!.value.trim().toLowerCase() } : {}),
  };
};

const eventDate = (line: GedcomLine, tag: string): GedcomDate | undefined => {
  for (const event of childrenOf(line, tag)) {
    const date = child(event, 'DATE');
    const parsed = date && parseGedcomDate(date.value);
    if (parsed) return parsed;
  }
  return undefined;
};

const SEX: Record<string, GedcomIndividual['gender']> = { M: 'male', F: 'female', X: 'other', U: 'unknown' };

const readIndividual = (record: GedcomLine): GedcomIndividual => {
  const names = childrenOf(record, 'NAME').map(readName);
  const birthName = names.find((name) => name.type === 'birth') ?? names.find((name) => name.type !== 'married') ?? names[0];
  const married = names.find((name) => name !== birthName && name.type === 'married' && name.surname);
  const marriedSurname = married?.surname ?? child(record, '_MARNM')?.value.replace(/\//g, '').trim();
  const given = birthName?.given ?? [];
  const sex = child(record, 'SEX')?.value.trim().toUpperCase();
  return {
    xref: record.xref!,
    given,
    callName: birthName?.marked ?? birthName?.nick ?? given[0],
    ...(birthName?.surname ? { surname: birthName.surname } : {}),
    ...(marriedSurname && marriedSurname !== birthName?.surname ? { marriedSurname } : {}),
    ...(sex && SEX[sex[0]] ? { gender: SEX[sex[0]] } : {}),
    born: eventDate(record, 'BIRT'),
    died: eventDate(record, 'DEAT'),
    christened: eventDate(record, 'CHR') ?? eventDate(record, 'BAPM'),
    buried: eventDate(record, 'BURI'),
    uids: [...childrenOf(record, '_UID'), ...childrenOf(record, 'UID')].map((line) => line.value.trim()).filter(Boolean),
    childOf: childrenOf(record, 'FAMC').map((line) => ({ family: line.value.trim(), kind: PEDIGREE[child(line, 'PEDI')?.value.trim().toUpperCase() ?? 'BIRTH'] ?? 'blood' })),
    partnerIn: childrenOf(record, 'FAMS').map((line) => line.value.trim()),
  };
};

const readFamily = (record: GedcomLine): GedcomFamily => {
  const marriage = childrenOf(record, 'MARR')[0];
  const marriedOn = marriage && child(marriage, 'DATE') ? parseGedcomDate(child(marriage, 'DATE')!.value)?.date : undefined;
  const divorcedOn = eventDate(record, 'DIV')?.date;
  return {
    xref: record.xref!,
    partners: [...childrenOf(record, 'HUSB'), ...childrenOf(record, 'WIFE')].map((line) => line.value.trim()).filter(Boolean),
    children: childrenOf(record, 'CHIL').map((line) => line.value.trim()).filter(Boolean),
    married: Boolean(marriage),
    ...(marriedOn ? { marriedOn } : {}),
    ...(divorcedOn ? { divorcedOn } : {}),
  };
};

/** The individuals and families of a GEDCOM file, from its bytes. */
export const readGedcom = (bytes: Uint8Array): Gedcom => {
  const records = parseGedcomLines(decodeGedcom(bytes));
  return {
    individuals: records.filter((r) => r.tag === 'INDI' && r.xref).map(readIndividual),
    families: records.filter((r) => r.tag === 'FAM' && r.xref).map(readFamily),
  };
};
