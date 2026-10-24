import { type RefObject, useEffect, useMemo, useState } from 'react';
import { fileUrl } from '@ein/ui/lib';
import type { MediaFace } from '@archive/media/api';
import { boxAt, FACE_TRACK_NAME, parseTrack, type TrackPoint } from '../lib/face-track.ts';
import { FaceOverlay, toFaceMarks } from './FaceOverlay.tsx';

/** How near its own second a face without a track is still boxed. */
const STILL_BOX_SECONDS = 0.25;

/** A face's track, or null while it loads or when the face has none. */
function useFaceTrack(facePath: string): TrackPoint[] | null {
  const [track, setTrack] = useState<TrackPoint[] | null>(null);
  useEffect(() => {
    let current = true;
    setTrack(null);
    fetch(`${fileUrl(facePath)}/${FACE_TRACK_NAME}`)
      .then((response) => response.ok ? response.text() : '')
      .then((text) => {
        const points = parseTrack(text);
        if (current) setTrack(points.length > 0 ? points : null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [facePath]);
  return track;
}

/** The video's playhead: every frame while it plays, and wherever it is paused or sought to. */
function useVideoTime(mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const video = mediaRef.current;
    if (!(video instanceof HTMLVideoElement)) return;
    let frame = 0;
    const read = () => setTime(video.currentTime);
    const tick = () => {
      read();
      frame = requestAnimationFrame(tick);
    };
    const play = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const pause = () => {
      cancelAnimationFrame(frame);
      read();
    };
    read();
    if (!video.paused) play();
    video.addEventListener('play', play);
    video.addEventListener('pause', pause);
    video.addEventListener('seeked', read);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', play);
      video.removeEventListener('pause', pause);
      video.removeEventListener('seeked', read);
    };
  }, [mediaRef]);
  return time;
}

/**
 * One face of a video, boxed wherever it is while the video plays or stands still: the box
 * follows its track, sliding between the frames it was seen in, and is gone while the face is
 * off screen. A face with no track is boxed only at the second its box is of.
 *
 * Its own component, so a playhead read every frame redraws this box and not the lightbox.
 */
export function FollowedFace({ mediaRef, face, onOpenPerson, onNamePerson }: {
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  face: MediaFace;
  onOpenPerson: (route: string) => void;
  onNamePerson: (personPath: string, name: string) => Promise<void>;
}) {
  const track = useFaceTrack(face.facePath);
  const time = useVideoTime(mediaRef);
  const box = track
    ? boxAt(track, face.appearances ?? [], time)
    : face.atSeconds !== undefined && Math.abs(time - face.atSeconds) < STILL_BOX_SECONDS
    ? face.faceBox
    : undefined;
  const marks = useMemo(() => box ? toFaceMarks([{ ...face, faceBox: box }]) : [], [box, face]);
  if (marks.length === 0) return null;
  return <FaceOverlay mediaRef={mediaRef} faces={marks} pinned hoveredKey={null} onHover={() => {}} onOpenPerson={onOpenPerson} onNamePerson={onNamePerson} />;
}
