/**
 * The voices of a recording: one node per speaker, under `<file>/metadata/transcript/speakers/`.
 *
 * A speaker is what a person is to a recording — the voice analog of a face region. It holds
 * one voiceprint for all of that voice (EMS pools the turns' voiceprints, weighted by length),
 * the turns it spoke as data (`[[start, end], …]`), how long it spoke, and the person fields
 * every identity tool already speaks: `personId`, `personSource`, `personConfidence`,
 * `assignLocked`. Turns are not nodes: a tape side has a thousand of them and nothing names a
 * turn — what a person names is a voice (ein/core#516).
 *
 * Turns EMS could attribute to no voice stay on the `speakers` directory as `unattributed`, so
 * the timeline of who spoke when is complete without inventing a speaker for them.
 */

import type { VoiceSpeaker } from '@ems/client';

export const SPEAKERS_DIR = 'speakers';
export const VOICE_EMBEDDING_TYPE = 'voice';

/** A turn: seconds into the recording. */
export type Span = [number, number];

/** The attrs of a speaker node. */
export type SpeakerAttrs = {
  embeddingType: typeof VOICE_EMBEDDING_TYPE;
  capacity: number;
  fileId: string;
  detectedAt: string;
  detectedBy: string;
  /** EMS's file-wide label (`speaker_0`, … by first appearance), meaningful within this file only. */
  speaker: string;
  turns: Span[];
  talkSeconds: number;
  turnCount: number;
  /**
   * The face seen speaking with this voice, on a video: the region of the video's own faces it is
   * (@archive/media/speaker-faces), the person it was recognised as among all the archive's faces,
   * and how surely its lips moved with the voice.
   */
  asdRegionId: string | null;
  asdPersonId: string | null;
  asdScore: number | null;
  personId: string | null;
  personSource: string | null;
  personConfidence: number | null;
  personAssignedAt: string | null;
  assignLocked: boolean;
};

/** Where a recording's speakers live. */
export const speakersPathOf = (filePath: string): string => `${filePath}/metadata/transcript/${SPEAKERS_DIR}`;

/** A speaker's node name: `s0`, `s1`, … in the order the voices are first heard. */
export const speakerNodeName = (index: number): string => `s${index}`;

/** The recording a speaker node belongs to, from its path; undefined for any other path. */
export const fileOfSpeaker = (speakerPath: string): string | undefined => /^(.*)\/metadata\/transcript\/speakers\/[^/]+$/.exec(speakerPath)?.[1];

/** Seconds two sets of turns have in common. */
const overlapSeconds = (a: Span[], b: Span[]): number => {
  let total = 0;
  for (const [as, ae] of a) {
    for (const [bs, be] of b) total += Math.max(0, Math.min(ae, be) - Math.max(as, bs));
  }
  return total;
};

/** The longest of a speaker's turns: the one to play as a sample of the voice. */
export const longestTurn = (turns: Span[]): Span | undefined =>
  turns.reduce<Span | undefined>((best, turn) => (!best || turn[1] - turn[0] > best[1] - best[0] ? turn : best), undefined);

/** What a person decided about a voice, which a new voiceprint run must not lose. */
export type HeldAssignment = {
  turns: Span[];
  personId: string | null;
  personSource: string | null;
  personConfidence: number | null;
  personAssignedAt: string | null;
  assignLocked: boolean;
};

/** Whether an earlier node's assignment was a person's, and so outlives a re-run. */
export const isHeld = (attrs: { personSource?: unknown; assignLocked?: unknown }): boolean => attrs.personSource === 'manual' || attrs.assignLocked === true;

/**
 * The person fields each new speaker inherits from what a person decided before.
 *
 * Re-running the voiceprint moves the turns and renumbers the voices, so a held assignment
 * follows its voice by time: each goes to the new speaker it shares the most speech with.
 * Where two held assignments land on one speaker, the one with more overlap wins.
 */
export const carryOver = (held: HeldAssignment[], next: VoiceSpeaker[]): Map<string, HeldAssignment> => {
  const out = new Map<string, { held: HeldAssignment; overlap: number }>();
  for (const assignment of held) {
    let best: { id: string; overlap: number } | undefined;
    for (const speaker of next) {
      const overlap = overlapSeconds(assignment.turns, speaker.turns);
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: speaker.id, overlap };
    }
    if (!best) continue;
    const taken = out.get(best.id);
    if (!taken || taken.overlap < best.overlap) out.set(best.id, { held: assignment, overlap: best.overlap });
  }
  return new Map([...out].map(([id, { held }]) => [id, held]));
};
