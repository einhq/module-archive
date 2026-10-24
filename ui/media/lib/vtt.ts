/**
 * WebVTT parsing for the transcript panel and the video player's subtitles.
 *
 * Both need the cues as data: the panel to highlight the one playing and to seek when one is
 * clicked, the player to draw the one playing over the picture with who says it. One fetch of the
 * transcript serves both (`useTranscriptCues`), and the audio player has no `<video>` for a
 * `<track>` to live on at all.
 *
 * The server's writer is `@archive/media/transcript`. This is a second reader on purpose:
 * importing that into a browser bundle would drag its server-side imports along with it.
 */

import type { MediaSpeaker } from '@archive/media/api';
export type TranscriptCue = {
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  text: string;
};

/** `HH:MM:SS.mmm` or `MM:SS.mmm` to seconds, or null when it is not a timestamp. */
const parseVttTime = (value: string): number | null => {
  // Cue settings (`align:start`, `line:0`) follow the end timestamp on the same line.
  const stamp = value.trim().split(/\s+/)[0];
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(stamp);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000;
};

/** Cues from a WebVTT document, in file order. Malformed blocks are skipped, not thrown on. */
export const parseVtt = (vtt: string): TranscriptCue[] => {
  const cues: TranscriptCue[] = [];
  for (const block of vtt.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines[0] === 'WEBVTT') continue;

    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = lines[timingIndex].split('-->');
    const start = parseVttTime(rawStart);
    const end = parseVttTime(rawEnd);
    if (start === null || end === null) continue;

    // Cue tags go before the entities are decoded: a word-timing tag (`<00:00:12.480>`) or a voice
    // span is markup, while an escaped `&lt;b&gt;` is text someone said.
    const text = lines.slice(timingIndex + 1).join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
};

/** A cue with whoever was talking over it attached. */
type SpokenCue = TranscriptCue & { speaker?: MediaSpeaker };

/**
 * Attach a speaker to each cue by time overlap.
 *
 * Whisper breaks cues on pauses and the diarizer breaks turns on voices, so the two
 * segmentations do not line up and one cue can touch several turns. The voice whose turns
 * cover most of the cue wins, which is the honest answer available here: splitting the line
 * would need per-word timings, and the panel has only the text.
 *
 * The server sends the voices rather than resolved cues on purpose — the words are fetched as
 * WebVTT already, so sending them a second time inside the details response would duplicate an
 * hour of speech to save this loop.
 */
export const attachSpeakers = (cues: TranscriptCue[], speakers: MediaSpeaker[]): SpokenCue[] => {
  if (speakers.length === 0) return cues;
  return cues.map((cue) => {
    let best: { speaker: MediaSpeaker; overlap: number } | undefined;
    for (const speaker of speakers) {
      let overlap = 0;
      for (const [start, end] of speaker.turns) overlap += Math.max(0, Math.min(cue.end, end) - Math.max(cue.start, start));
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { speaker, overlap };
    }
    return best ? { ...cue, speaker: best.speaker } : cue;
  });
};

/**
 * What a speaker is called on screen: the person's name once somebody is named, else "Speaker"
 * and the voice's number. An unnamed person's generated "Unknown …" is not worth showing — what
 * matters is telling one voice from another.
 */
export const speakerLabel = (speaker: MediaSpeaker): string => {
  if (speaker.personName && !speaker.unnamed) return speaker.personName;
  const match = /(\d+)$/.exec(speaker.speaker);
  return `Speaker ${match ? Number(match[1]) + 1 : ''}`.trim();
};

/**
 * A stable colour per speaker within one recording.
 *
 * Index-based rather than hashed from the name: an unnamed person has no name worth hashing,
 * and what the reader needs is only to tell this speaker from that one on the same screen.
 */
export const speakerColor = (speaker: string | undefined): string => {
  // No speaker is not a speaker of its own; grey says "somebody" without inventing a colour
  // that would read as one more person.
  if (speaker === undefined) return 'gray';
  const palette = ['blue', 'grape', 'teal', 'orange', 'cyan', 'pink', 'lime', 'violet'];
  const match = /(\d+)$/.exec(speaker);
  const index = match ? Number(match[1]) : 0;
  return palette[index % palette.length];
};

/**
 * Index of the cue covering `position`, or -1.
 *
 * Binary search because this runs on every animation frame while something is playing, and
 * a linear scan of an hour-long transcript there is a frame budget spent on nothing.
 */
export const activeCueIndex = (cues: TranscriptCue[], position: number): number => {
  let low = 0;
  let high = cues.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= position) {
      // The last cue that has started is the candidate; a gap between cues leaves the
      // previous one highlighted, which reads better than nothing being highlighted.
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
};

/** The cue being said at `position` — `start ≤ position < end` — or undefined in a pause. */
export const cueAt = <T extends TranscriptCue>(cues: T[], position: number): T | undefined => {
  const index = activeCueIndex(cues, position);
  return index >= 0 && position < cues[index].end ? cues[index] : undefined;
};
