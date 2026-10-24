import { useEffect, useState } from 'react';
import { parseVtt, type TranscriptCue } from '../lib/vtt.ts';

/** How many transcripts are kept parsed: the one open, and the few just stepped past. */
const KEPT = 4;

/** Requests by URL, shared by every component that asks while one is in flight or kept. */
const requests = new Map<string, Promise<TranscriptCue[]>>();

const request = (url: string): Promise<TranscriptCue[]> => {
  const known = requests.get(url);
  if (known) return known;
  const fetched = fetch(url)
    .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`transcript ${response.status}`))))
    .then(parseVtt);
  requests.set(url, fetched);
  // A failure is asked again next time rather than remembered.
  fetched.catch(() => requests.delete(url));
  while (requests.size > KEPT) requests.delete(requests.keys().next().value!);
  return fetched;
};

type TranscriptCues = { cues: TranscriptCue[] | null; failed: boolean };

/**
 * The cues of a WebVTT transcript, or null until they arrive; nothing is fetched while `url` is null.
 *
 * The transcript panel and the video player's subtitles mount together and read the same URL, so
 * the request is shared rather than left to the HTTP cache, which two fetches started at once both
 * miss.
 */
export function useTranscriptCues(url: string | null): TranscriptCues {
  const [state, setState] = useState<TranscriptCues & { url: string | null }>({ url: null, cues: null, failed: false });

  useEffect(() => {
    if (!url) return;
    let live = true;
    request(url).then(
      (cues) => live && setState({ url, cues, failed: false }),
      () => live && setState({ url, cues: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [url]);

  return state.url === url ? state : { cues: null, failed: false };
}
