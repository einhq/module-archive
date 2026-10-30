/**
 * The subtitle editor's lines and what can be done to them: retime, add, split, join, remove, and
 * write the result as WebVTT for `file-set-transcript`.
 *
 * Pure, so every edit is tested without a browser. Each function returns a new list, sorted by
 * start, and leaves the one it was given alone.
 */

import type { TranscriptCue } from './vtt.ts';

/** A line being edited. `id` is its identity while the dialog is open: React's key and the focus. */
export type DraftCue = TranscriptCue & { id: number };

/** How long a line added at the playhead lasts, in seconds, when nothing follows it sooner. */
const NEW_CUE_SECONDS = 2;

/** The shortest a line can be made by splitting or retiming, in seconds. */
export const MIN_CUE_SECONDS = 0.1;

const byStart = (a: DraftCue, b: DraftCue): number => a.start - b.start || a.end - b.end || a.id - b.id;

/** The lines a transcript's cues start as, numbered from 1. */
export const draftFrom = (cues: TranscriptCue[]): DraftCue[] => cues.map((cue, index) => ({ start: cue.start, end: cue.end, text: cue.text, id: index + 1 })).sort(byStart);

/** An id no line in `cues` has. */
export const nextId = (cues: DraftCue[]): number => cues.reduce((max, cue) => Math.max(max, cue.id), 0) + 1;

/** A time as the editor shows it: `m:ss.s`, with hours when there are any. */
export const formatCueTime = (seconds: number): string => {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor(tenths / 600) % 60;
  const s = Math.floor(tenths / 10) % 60;
  const clock = `${String(s).padStart(2, '0')}.${tenths % 10}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${clock}` : `${m}:${clock}`;
};

/** A time typed as `s`, `m:ss` or `h:mm:ss`, the seconds with a decimal part or not (`.` or `,`); null when it is none. */
export const parseCueTime = (text: string): number | null => {
  const parts = text.trim().replace(',', '.').split(':');
  if (parts.length > 3 || !/^\d+(?:\.\d{1,3})?$/.test(parts[parts.length - 1]) || parts.slice(0, -1).some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  // Below the first field, minutes and seconds count to 59.
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  return numbers.reduce((total, n) => total * 60 + n, 0);
};

/** `cues` with the line `id` changed by `patch`, in order again. */
export const updateCue = (cues: DraftCue[], id: number, patch: Partial<TranscriptCue>): DraftCue[] =>
  cues.map((cue) => cue.id === id ? { ...cue, ...patch } : cue).sort(byStart);

/**
 * The line `id` starting at `at`. Moved past its own end, it keeps its length: the end moves with it,
 * which is what setting the start of a line timed far too early means.
 */
export const startCueAt = (cues: DraftCue[], id: number, at: number): DraftCue[] => {
  const cue = cues.find((candidate) => candidate.id === id);
  if (!cue) return cues;
  const start = Math.max(0, at);
  return updateCue(cues, id, start < cue.end - MIN_CUE_SECONDS ? { start } : { start, end: start + Math.max(cue.end - cue.start, MIN_CUE_SECONDS) });
};

/** The line `id` ending at `at`. Moved before its own start, it keeps its length: the start moves with it. */
export const endCueAt = (cues: DraftCue[], id: number, at: number): DraftCue[] => {
  const cue = cues.find((candidate) => candidate.id === id);
  if (!cue) return cues;
  if (at > cue.start + MIN_CUE_SECONDS) return updateCue(cues, id, { end: at });
  const end = Math.max(at, MIN_CUE_SECONDS);
  return updateCue(cues, id, { start: Math.max(0, end - Math.max(cue.end - cue.start, MIN_CUE_SECONDS)), end });
};

/** `cues` without the line `id`. */
export const removeCue = (cues: DraftCue[], id: number): DraftCue[] => cues.filter((cue) => cue.id !== id);

/**
 * A new, empty line starting at `at`: two seconds long, or up to the next line when that starts
 * sooner, and never past `duration` (when known). At the very end it ends there and starts earlier.
 */
export const addCueAt = (cues: DraftCue[], at: number, duration: number): { cues: DraftCue[]; id: number } => {
  const known = Number.isFinite(duration) && duration > 0;
  const following = cues.find((cue) => cue.start > at + MIN_CUE_SECONDS);
  let end = Math.min(at + NEW_CUE_SECONDS, following?.start ?? Infinity, known ? duration : Infinity);
  let start = at;
  if (end - start < MIN_CUE_SECONDS) {
    end = known ? Math.min(duration, start + NEW_CUE_SECONDS) : start + NEW_CUE_SECONDS;
    start = Math.max(0, end - NEW_CUE_SECONDS);
  }
  const id = nextId(cues);
  return { cues: [...cues, { id, start, end, text: '' }].sort(byStart), id };
};

/**
 * The line `id` cut in two at `caret`, a position in its text: the words before it stay, those after
 * it start a new line. The time is cut at `at` (the playhead) when that lies inside the line, and in
 * proportion to the caret otherwise. Null when the line is too short to cut.
 */
export const splitCue = (cues: DraftCue[], id: number, caret: number, at: number): { cues: DraftCue[]; id: number } | null => {
  const cue = cues.find((candidate) => candidate.id === id);
  if (!cue) return null;
  const share = cue.text.length > 0 ? Math.min(Math.max(caret, 0), cue.text.length) / cue.text.length : 0.5;
  const inside = at > cue.start + MIN_CUE_SECONDS && at < cue.end - MIN_CUE_SECONDS;
  const cut = inside ? at : cue.start + (cue.end - cue.start) * share;
  if (cut - cue.start < MIN_CUE_SECONDS || cue.end - cut < MIN_CUE_SECONDS) return null;
  const second = nextId(cues);
  const index = Math.min(Math.max(caret, 0), cue.text.length);
  return {
    cues: [
      ...cues.filter((candidate) => candidate.id !== id),
      { ...cue, end: cut, text: cue.text.slice(0, index).trim() },
      { id: second, start: cut, end: cue.end, text: cue.text.slice(index).trim() },
    ].sort(byStart),
    id: second,
  };
};

/** The line `id` and the one after it as one line, from the first's start to the later end. Null for the last line. */
export const joinWithNext = (cues: DraftCue[], id: number): DraftCue[] | null => {
  const index = cues.findIndex((cue) => cue.id === id);
  if (index < 0 || index === cues.length - 1) return null;
  const [cue, next] = [cues[index], cues[index + 1]];
  const joined = { ...cue, end: Math.max(cue.end, next.end), text: [cue.text.trim(), next.text.trim()].filter(Boolean).join(' ') };
  return cues.flatMap((candidate) => candidate.id === next.id ? [] : candidate.id === id ? [joined] : [candidate]);
};

/** What is wrong with a line, if anything: one that ends before it starts cannot be saved; an empty one is left out. */
export const cueProblem = (cue: TranscriptCue): { blocking: boolean; text: string } | null => {
  if (!(cue.end > cue.start)) return { blocking: true, text: 'Ends before it starts' };
  if (!cue.text.trim()) return { blocking: false, text: 'Empty: left out when saved' };
  return null;
};

/** `HH:MM:SS.mmm`, as the transcript's writer has it. */
const vttTime = (seconds: number): string => {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

/**
 * The lines as WebVTT, empty ones left out. A line's text is one line in the file: a line break
 * typed into it becomes a space, since a blank line would end the cue. `<`, `>` and `&` are escaped,
 * and `-->` cannot survive that, so nothing typed can be read back as markup or as a timing.
 */
export const cuesToVtt = (cues: TranscriptCue[]): string => {
  const blocks = cues
    .map((cue) => ({ ...cue, text: cue.text.replace(/\s+/g, ' ').trim() }))
    .filter((cue) => cue.text)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((cue, index) => `${index + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`);
  return `WEBVTT\n\n${blocks.join('\n')}`;
};
