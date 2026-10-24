/**
 * The derivative sizes, `config/sizes.yaml`: what `generate-derivatives` makes, and the name of
 * the rendition the lightbox plays, which a video's storyboard and its chapters are made from.
 */
import type { Command } from '@ein/client';
import { MOD_PATH } from '@ein/paths';
import { toText } from '@std/streams/to-text';
import { parse } from '@std/yaml';

export type ImageSize = { width: number; height: number; mode?: string; quality?: number };
export type VideoSize = {
  width: number;
  height: number;
  crf?: number;
  preset?: string | number;
  'audio-bitrate'?: string;
  /** Seek offset in seconds; set on a clipped rendition (the hover preview). */
  start?: number;
  /** Clip length in seconds. Absent means the whole video. */
  seconds?: number;
  /** Drop the audio stream — a grid preview always plays muted. */
  mute?: boolean;
};
export type AudioSize = { bitrate?: string; 'sample-rate'?: number };
type StoryboardSize = { tile?: number; columns?: number; 'max-tiles'?: number; 'min-interval'?: number; quality?: number };
export type SizesConfig = {
  image?: Record<string, ImageSize>;
  video?: Record<string, VideoSize>;
  audio?: Record<string, AudioSize>;
  storyboard?: StoryboardSize;
};

/**
 * sizes.yaml, read off the VFS rather than through `cat`: the bins that read it run once per file
 * in a crawl, and a shell round trip per file bought nothing.
 */
export const readSizes = async (cmd: Command): Promise<SizesConfig> => {
  const path = `${cmd.env.MOD_PATH || MOD_PATH}/archive/config/sizes.yaml`;
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
  try {
    return parse(await toText(handle.readable)) as SizesConfig;
  } finally {
    await handle.close();
  }
};

/** The rendition the lightbox plays, `thumbnails/<width>x<height>.mp4` of the `1080p` size, by its file name. */
export const playbackRendition = (sizes: SizesConfig): string | undefined => {
  const size = sizes.video?.['1080p'];
  return size ? `${size.width}x${size.height}.mp4` : undefined;
};
