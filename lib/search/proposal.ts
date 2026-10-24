/**
 * A language model's reading of a search: the people, locations, years, kinds and words it
 * proposes, asked of the command `CFG_LANGUAGE_MODEL` names.
 *
 * One short call with a prompt of its own. The prompt is the same text every time, so a server
 * that caches what it last read (llama.cpp) keeps it and each request reads only the sentence; the
 * answer is a dozen tokens of JSON. That is what makes it fast enough for the search box.
 *
 * The model proposes, the code decides: a person or location it names must be words the user
 * wrote (a translated, corrected or invented name is dropped, and the rules alone read the search
 * then), a year must be a year, and a kind must be one of three. Resolving names to people and
 * locations is `names.ts`'s job.
 */

import type { LanguageModelReply } from '@ein/api';
import type { Command } from '@ein/client';
import { shq } from '@ein/client';

/** What the model is asked to return, before validation. */
type Proposal = {
  people: string[];
  locations: string[];
  from?: string;
  to?: string;
  kinds: ('photo' | 'video' | 'audio')[];
  /** What the pictures should show, beyond who, where and when. */
  text: string;
};

const SYSTEM = `You turn a request to see pictures from a family archive into search filters.
The request may be a sentence or a few words typed into a search box.
Reply with ONE JSON object and nothing else:
{"people":[],"locations":[],"from":null,"to":null,"kinds":[],"text":""}
- people: names of people exactly as written, never translated or corrected. A full name is one entry, middle initials and hyphenated parts included. Never a kin word or a pronoun.
- locations: named locations exactly as written, never translated: cities, countries, buildings, venues, bars. A capitalised name that is not a person's is a location.
- from, to: four-digit years. "från 2019" or "in 2019" is from 2019 to 2019. Otherwise null.
- kinds: "photo" for bilder/foton/photos/pictures, "video" for filmer/videos, "audio" for recordings. Empty when the request does not say.
- text: what the pictures should show besides people, locations and years (a beach, a red sailing boat), in the user's words. Empty when nothing is left.
Do not guess. A description is not a location: beach, kitchen, lake, home, stranden, köket, sjön, hemma, skogen are text.`;

const EXAMPLES: { user: string; json: Record<string, unknown> }[] = [
  {
    user: 'Visa bilder på Anna och Erik på en röd segelbåt i Göteborg 2019',
    json: { people: ['Anna', 'Erik'], locations: ['Göteborg'], from: '2019', to: '2019', kinds: ['photo'], text: 'röd segelbåt' },
  },
  {
    user: 'Show videos from Rome between 2010 and 2012',
    json: { people: [], locations: ['Rome'], from: '2010', to: '2012', kinds: ['video'], text: '' },
  },
  {
    user: 'Maria Lind-Berg Lars K Holm Tanumstrand 2017',
    json: { people: ['Maria Lind-Berg', 'Lars K Holm'], locations: ['Tanumstrand'], from: '2017', to: '2017', kinds: [], text: '' },
  },
  {
    user: 'Kvarnen snö',
    json: { people: [], locations: ['Kvarnen'], from: null, to: null, kinds: [], text: 'snö' },
  },
  {
    user: 'Hitta bilder på Lisa Ek på stranden 2021',
    json: { people: ['Lisa Ek'], locations: [], from: '2021', to: '2021', kinds: ['photo'], text: 'stranden' },
  },
];

type Turn = { role: 'user' | 'assistant'; content: string };

/** The system text and the examples as earlier turns: the same prefix for every request, so the server's cache holds it. */
export const PROPOSAL_PROMPT: { system: string; history: Turn[] } = {
  system: SYSTEM,
  history: EXAMPLES.flatMap((example): Turn[] => [
    { role: 'user', content: example.user },
    { role: 'assistant', content: JSON.stringify(example.json) },
  ]),
};

/** The first balanced `{…}` in a completion, braces inside strings not counting. */
const firstObject = (text: string): string | undefined => {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [];
const year = (value: unknown): string | undefined => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{4}$/.test(text) ? text : undefined;
};

/** True when `name` is words the user wrote, case aside — the model may copy, not correct. */
const writtenIn = (message: string, name: string): boolean => message.toLocaleLowerCase('sv').includes(name.toLocaleLowerCase('sv'));

/**
 * Validate a completion. Undefined when it is not what was asked for, or names something the user
 * did not write — every way it can go wrong has the same answer: the rules alone read the search.
 */
export const readProposal = (message: string, completion: string): Proposal | undefined => {
  const json = firstObject(completion);
  if (!json) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const people = strings(raw.people);
  const locations = strings(raw.locations);
  if ([...people, ...locations].some((name) => !writtenIn(message, name))) return undefined;
  const kinds = strings(raw.kinds).filter((kind): kind is Proposal['kinds'][number] => kind === 'photo' || kind === 'video' || kind === 'audio');
  const from = year(raw.from);
  const to = year(raw.to) ?? from;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 200) : '';
  return { people, locations, ...(from ? { from } : {}), ...(to ? { to } : {}), kinds, text };
};

/**
 * Ask the model, through the command `CFG_LANGUAGE_MODEL` names. Undefined when there is none, it
 * cannot be asked (down, or the asker may not use it), or its answer does not hold up.
 */
export const askForProposal = async (cmd: Command, message: string): Promise<{ request: Proposal; ms: number } | undefined> => {
  const model = cmd.env.CFG_LANGUAGE_MODEL?.trim();
  if (!model) return undefined;
  const started = Date.now();
  const { system, history } = PROPOSAL_PROMPT;
  const ran = await cmd.execute(`JSON_OUTPUT=1 ${model} --system ${shq(system)} --history ${shq(JSON.stringify(history))} --max-tokens 96 --timeout 20 ${shq(message)}`);
  if (ran.code !== 0) return undefined;
  let reply: Partial<LanguageModelReply>;
  try {
    reply = JSON.parse(`${ran.stdout}`);
  } catch {
    return undefined;
  }
  const request = typeof reply.content === 'string' ? readProposal(message, reply.content) : undefined;
  return request ? { request, ms: Date.now() - started } : undefined;
};
