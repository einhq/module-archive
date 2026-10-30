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

  const fetchDetails = useCallback(async () => {
    if (!path) {
      generationRef.current++;
      setDetails(null);
      return;
    }
    const generation = ++generationRef.current;

    try {
      setLoading(true);
      setError(null);
      const result = await execCommand<MediaDetails>(`media-details ${shq(path)}${albumPath ? ` --album ${shq(albumPath)}` : ''}`);
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
    fetchDetails();
    // A different file has a different dump; keep the collapsible closed-and-empty.
    setRawExif(null);
  }, [fetchDetails]);

  // The chat drawer may caption or re-time the picture on screen.
  useEffect(() => onOutsideEdit(() => void fetchDetails()), [fetchDetails]);

  const loadRawExif = useCallback(async () => {
    if (!path || rawExif) return;
    setRawExifLoading(true);
    try {
      const result = await execCommand<MediaDetails>(`media-details ${shq(path)}${albumPath ? ` --album ${shq(albumPath)}` : ''} --fields raw`);
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

  return {
    details,
    detailsPath,
    loading,
    error,
    refetch: fetchDetails,
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
