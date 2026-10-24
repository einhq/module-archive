/**
 * Pure-unit tests for transcript composition. Fast tier: no VFS, no models.
 *
 * These rules decide what a player cues from and what search matches against, and both
 * failures are quiet ones — a malformed cue simply does not render, and an oversized chunk
 * is truncated by the encoder rather than rejected.
 */

import { assertEquals } from '@std/assert';
import {
  CHUNK_TARGET_SECONDS,
  chunkNodeName,
  chunkSegments,
  formatVttTime,
  MAX_CHUNKS,
  parseVtt,
  parseVttTime,
  resolveChunkPath,
  segmentsToVtt,
  type TranscriptSegment,
  transcriptText,
} from '../../lib/media/transcript.ts';

const seg = (start: number, end: number, text: string): TranscriptSegment => ({ start, end, text });

Deno.test('vtt time always carries the hours field', () => {
  assertEquals(formatVttTime(0), '00:00:00.000');
  assertEquals(formatVttTime(1.5), '00:00:01.500');
  assertEquals(formatVttTime(83.25), '00:01:23.250');
});

Deno.test('vtt time crosses the hour boundary', () => {
  assertEquals(formatVttTime(3600), '01:00:00.000');
  assertEquals(formatVttTime(3661.007), '01:01:01.007');
});

Deno.test('a negative start clamps rather than emitting a broken cue', () => {
  assertEquals(formatVttTime(-1), '00:00:00.000');
});

Deno.test('vtt carries the header, numbered cues and timings', () => {
  const vtt = segmentsToVtt([seg(0, 2.5, 'hej'), seg(2.5, 5, 'hur mar du')]);
  assertEquals(
    vtt,
    'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nhej\n\n2\n00:00:02.500 --> 00:00:05.000\nhur mar du\n',
  );
});

Deno.test('cue text is escaped so a spoken angle bracket cannot open a cue tag', () => {
  // Unescaped, '<' starts a WebVTT cue tag and swallows the rest of the line.
  const vtt = segmentsToVtt([seg(0, 1, 'a < b & c > d')]);
  assertEquals(vtt.includes('a &lt; b &amp; c &gt; d'), true);
});

Deno.test('no segments still produces a valid vtt file', () => {
  // A silent clip must yield a file a player accepts, not an empty one it errors on.
  assertEquals(segmentsToVtt([]), 'WEBVTT\n\n');
});

Deno.test('segments inside the window become one chunk', () => {
  const chunks = chunkSegments([seg(0, 5, 'one'), seg(5, 10, 'two'), seg(10, 15, 'three')]);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0], { start: 0, end: 15, text: 'one two three' });
});

Deno.test('a chunk breaks before it would exceed the encoder window', () => {
  const segments = Array.from({ length: 10 }, (_, i) => seg(i * 8, (i + 1) * 8, `s${i}`));
  const chunks = chunkSegments(segments);
  for (const chunk of chunks) {
    assertEquals(chunk.end - chunk.start <= CHUNK_TARGET_SECONDS + 8, true, `chunk ${chunk.start}-${chunk.end} too long`);
  }
  // Boundaries are segment boundaries, so no word is split across two vectors.
  assertEquals(chunks[0].start, 0);
  assertEquals(chunks.map((c) => c.text).join(' ').split(' ').length, 10);
});

Deno.test('a silence the vad removed ends a chunk', () => {
  // Without a span-based break these join, and a search hit seeks to the wrong side of a
  // ten-minute gap.
  const chunks = chunkSegments([seg(0, 3, 'before'), seg(600, 603, 'after')]);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[1].start, 600);
});

Deno.test('a single segment longer than the window is its own chunk', () => {
  const chunks = chunkSegments([seg(0, 90, 'one very long unbroken take')]);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].start, 0);
});

Deno.test('overlapping segments in one second give one chunk, not two of the same name', () => {
  // A short segment, then a long one starting inside the same second: the long one breaks the
  // window, and on its own would open a second chunk named t361.
  const chunks = chunkSegments([seg(361.2, 361.9, 'ja'), seg(361.5, 420, 'och sen spelade vi'), seg(420, 425, 'slut')]);
  assertEquals(chunks.map((chunk) => chunk.start), [361, 420]);
  assertEquals(chunks[0].text, 'ja och sen spelade vi');
  assertEquals(chunks[0].end, 420);
});

Deno.test('a very long recording widens rather than losing its tail', () => {
  // Eleven hours at the target size would be ~670 chunks; push well past the ceiling.
  const segments = Array.from({ length: 8000 }, (_, i) => seg(i * 5, (i + 1) * 5, `w${i}`));
  assertEquals(8000 * 5 / CHUNK_TARGET_SECONDS > MAX_CHUNKS, true);
  const chunks = chunkSegments(segments);
  assertEquals(chunks.length <= MAX_CHUNKS, true, `got ${chunks.length}`);
  // The end of the recording is still covered — that is the failure this exists to avoid.
  assertEquals(chunks[chunks.length - 1].end >= 8000 * 5 - 10, true);
});

Deno.test('empty segments are dropped rather than embedded', () => {
  const chunks = chunkSegments([seg(0, 2, '  '), seg(2, 4, 'real')]);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].text, 'real');
});

Deno.test('a silent file produces no chunks at all', () => {
  assertEquals(chunkSegments([]), []);
});

Deno.test('a chunk node name is its start second', () => {
  assertEquals(chunkNodeName({ start: 31, end: 60, text: 'x' }), 't31');
});

Deno.test('transcript text joins segments and trims', () => {
  assertEquals(transcriptText([seg(0, 1, ' hej '), seg(1, 2, 'da')]), 'hej da');
});

Deno.test('vtt round-trips through the parser', () => {
  // The one test that keeps the writer and the reader of the format honest with each other.
  const segments = [seg(0, 2.5, 'hej'), seg(2.5, 5, 'hur mar du'), seg(3600, 3661.007, 'an hour in')];
  assertEquals(parseVtt(segmentsToVtt(segments)), segments);
});

Deno.test('escaped cue text survives the round trip', () => {
  const segments = [seg(0, 1, 'a < b & c > d')];
  assertEquals(parseVtt(segmentsToVtt(segments)), segments);
});

Deno.test('an empty transcript parses to no segments', () => {
  assertEquals(parseVtt(segmentsToVtt([])), []);
  assertEquals(parseVtt(''), []);
});

Deno.test('vtt timestamps parse with and without the hours field', () => {
  assertEquals(parseVttTime('00:00:02.500'), 2.5);
  assertEquals(parseVttTime('01:01:01.007'), 3661.007);
  // A player writing MM:SS is still valid WebVTT.
  assertEquals(parseVttTime('01:23.250'), 83.25);
  // Cue settings ride on the end timestamp's line.
  assertEquals(parseVttTime('00:00:05.000 align:start'), 5);
  assertEquals(parseVttTime('not a time'), null);
});

Deno.test('a chunk embedding path resolves to its file and its moment', () => {
  assertEquals(
    resolveChunkPath('/archive/albums/sommar/files/IMG_1.mp4/metadata/transcript/text_jina5s/t2400'),
    { path: '/archive/albums/sommar/files/IMG_1.mp4', atSeconds: 2400 },
  );
  assertEquals(
    resolveChunkPath('/a/b.mp3/metadata/transcript/text_jina5s/t0'),
    { path: '/a/b.mp3', atSeconds: 0 },
  );
});

Deno.test('other embedding layouts are left for the caller to strip', () => {
  // These must fall through, not be mistaken for chunks — a caption is not a moment.
  assertEquals(resolveChunkPath('/a/b.jpg/metadata/content/text_jina5s'), null);
  assertEquals(resolveChunkPath('/a/b.pdf/metadata/content/text_jina5s'), null);
  // MiniLM's chunk sets are not read.
  assertEquals(resolveChunkPath('/a/b.mp3/metadata/transcript/chunks/t0'), null);
  assertEquals(resolveChunkPath('/a/b.jpg/fingerprints/description'), null);
  // The transcript node itself is not a chunk.
  assertEquals(resolveChunkPath('/a/b.mp4/metadata/transcript'), null);
  // A name that is not a timecode.
  assertEquals(resolveChunkPath('/a/b.mp4/metadata/transcript/chunks/embedding'), null);
});

Deno.test('word timings survive the vtt round trip', () => {
  const segments: TranscriptSegment[] = [{
    start: 1,
    end: 3,
    text: 'hej du där',
    words: [
      { start: 1.0, end: 1.5, word: 'hej' },
      { start: 1.5, end: 2.2, word: 'du' },
      { start: 2.2, end: 3.0, word: 'där' },
    ],
  }];
  const parsed = parseVtt(segmentsToVtt(segments));
  assertEquals(parsed[0].text, 'hej du där');
  assertEquals(parsed[0].words?.map((w) => w.word), ['hej', 'du', 'där']);
  assertEquals(parsed[0].words?.map((w) => w.start), [1.0, 1.5, 2.2]);
  // Each word ends where the next starts; the last ends with the cue.
  assertEquals(parsed[0].words?.map((w) => w.end), [1.5, 2.2, 3.0]);
});

Deno.test('a cue that someone actually said in angle brackets is not read as a timestamp', () => {
  const segments: TranscriptSegment[] = [{ start: 0, end: 2, text: 'säg <00:00:01.000> högt' }];
  const parsed = parseVtt(segmentsToVtt(segments));
  assertEquals(parsed[0].text, 'säg <00:00:01.000> högt');
  assertEquals(parsed[0].words, undefined);
});
