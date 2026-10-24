/**
 * A video's chapters as a node: `metadata/chapters`, one WebVTT cue per chapter from each cut to
 * the next, so `cat` reads it and any player can take it as a chapters track. The cuts themselves,
 * with their scores and what found them, are on the node's attrs; `detect-chapters` writes it.
 */
import { formatVttTime } from '@archive/media/transcript';

/** One cut: its second on the rendition's clock, and how sure the detector was (null for a leader's end). */
export type ChapterBoundary = { t: number; score: number | null; kind: 'cut' | 'leader' };

/** The chapters' WebVTT: one cue per chapter titled "Chapter N", the first from 0, the last to `duration`. */
export const chaptersToVtt = (boundaries: ChapterBoundary[], duration: number): string => {
  const starts = [0, ...boundaries.map((b) => b.t)];
  const cues = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : duration;
    return `chapter-${i + 1}\n${formatVttTime(start)} --> ${formatVttTime(end)}\nChapter ${i + 1}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
};
