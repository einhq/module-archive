import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand, onOutsideEdit } from '@ein/ui/signals';
import { fileUrl, shq } from '@ein/ui/lib';
import { forgetTranscript } from './useTranscriptCues.ts';
import type { CommentEntry } from '@ein/api';
import type { MediaDetails } from '@archive/media/api';
export type {
  AlbumRef,
  DeviceRef,
  FaceBox,
  FingerprintRef,
  LocationRef,
  MediaDetails,
  MediaExif,
  MediaFace,
  MediaHashes,
  MediaPosition,
  MediaStackDetails,
  NodeRef,
  OwnerRef,
  PersonTag,
  StackMemberRef,
  UnknownFace,
} from '@archive/media/api';

export type { CommentEntry };

/** What the lightbox's orientation buttons ask for. */
export type OrientationChange = { rotate: 'cw' | 'ccw' | '180' } | { mirror: 'toggle' };

export type UseMediaDetailsResult = {
  /** Kept while the next file's details load, so panels do not blank between files. */
  details: MediaDetails | null;
  /** The path `details` was read for, which trails `path` until the new read returns. */
  detailsPath: string | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  addComment: (text: string) => Promise<void>;
  removeComment: (slug: string) => Promise<void>;
  /** Writes the hand-written description. Empty text clears it. */
  setDescription: (text: string) => Promise<void>;
  /** Rewrites the file's stored orientation and refetches. Slow: it regenerates renditions. */
  setOrientation: (change: OrientationChange) => Promise<void>;
  orienting: boolean;
  /** Sets the language of a picture's text (ISO 639-1, or `auto`); the picture is read again on the media pool. */
  setTextLanguage: (language: string) => Promise<void>;
  /** Writes the text in a picture by hand (`file-set-text`); empty removes it. */
  setText: (text: string) => Promise<void>;
  /** Write a video's or a recording's transcript by hand, as WebVTT. */
  setTranscript: (vtt: string) => Promise<void>;
  /** The full exiftool dump, fetched on demand — it is far larger than everything else. */
  rawExif: Record<string, unknown> | null;
  loadRawExif: () => Promise<void>;
  rawExifLoading: boolean;
};

// Comment bodies, descriptions and a picture's text are arbitrary multi-line
// text going into a shell command string, so they travel base64-encoded
// (`comment add --body-base64`, `file-set-description --text-base64`,
// `file-set-text --text-base64`).
function encodeBody(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const detailsArgs = (path: string, albumPath?: string) => `${shq(path)}${albumPath ? ` --album ${shq(albumPath)}` : ''}`;

/**
 * The `media-details` answers the lightbox has read, ahead (`prefetchMediaDetails`, beside the
 * neighbours' pictures) or on the way, so a step onto one shows its details with the picture
 * instead of a beat after it. A change made through the hook empties it — naming a face renames
 * that person on other files too — and so does closing the lightbox (`forgetMediaDetails`).
 */
const DETAILS_CACHE_SIZE = 32;
const detailsCache = new Map<string, MediaDetails>();
const detailsReads = new Map<string, Promise<MediaDetails>>();
const detailsKey = (path: string, albumPath?: string) => `${albumPath ?? ''}\n${path}`;

export function forgetMediaDetails(): void {
  detailsCache.clear();
  // A read already on its way may predate the change; it is still answered, but not kept.
  detailsReads.clear();
}

/** One read of a file's details, shared with one already on its way unless `fresh`. */
function readDetails(path: string, albumPath: string | undefined, fresh: boolean): Promise<MediaDetails> {
  const key = detailsKey(path, albumPath);
  const pending = detailsReads.get(key);
  if (pending && !fresh) return pending;
  const read = execCommand<MediaDetails>(`media-details ${detailsArgs(path, albumPath)}`).then((details) => {
    if (detailsReads.get(key) === read) {
      detailsCache.delete(key);
      detailsCache.set(key, details);
      if (detailsCache.size > DETAILS_CACHE_SIZE) detailsCache.delete(detailsCache.keys().next().value!);
    }
    return details;
  }).finally(() => {
    if (detailsReads.get(key) === read) detailsReads.delete(key);
  });
  detailsReads.set(key, read);
  return read;
}

/** A file's details if they have been read, for showing it before the lightbox steps onto it. */
export function peekMediaDetails(path: string, albumPath?: string): MediaDetails | null {
  return detailsCache.get(detailsKey(path, albumPath)) ?? null;
}

/** Reads a file's details ahead of the lightbox stepping onto it; one read or on its way is left be. */
export function prefetchMediaDetails(path: string, albumPath?: string): void {
  const key = detailsKey(path, albumPath);
  if (detailsCache.has(key) || detailsReads.has(key)) return;
  void readDetails(path, albumPath, false).catch(() => {});
}

/**
 * Everything the lightbox sidebar shows for one media file, in one round-trip
 * (`media-details`). Responses for a previously-viewed file are dropped, so
 * arrowing through an album never shows another image's data.
 */
export function useMediaDetails(path: string | undefined, albumPath?: string): UseMediaDetailsResult {
  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [detailsPath, setDetailsPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [orienting, setOrienting] = useState(false);
  const [rawExif, setRawExif] = useState<Record<string, unknown> | null>(null);
  const [rawExifLoading, setRawExifLoading] = useState(false);
  const generationRef = useRef(0);

  // `reuse` is a step onto the file, which may take what is cached or on its way; everything else
  // follows a change and reads afresh.
  const fetchDetails = useCallback(async ({ reuse = false }: { reuse?: boolean } = {}) => {
    if (!path) {
      generationRef.current++;
      setDetails(null);
      return;
    }
    const generation = ++generationRef.current;
    const cached = reuse ? detailsCache.get(detailsKey(path, albumPath)) : undefined;
    if (cached) {
      setDetails(cached);
      setDetailsPath(path);
      setError(null);
      setLoading(false);
      return;
    }
    if (!reuse) forgetMediaDetails();

    try {
      setLoading(true);
      setError(null);
      const result = await readDetails(path, albumPath, !reuse);
      if (generation !== generationRef.current) return;
      setDetails(result);
      setDetailsPath(path);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setDetails(null);
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [albumPath, path]);

  useEffect(() => {
    fetchDetails({ reuse: true });
    // A different file has a different dump; keep the collapsible closed-and-empty.
    setRawExif(null);
  }, [fetchDetails]);

  // The chat drawer may caption or re-time the picture on screen.
  useEffect(() => onOutsideEdit(() => void fetchDetails()), [fetchDetails]);

  const loadRawExif = useCallback(async () => {
    if (!path || rawExif) return;
    setRawExifLoading(true);
    try {
      const result = await execCommand<MediaDetails>(`media-details ${detailsArgs(path, albumPath)} --fields raw`);
      setRawExif(result.exif?.raw ?? {});
    } catch {
      setRawExif({});
    } finally {
      setRawExifLoading(false);
    }
  }, [albumPath, path, rawExif]);

  /**
   * Turning a file regenerates its renditions server-side, so this is a slow call — seconds
   * for a photo. The refetch afterwards is what brings the remapped face boxes back.
   */
  const setOrientation = useCallback(async (change: OrientationChange) => {
    if (!path) return;
    setOrienting(true);
    try {
      const flag = 'rotate' in change ? `--rotate ${change.rotate}` : '--toggle-mirror';
      await execCommand(`file-set-orientation ${shq(path)} ${flag}`);
      await fetchDetails();
    } finally {
      setOrienting(false);
    }
  }, [path, fetchDetails]);

  const setTextLanguage = useCallback(async (language: string) => {
    if (!path) return;
    await execCommand(`file-set-text-language ${shq(path)} ${shq(language)}`);
    await fetchDetails();
  }, [path, fetchDetails]);

  const addComment = useCallback(async (text: string) => {
    if (!path || !text.trim()) return;
    await execCommand(`comment add ${shq(path)} --body-base64 ${encodeBody(text)}`);
    await fetchDetails();
  }, [path, fetchDetails]);

  const removeComment = useCallback(async (slug: string) => {
    if (!path) return;
    await execCommand(`comment remove ${shq(path)} ${shq(slug)}`);
    await fetchDetails();
  }, [path, fetchDetails]);

  const setText = useCallback(async (text: string) => {
    if (!path) return;
    await execCommand(`file-set-text ${shq(path)} --text-base64 ${encodeBody(text)}`);
    await fetchDetails();
  }, [path, fetchDetails]);

  const setTranscript = useCallback(async (vtt: string) => {
    if (!path) return;
    await execCommand(`file-set-transcript ${shq(path)} --vtt-base64 ${encodeBody(vtt)}`);
    forgetTranscript(`${fileUrl(path)}/metadata/transcript`);
    await fetchDetails();
  }, [path, fetchDetails]);

  const setDescription = useCallback(async (text: string) => {
    if (!path) return;
    await execCommand(`file-set-description ${shq(path)} --text-base64 ${encodeBody(text)}`);
    await fetchDetails();
  }, [path, fetchDetails]);

  // Handed to `onChanged` props and the like, which may pass arguments of their own.
  const refetch = useCallback(() => fetchDetails(), [fetchDetails]);

  return {
    details,
    detailsPath,
    loading,
    error,
    refetch,
    addComment,
    removeComment,
    setDescription,
    setOrientation,
    orienting,
    setTextLanguage,
    setText,
    setTranscript,
    rawExif,
    loadRawExif,
    rawExifLoading,
  };
}
