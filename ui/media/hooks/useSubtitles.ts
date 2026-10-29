import { useCallback, useMemo } from 'react';
import type { MediaSpeaker } from '@archive/media/api';
import { usePersistedState } from '@ein/ui/hooks';
import { attachSpeakers, cueAt } from '../lib/vtt.ts';
import { useTranscriptCues } from './useTranscriptCues.ts';

/** A recording's transcript as the players are told of it: its language and voices. */
export type PlayerTranscript = { language?: string; speakers: MediaSpeaker[] };

/**
 * What the subtitle button and the native track call the transcript's language.
 *
 * Whisper reports an ISO-639-1 code; `Intl.DisplayNames` turns it into the viewer's own word for
 * that language. It throws on a code it does not know, so the code itself is the fallback.
 */
export function transcriptLabel(language?: string): string {
  if (!language) return 'Transcript';
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

/**
 * The subtitles of the lightbox's video and audio players: whether they show, the line at
 * `position`, and the switch. On until the viewer turns them off, which is remembered for both
 * players. `on` is false without a transcript, and nothing is fetched while it is.
 */
export function useSubtitles(transcript: PlayerTranscript | undefined, transcriptUrl: string, position: number) {
  const [preference, setPreference] = usePersistedState<'on' | 'off'>('player.subtitles', 'on');
  const on = transcript !== undefined && preference === 'on';
  const toggle = useCallback(() => setPreference(preference === 'on' ? 'off' : 'on'), [setPreference, preference]);
  const { cues } = useTranscriptCues(on ? transcriptUrl : null);
  const speakers = transcript?.speakers;
  const spoken = useMemo(() => (cues ? attachSpeakers(cues, speakers ?? []) : null), [cues, speakers]);
  const cue = spoken ? cueAt(spoken, position) : undefined;
  // One voice needs no name on every line.
  const namedVoices = (speakers?.length ?? 0) >= 2;
  return { on, toggle, setPreference, cue, namedVoices };
}
