import { signal } from '@preact/signals-react';
import { mediaItemFrom } from '@ein/ui/lib';

/** Where one voice speaks in a recording: its longest turn. `key` names it (its speaker node). */
export type Clip = { key: string; filePath?: string; start: number; end: number; mimetype?: string };

/** The clip playing now, by key, or null: one plays at a time, wherever on the page it was started. */
export const playingClip = signal<string | null>(null);

let audio: HTMLAudioElement | null = null;

const element = (): HTMLAudioElement => {
  if (audio) return audio;
  const created = audio = new Audio();
  // Starting another clip stops this one; by the time its pause arrives the next is playing.
  const stopped = () => {
    if (created.paused) playingClip.value = null;
  };
  created.addEventListener('pause', stopped);
  created.addEventListener('ended', stopped);
  return created;
};

/**
 * Play a clip, or stop it when it is the one playing. The recording's rendition — an `<audio>` plays
 * a video's sound too — with a media fragment (`#t=start,end`), at whose end the browser stops by
 * itself.
 */
export function toggleClip(clip: Clip): void {
  if (!clip.filePath) return;
  const player = element();
  if (playingClip.value === clip.key) {
    player.pause();
    return;
  }
  const url = mediaItemFrom({ path: clip.filePath, mimetype: clip.mimetype ?? 'audio/mpeg' }).fullUrl;
  player.src = `${url}#t=${clip.start},${clip.end}`;
  playingClip.value = clip.key;
  player.play().catch(() => {
    if (playingClip.value === clip.key) playingClip.value = null;
  });
}

/** Stop whatever is playing: a view that started clips calls it as it goes. */
export function stopClip(): void {
  audio?.pause();
}
