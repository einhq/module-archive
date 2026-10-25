import { type RefObject, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { fileUrl } from '@ein/ui/lib';
import type { FaceBox, MediaFace } from '@archive/media/api';
import { boxAt, FACE_TRACK_NAME, parseTrack, type TrackPoint } from '../lib/face-track.ts';
import { FaceOverlay, toFaceMarks } from './FaceOverlay.tsx';

/** How near its own second a face without a track is still boxed. */
const STILL_BOX_SECONDS = 0.25;

/** Each face's track by its path, as they load; absent while loading or for a face with none. */
function useFaceTracks(facePaths: string[]): Map<string, TrackPoint[]> {
  const [tracks, setTracks] = useState(new Map<string, TrackPoint[]>());
  const key = facePaths.join('\n');
  useEffect(() => {
    let current = true;
    setTracks(new Map());
    for (const facePath of facePaths) {
      fetch(`${fileUrl(facePath)}/${FACE_TRACK_NAME}`)
        .then((response) => response.ok ? response.text() : '')
        .then((text) => {
          const points = parseTrack(text);
          if (current && points.length > 0) setTracks((loaded) => new Map(loaded).set(facePath, points));
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [key]);
  return tracks;
}

/**
 * The time of the video frame on screen, for every frame the video presents: while it plays and
 * when it is paused or sought to.
 *
 * Read from the frame itself (`mediaTime`) rather than `currentTime`, which runs about a frame
 * behind the one being presented, and committed at once: the callback comes in the rendering
 * step that paints the frame, so the boxes are painted with it and not a frame later.
 */
function useVideoTime(mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    const video = mediaRef.current;
    if (!(video instanceof HTMLVideoElement)) return;
    let handle = 0;
    const presented = (_now: number, frame: VideoFrameCallbackMetadata) => {
      flushSync(() => setTime(frame.mediaTime));
      handle = video.requestVideoFrameCallback(presented);
    };
    // Standing still the playhead is the frame shown: taken as well, so a paused or sought frame
    // never keeps the box of a frame callback that did not come.
    const still = () => setTime(video.currentTime);
    still();
    handle = video.requestVideoFrameCallback(presented);
    video.addEventListener('pause', still);
    video.addEventListener('seeked', still);
    return () => {
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener('pause', still);
      video.removeEventListener('seeked', still);
    };
  }, [mediaRef]);
  return time;
}

/** Where a face is at `time`: on its track, or at its own second when it has none. */
const boxNow = (face: MediaFace, track: TrackPoint[] | undefined, time: number): FaceBox | undefined => {
  if (track) return boxAt(track, face.appearances ?? [], time);
  return face.atSeconds !== undefined && Math.abs(time - face.atSeconds) < STILL_BOX_SECONDS ? face.faceBox : undefined;
};

/**
 * A video's faces, each boxed wherever it is while the video plays or stands still: the box
 * follows the face's track, sliding between the frames it was seen in, and is gone while the
 * face is off screen. As on a photo, a box is drawn while its face or name is hovered, or all of
 * them while `pinned`; `followed` is drawn as if hovered.
 *
 * Its own component, so a playhead read every frame redraws these boxes and not the lightbox.
 */
export function VideoFaces({ mediaRef, faces, followed, pinned, hoveredKey, onHover, onOpenPerson, onNamePerson }: {
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  faces: MediaFace[];
  /** The face the sidebar follows, by path. */
  followed: string | null;
  pinned: boolean;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  onOpenPerson: (route: string) => void;
  onNamePerson: (personPath: string, name: string) => Promise<void>;
}) {
  const tracks = useFaceTracks(useMemo(() => faces.map((face) => face.facePath), [faces]));
  const time = useVideoTime(mediaRef);
  const marks = useMemo(
    () =>
      toFaceMarks(faces.flatMap((face) => {
        const box = boxNow(face, tracks.get(face.facePath), time);
        return box ? [{ ...face, faceBox: box }] : [];
      })),
    [faces, tracks, time],
  );
  if (marks.length === 0) return null;
  return (
    <FaceOverlay
      mediaRef={mediaRef}
      faces={marks}
      pinned={pinned}
      hoveredKey={hoveredKey}
      followedKey={marks.find((mark) => mark.facePath === followed)?.key}
      onHover={onHover}
      onOpenPerson={onOpenPerson}
      onNamePerson={onNamePerson}
    />
  );
}
