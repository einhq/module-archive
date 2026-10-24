import { assertEquals } from '@std/assert';
import { chapterIndex, chapterLabel, chapterSeek, chapterSegments, nextChapterStart, previousChapterStart, segmentsFit } from '../chapters.ts';

const film = [0, 6.2, 19.48, 41.12, 58.6, 80.04, 101.32, 129.8, 152.44];

Deno.test('a time is in the chapter whose start it has passed', () => {
  assertEquals(chapterIndex(film, 0), 0);
  assertEquals(chapterIndex(film, 6), 0);
  assertEquals(chapterIndex(film, 25), 2);
  assertEquals(chapterIndex(film, 165), 8);
});

Deno.test('a seek that lands a hair before a start still counts as that chapter', () => {
  // Safari reads back a seek to 6.2 as 6.1999 or so.
  assertEquals(chapterIndex(film, 6.199), 1);
  assertEquals(chapterIndex(film, chapterSeek(6.2) - 0.001), 1);
  assertEquals(chapterIndex(film, 6.1), 0);
});

Deno.test('next goes to the following start, and there is none in the last chapter', () => {
  assertEquals(nextChapterStart(film, 0), 6.2);
  assertEquals(nextChapterStart(film, chapterSeek(6.2)), 19.48);
  // Landed a hair short of a start, "next" still moves on rather than finding the same one.
  assertEquals(nextChapterStart(film, 6.19), 19.48);
  assertEquals(nextChapterStart(film, 160), null);
});

Deno.test('previous restarts the chapter, or within its first two seconds goes to the one before', () => {
  assertEquals(previousChapterStart(film, 30), 19.48);
  assertEquals(previousChapterStart(film, 20.5), 6.2);
  assertEquals(previousChapterStart(film, chapterSeek(19.48)), 6.2);
  assertEquals(previousChapterStart(film, 3), 0);
});

Deno.test('the chapters are shares of the timeline, end to end', () => {
  assertEquals(chapterSegments([0, 25, 75], 100), [{ start: 0, end: 0.25 }, { start: 0.25, end: 0.75 }, { start: 0.75, end: 1 }]);
  assertEquals(chapterSegments([0], 100), [{ start: 0, end: 1 }]);
  assertEquals(chapterSegments([0, 5], 0), []);
});

Deno.test('chapters are drawn apart only while each is wide enough on screen', () => {
  assertEquals(segmentsFit(film, 170.5, 342), true);
  // A tape with a chapter every few seconds on a phone: ticks instead.
  const tape = Array.from({ length: 300 }, (_, i) => i * 24);
  assertEquals(segmentsFit(tape, 7200, 342), false);
  assertEquals(segmentsFit([0], 30, 342), true);
  // Before the duration is known there is no timeline to draw them on.
  assertEquals(segmentsFit(film, 0, 342), false);
});

Deno.test('a chapter is named by its place among them', () => {
  assertEquals(chapterLabel(film, 60), 'Chapter 5 of 9');
});
