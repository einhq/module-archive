/**
 * Composition rules for a timed transcript.
 *
 * EMS returns raw whisper output — segments with a start, an end and some text — and media
 * decides what a *transcript* is: the WebVTT a player can cue from, and the chunks that get
 * embedded so search can find the moment something was said.
 *
 * Kept pure because this is the part most likely to drift: the text it produces is what search
 * matches against and what the UI shows.
 */

import type { TranscriptSegment, TranscriptWord } from '@ems/client';
import type { TextChunk } from '@ems/text-embedding';

export type { TranscriptSegment };

/** A group of consecutive segments, embedded as one vector. */
type TranscriptChunk = {
  /** Seconds from the start of the audio, rounded down — this is a seek target. */
  start: number;
  end: number;
  text: string;
};

/**
 * How much speech goes into one embedded chunk: about a minute.
 *
 * A minute is ~150 words, inside the 100-300-word passages dense retrievers do best on, still
 * one topic, and a hit still seeks to within a minute of the moment. Not measured on the archive.
 * The length a set was cut at is stamped on it (`chunkSeconds`), so a change here re-chunks every
 * transcript at the next `media-reembed`.
 */
export const CHUNK_TARGET_SECONDS = 60;

/**
 * Ceiling on chunks per file.
 *
 * The text embedding type is shared with every other text in the archive: pictures' words,
 * documents, descriptions. One seven-hour recording at the target size would add ~420 vectors on
 * its own; a handful of them would measurably change what the pool is mostly made of. Past this
 * the window widens instead, so a very long file is coarser rather than louder.
 */
export const MAX_CHUNKS = 400;

/** Seconds as `HH:MM:SS.mmm`. WebVTT tolerates a missing hours field; players vary, so always emit it. */
export const formatVttTime = (seconds: number): string => {
  const clamped = Math.max(0, seconds);
  const ms = Math.round(clamped * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const rest = ms % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rest, 3)}`;
};

/**
 * WebVTT for the `<track>` element and the transcript panel.
 *
 * Cue text is escaped: WebVTT reads `<` as the start of a cue tag, so an unescaped
 * transcript of someone saying "less than" would swallow the rest of the line. `-->` is
 * the cue-timing separator and cannot appear in text either.
 */
const escapeCueText = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const segmentsToVtt = (segments: TranscriptSegment[]): string => {
  const cues = segments.map((segment, index) => {
    // Word timings, when whisper produced them, ride along as WebVTT timestamp tags
    // (`<00:00:12.480>word`). That is the format's own way of timing inside a cue — players
    // use it for karaoke-style highlighting and render the words either way — so the
    // subtitle file stays one artifact instead of growing a parallel JSON that could drift
    // from the cues it describes.
    const body = segment.words?.length
      ? segment.words
        .map((word) => `${formatVttTime(word.start)}>${escapeCueText(word.word.trim())}`)
        .map((piece) => `<${piece}`)
        .join(' ')
      : escapeCueText(segment.text).trim();
    return `${index + 1}\n${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}\n${body}\n`;
  });
  return `WEBVTT\n\n${cues.join('\n')}`;
};

/**
 * Group segments into windows of about CHUNK_TARGET_SECONDS, breaking only on segment
 * boundaries so a chunk never starts or ends mid-sentence.
 *
 * Past MAX_CHUNKS the target widens and the whole thing is regrouped, rather than the tail
 * being dropped — losing the end of a long recording silently is worse than embedding all
 * of it coarsely.
 */
export const chunkSegments = (segments: TranscriptSegment[]): TranscriptChunk[] => {
  const usable = segments.filter((segment) => segment.text.trim().length > 0);
  if (usable.length === 0) return [];

  const group = (targetSeconds: number): TranscriptChunk[] => {
    const chunks: TranscriptChunk[] = [];
    let current: TranscriptSegment[] = [];

    const flush = () => {
      if (current.length === 0) return;
      const start = Math.max(0, Math.floor(current[0].start));
      const end = Math.ceil(current[current.length - 1].end);
      const text = current.map((segment) => segment.text.trim()).join(' ');
      current = [];
      // A chunk is named by its start second, so two may not share one. Whisper writes
      // overlapping segments now and then — a short one at 361.2 s, a long one from 361.5 s —
      // and the long one would open a chunk of its own in the same second. It joins the chunk
      // before it instead, which keeps the seek target and loses no text.
      const last = chunks.at(-1);
      if (last && start <= last.start) {
        last.end = Math.max(last.end, end);
        last.text = `${last.text} ${text}`;
        return;
      }
      chunks.push({ start, end, text });
    };

    for (const segment of usable) {
      // Break *before* going over rather than after, so a chunk is never longer than the
      // target. The one case that still overshoots is a single segment longer
      // than the target: there is no boundary inside it to break on, and splitting mid
      // sentence would cost more than the overshoot does.
      //
      // The span is measured from the chunk's start, not summed over the segments, so a
      // silence the VAD removed still ends a chunk. One chunk covering a ten-minute gap
      // would answer a search with a seek to the wrong side of it.
      if (current.length > 0 && segment.end - current[0].start > targetSeconds) flush();
      current.push(segment);
    }
    flush();
    return chunks;
  };

  const chunks = group(CHUNK_TARGET_SECONDS);
  if (chunks.length <= MAX_CHUNKS) return chunks;

  // Over the ceiling: widen the window and regroup, rather than truncate. Losing the end
  // of a long recording silently is the worse failure. Slack of 10% absorbs the rounding at
  // segment boundaries; the slice is a
  // backstop for the case where segments are so long that even the widened target cannot
  // group them further.
  const total = usable[usable.length - 1].end - usable[0].start;
  const widened = Math.ceil((total / MAX_CHUNKS) * 1.1);
  return group(widened).slice(0, MAX_CHUNKS);
};

/** Every segment's text, joined — the transcript as one string. */
export const transcriptText = (segments: TranscriptSegment[]): string => segments.map((segment) => segment.text.trim()).filter(Boolean).join(' ');

/**
 * Name of the embedding node for a chunk, which is its start second.
 *
 * `search-media` resolves a vector hit to a node *path* and nothing else, so putting the
 * timecode in the name is what lets a hit carry its own seek target — no attr read, no
 * second query. `t` prefixes it because a node name that is bare digits reads like an
 * index, and this is a time.
 */
export const chunkNodeName = (chunk: TranscriptChunk): string => `t${chunk.start}`;

/**
 * Read segments back out of a WebVTT file.
 *
 * The inverse of `segmentsToVtt`, and needed because the transcript node is the only place
 * the timings are kept: a command that finds a transcript already written has to be able to
 * report what it says without re-running whisper to find out.
 *
 * The UI carries its own parser rather than importing this one. That is deliberate — this
 * module reaches into @ems/client and @ein/client, and pulling it into a browser
 * bundle to save twenty lines would couple the UI to the media area's server-side
 * dependencies. `segmentsToVtt` and this are round-trip tested, which is what keeps the two
 * readings of the format from drifting.
 */
export const parseVtt = (vtt: string): TranscriptSegment[] => {
  const segments: TranscriptSegment[] = [];
  // Blank-line separated blocks, tolerant of CRLF from anything that rewrote the file.
  for (const block of vtt.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines[0] === 'WEBVTT') continue;

    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = lines[timingIndex].split('-->').map((part) => part.trim());
    const start = parseVttTime(rawStart);
    const end = parseVttTime(rawEnd);
    if (start === null || end === null) continue;

    const body = lines.slice(timingIndex + 1).join(' ');

    // Timestamp tags are read back into `words` and taken out of the text, so a caller that
    // only wants the sentence never has to know they were there. Escaping is undone after
    // the tags are recognised, or an escaped `&lt;00:00:01.000&gt;` in someone's speech
    // would be mistaken for one.
    const words: TranscriptWord[] = [];
    for (const match of body.matchAll(/<(\d{1,2}:\d{2}:\d{2}\.\d{1,3})>([^<]*)/g)) {
      const at = parseVttTime(match[1]);
      const word = unescapeCueText(match[2]).trim();
      if (at !== null && word) words.push({ start: at, end: at, word });
    }
    // Each word ends where the next begins; the last one ends with the cue. Only the starts
    // are written, since that is all a split needs and it keeps the file half the size.
    for (let i = 0; i < words.length; i++) words[i].end = words[i + 1]?.start ?? end;

    // Words are already unescaped above; only the raw body still needs it, or an escape
    // sequence someone actually said would be decoded twice.
    const text = (words.length ? words.map((w) => w.word).join(' ') : unescapeCueText(body)).trim();
    if (text) segments.push({ start, end, text, ...(words.length ? { words } : {}) });
  }
  return segments;
};

const unescapeCueText = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** `HH:MM:SS.mmm` or `MM:SS.mmm` to seconds, or null when it is not a timestamp. */
export const parseVttTime = (value: string): number | null => {
  // Cue settings (`align:start`) follow the end timestamp on the same line.
  const stamp = value.split(/\s+/)[0];
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(stamp);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000;
};

/**
 * The chunks as vectors, each named and timed by its start second, so a hit seeks to the right
 * moment. Stored under `metadata/transcript/<type>/` (`@ems/text-embedding`).
 *
 * Each vector node also carries its chunk's `text`: the words themselves, which `search-media`
 * matches a phrase against (archive's `spoken_text` index), since a name said once in a minute
 * of speech barely moves the vector.
 */
export const chunkVectors = (chunks: TranscriptChunk[]): TextChunk[] =>
  chunks.map((chunk) => ({ name: chunkNodeName(chunk), text: chunk.text, attrs: { startSeconds: chunk.start, endSeconds: chunk.end, text: chunk.text } }));

/**
 * The file a transcript-chunk embedding belongs to, and where inside it the chunk starts.
 *
 * Null for any other embedding path, so a caller can try this first and fall through to the
 * ordinary description/content layouts. `search-media` resolves a vector hit to a node path
 * and nothing more, which is why the timecode has to be legible from the path itself —
 * reading an attr per hit would put a node read back on the search path that the batched
 * `resolveIdPaths` exists to keep off it.
 */
export const resolveChunkPath = (embeddingPath: string): { path: string; atSeconds: number } | null => {
  // `<type>/` is the set `chunkVectors` made, named after the embedding type.
  const match = /^(.*)\/metadata\/transcript\/[a-z]+_[a-z0-9]+\/t(\d+)$/.exec(embeddingPath);
  if (!match || !match[1]) return null;
  return { path: match[1], atSeconds: Number(match[2]) };
};
