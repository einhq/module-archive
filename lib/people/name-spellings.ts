/**
 * Spelling rules for names: how two spellings of one name, `Ericsson` and `Eriksson`, `Thompson`
 * and `Thomson`, come to be read as one. A word is read through every rule in turn, and two words
 * the rules make the same are one name spelled two ways.
 *
 * The rules are files under `SPELLINGS_DIR`, each line `<from> -> <to>`: `from` a regular
 * expression over one word in lower case without accents (`Öberg` is `oberg`), `to` what each
 * match becomes (empty to drop it, `$1` for a group). `#` starts a comment. The archive's own are
 * linked there as `archive/` (its `etc/name-spellings.d/`); an administrator adds a file beside
 * them. Files directly in `SPELLINGS_DIR` are read first, so their rules see a name as written,
 * then the directories' files.
 */
import { type Command, verifyAccess } from '@ein/client';
import { ETC_PATH } from '@ein/paths';
import { toArrayBuffer } from '@std/streams/to-array-buffer';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** Where the rules are. */
const SPELLINGS_DIR = `${ETC_PATH}/name-spellings.d`;

type Rule = { from: RegExp; to: string };

/** A word as the rules spell it. */
export type Speller = (word: string) => string;

/** Every word as it is written: no rules. */
export const asWritten: Speller = (word) => word;

/** The rules of one file, named `file` in what a mistake in it says. */
export const parseSpellings = (text: string, file: string): Rule[] =>
  text.split('\n').flatMap((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return [];
    const arrow = line.indexOf('->');
    const from = arrow < 0 ? '' : line.slice(0, arrow).trim();
    if (!from) throw new Error(`${file}:${i + 1}: a rule is '<from> -> <to>', not '${line}'`);
    try {
      return [{ from: new RegExp(from, 'gu'), to: line.slice(arrow + 2).trim() }];
    } catch (error) {
      throw new Error(`${file}:${i + 1}: '${from}' is not a regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

/** The speller of `rules`, which remembers what it has read. */
export const speller = (rules: Rule[]): Speller => {
  if (rules.length === 0) return asWritten;
  const read = new Map<string, string>();
  return (word) => {
    let spelled = read.get(word);
    if (spelled === undefined) {
      spelled = rules.reduce((text, rule) => text.replace(rule.from, rule.to), word);
      read.set(word, spelled);
    }
    return spelled;
  };
};

const readText = async (vfs: Vfs, access: Access, path: string): Promise<string> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    return new TextDecoder().decode(await toArrayBuffer(handle.readable));
  } finally {
    await handle.close();
  }
};

/** The readable entries of `dir`, in name order: its files, and the rest (directories, links to them). */
const listed = async (vfs: Vfs, access: Access, dir: string): Promise<{ files: string[]; dirs: string[] }> => {
  const entries = (await vfs.children(access, dir).catch(() => []))
    .filter((entry) => !entry.name.startsWith('.') && verifyAccess(access, entry.node.props, 'r'))
    .toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    files: entries.filter((entry) => entry.node.type === 'file').map((entry) => `${dir}/${entry.name}`),
    dirs: entries.filter((entry) => entry.node.type !== 'file').map((entry) => `${dir}/${entry.name}`),
  };
};

/**
 * The speller of every rule under `SPELLINGS_DIR`: the files directly in it, then the files of
 * each directory in it, each in name order. With none there, words are compared as written. A
 * rule that cannot be read stops with where it is.
 */
export async function loadSpeller(vfs: Vfs, access: Access): Promise<Speller> {
  const top = await listed(vfs, access, SPELLINGS_DIR);
  const files = [...top.files];
  for (const dir of top.dirs) files.push(...(await listed(vfs, access, dir)).files);
  const rules: Rule[] = [];
  for (const file of files) rules.push(...parseSpellings(await readText(vfs, access, file), file));
  return speller(rules);
}
