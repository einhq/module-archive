import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Button, Group, Loader, Menu, Text, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MediaDetails, MediaSpeaker } from '@archive/media/api';
import { usePersistedState, useShortcutHelp } from '@ein/ui/hooks';
import { bust, displayDims, fileUrl, formatClock, posterUrl, VIDEO_SOURCE_TYPE } from '@ein/ui/lib';
import type { MediaItem } from '@ein/ui/signals';
import { useContentRect } from '../hooks/useContentRect.ts';
import { useCast } from '../hooks/useCast.ts';
import { useMediaTransport } from '../hooks/useMediaTransport.ts';
import { usePictureInPicture } from '../hooks/usePictureInPicture.ts';
import { usePlayPauseKey } from '../hooks/usePlayPauseKey.ts';
import { useTranscriptCues } from '../hooks/useTranscriptCues.ts';
import { barPlacement, CHROME_IDLE_MS, chromeVisible, fittedPicture, subtitleBottom, subtitleClearOfCentre, subtitleFontPx } from '../lib/player-chrome.ts';
import { chapterIndex, chapterLabel, chapterSeek, chapterSegments, nextChapterStart, previousChapterStart, segmentsFit } from '../lib/chapters.ts';
import { parseVolume, PLAYBACK_RATES, rateLabel, stepRate, volumeIcon } from '../lib/player-settings.ts';
import { previewLeft, previewSize, tileBackground } from '../lib/storyboard.ts';
import { attachSpeakers, cueAt, speakerColor, speakerLabel } from '../lib/vtt.ts';
import { Scrubber } from './Scrubber.tsx';
import { VolumeSlider } from './VolumeSlider.tsx';
import './video-player.css';

/** What the skip buttons and `j`/`l` move by, in seconds. */
const SKIP_SECONDS = 10;

/** Half the height of a phone's centre buttons: the 64 px play button. */
const CENTRE_HALF_PX = 32;

/** How long after the fullscreen button a fullscreen counts as the one it asked for. */
const FULLSCREEN_ASKED_MS = 2000;

/** The preview frame's longer side over the timeline: a tile at its own size, smaller on a phone. */
const PREVIEW_PX = { desktop: 160, compact: 128 };

const VIDEO_SHORTCUTS = [
  { keys: 'Space', label: 'Play or pause' },
  { keys: 'j', label: `Back ${SKIP_SECONDS} seconds` },
  { keys: 'l', label: `Forward ${SKIP_SECONDS} seconds` },
  { keys: 'shift+←', label: 'Previous chapter, when the video has chapters' },
  { keys: 'shift+→', label: 'Next chapter' },
  { keys: 'c', label: 'Subtitles on or off' },
  { keys: 'm', label: 'Mute or unmute' },
  { keys: '<', label: 'Slower' },
  { keys: '>', label: 'Faster' },
  { keys: 'p', label: 'Picture-in-picture on or off, where the browser has it' },
];

/**
 * Whether a page can set the volume: an iPhone's or iPad's Safari leaves it to the device's own
 * buttons, ignores the assignment and always reads 1.
 */
const volumeSettable = (): boolean => {
  const probe = document.createElement('audio');
  probe.volume = 0.5;
  return probe.volume === 0.5;
};

/** Safari's own fullscreen for a video element, the only one an iPhone has. */
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Orientation locking, which TypeScript's DOM types no longer carry; Android's Chrome has it. */
type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void> };

/**
 * What the subtitle button and the native track call the transcript's language.
 *
 * Whisper reports an ISO-639-1 code; `Intl.DisplayNames` turns it into the viewer's own word for
 * that language. It throws on a code it does not know, so the code itself is the fallback.
 */
function transcriptLabel(language?: string): string {
  if (!language) return 'Transcript';
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** The rendition's picture alone, to tell a browser without AV1 from one without the sound's codec. */
const AV1_ONLY = 'video/mp4; codecs="av01.0.08M.08"';

/** Why the video does not play, in the viewer's terms. */
function failureText(video: HTMLVideoElement, rendition: boolean): string {
  if (rendition && video.canPlayType(VIDEO_SOURCE_TYPE) === '') {
    return video.canPlayType(AV1_ONLY) === ''
      ? 'This browser or device cannot play AV1, the format this video is in.'
      : 'This browser cannot play the format this video is in.';
  }
  return 'This rendition could not be played. It may still be transcoding.';
}

type VideoPlayerProps = {
  media: MediaItem;
  /** The lightbox's cache-buster for this file's renditions. */
  reloadToken: number;
  /** Hands the element to the lightbox, whose zoom, face boxes and details sheet measure it. */
  videoRef: (el: HTMLVideoElement | null) => void;
  /** The lightbox's zoom, a transform about the player's centre: it moves the picture and not the controls. */
  pictureStyle?: CSSProperties;
  /** What is drawn on the picture and moves with it under the zoom: the face boxes. */
  pictureOverlay?: ReactNode;
  /** The transcript's language and voices, when the video has one. */
  transcript?: { language?: string; speakers: MediaSpeaker[] };
  /** The video's storyboard sheet and where to fetch it, for the frame shown over the timeline. */
  storyboard?: NonNullable<MediaDetails['storyboard']> & { url: string };
  /** Where the video's chapters start, the first at 0: its cuts. */
  chapters?: number[];
  /** A phone's layout: the transport over the middle of the picture, larger targets, no mute. */
  compact: boolean;
  slideshow: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Off while a dialog over the lightbox has the keys. */
  keysEnabled: boolean;
  /** In a slideshow, how much of the player's bottom edge the information bar lies over. */
  coveredBottom: number;
  onEnded?: () => void;
  /** It cannot play on its own: the browser wants a gesture first, or the video failed. */
  onStalled?: () => void;
  /** It started, or started again. */
  onPlay?: () => void;
};

/**
 * The lightbox's video arm: the native `<video>` with controls of our own over it.
 *
 * Our own rather than the browser's for what the browser's cannot do: subtitles that say who is
 * speaking, a timeline the lightbox's gestures and keys can live beside, and the same transport as
 * the audio player (`useMediaTransport`). The controls fade while it plays: after a mouse stops
 * moving, or a tap; they stay while it is paused, scrubbed, pointed at or tabbed through. The bar
 * sits under the picture when the letterbox has the room, and over its bottom edge otherwise.
 *
 * What the browser's controls offered besides is kept: the speed, the volume (on a desktop; a
 * phone has its buttons), picture-in-picture and casting, the last two only where the browser has
 * them. On a phone they share one menu, for the bar's width.
 *
 * Subtitles are drawn here rather than by the browser, which drops the speaker of a `<v>` span. The
 * `<track>` is kept for one case: an iPhone's fullscreen is the system's player, where nothing of
 * ours shows, so the track is switched on there while the viewer has subtitles on.
 */
export function VideoPlayer({
  media,
  reloadToken,
  videoRef,
  pictureStyle,
  pictureOverlay,
  transcript,
  storyboard,
  chapters,
  compact,
  slideshow,
  fullscreen,
  onToggleFullscreen,
  keysEnabled,
  coveredBottom,
  onEnded,
  onStalled,
  onPlay,
}: VideoPlayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const sourceRef = useRef<HTMLSourceElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    videoRef(el);
  }, [videoRef]);
  const onStalledRef = useRef(onStalled);
  onStalledRef.current = onStalled;

  const [failure, setFailure] = useState<string | null>(null);
  // With frames to show under the finger, a drag need not seek until it ends.
  const transport = useMediaTransport(videoElRef, {
    fallbackDuration: media.duration,
    startAt: media.atSeconds,
    autoPlay: true,
    seekOnRelease: storyboard !== undefined,
    onEnded,
    onPlay,
    onRefused: onStalled,
  });
  const { playing, position, duration, toggle, skip } = transport;
  usePlayPauseKey(toggle, keysEnabled && failure === null);

  // --- subtitles
  // Off unless asked for: on home video the transcript is a reading and search aid, not an
  // accessibility need the viewer has declared. Remembered once turned on.
  const [subtitlePreference, setSubtitlePreference] = usePersistedState<'on' | 'off'>('lightbox.subtitles', 'off');
  const subtitles = transcript !== undefined && subtitlePreference === 'on';
  const toggleSubtitles = useCallback(() => setSubtitlePreference(subtitlePreference === 'on' ? 'off' : 'on'), [setSubtitlePreference, subtitlePreference]);
  const transcriptUrl = bust(`${fileUrl(media.path)}/metadata/transcript`, reloadToken);
  const { cues } = useTranscriptCues(subtitles ? transcriptUrl : null);
  const speakers = transcript?.speakers;
  const spoken = useMemo(() => (cues ? attachSpeakers(cues, speakers ?? []) : null), [cues, speakers]);
  const cue = spoken ? cueAt(spoken, position) : undefined;
  // One voice needs no name on every line.
  const namedVoices = (speakers?.length ?? 0) >= 2;

  // --- the frame over the timeline: where the pointer is on it, and the sheet fetched once the video can play
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const [pointed, setPointed] = useState<{ seconds: number; x: number } | null>(null);
  const onPoint = useCallback((seconds: number | null, clientX: number) => {
    const rect = scrubberRef.current?.getBoundingClientRect();
    setPointed(seconds === null || !rect ? null : { seconds, x: clientX - rect.left });
  }, []);
  const sheetUrl = storyboard?.url;
  useEffect(() => {
    const video = videoElRef.current;
    if (!video || !sheetUrl) return;
    const warm = () => {
      new Image().src = sheetUrl;
    };
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) warm();
    else video.addEventListener('canplay', warm, { once: true });
    return () => video.removeEventListener('canplay', warm);
  }, [sheetUrl]);

  // --- the controls' visibility
  const [active, setActive] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const pointerTypeRef = useRef('mouse');
  const poke = useCallback((kind: keyof typeof CHROME_IDLE_MS) => {
    setActive(true);
    globalThis.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = globalThis.setTimeout(() => setActive(false), CHROME_IDLE_MS[kind]);
  }, []);
  useEffect(() => {
    poke('mouse');
    return () => globalThis.clearTimeout(idleTimerRef.current);
  }, [poke]);
  const visible = failure === null && chromeVisible({ paused: !playing, scrubbing: transport.scrubbing, hovered, focused, menuOpen }, active, slideshow);

  // A clicked button keeps the focus; only a keyboard user's focus (`:focus-visible`) holds the
  // controls, on the bar or on a phone's centre buttons.
  const trackFocus = useCallback(() => {
    requestAnimationFrame(() => setFocused(rootRef.current?.querySelector('[data-video-controls]:focus-visible, [data-video-controls] :focus-visible') != null));
  }, []);

  // --- geometry
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (!root) return;
    // The bar's own height, without the shade it gets over the picture: where it goes is decided
    // from this, so it must not depend on where it went last.
    const observer = new ResizeObserver(() => {
      setBox({ width: root.clientWidth, height: root.clientHeight });
      if (bar) setBarHeight(bar.offsetHeight - parseFloat(getComputedStyle(bar).paddingTop || '0'));
    });
    observer.observe(root);
    if (bar) observer.observe(bar, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  const contentRect = useContentRect(videoElRef);
  const dims = displayDims(media);
  // Before the video knows its size, the metadata's: the controls and subtitles have somewhere to be.
  const picture = contentRect ?? fittedPicture(box, dims && dims.width / dims.height);
  const pictureBottom = picture.top + picture.height;
  const placement = barPlacement(picture, box.height, barHeight);
  const barShown = failure === null && !slideshow && (visible || placement === 'below');
  const barOverPicture = barShown && placement === 'overlay' ? barHeight : 0;
  const centre: CSSProperties = { left: picture.left + picture.width / 2, top: picture.top + picture.height / 2, transform: 'translate(-50%, -50%)' };
  const centreShown = compact && visible && failure === null && !slideshow;
  const subtitlePx = subtitleFontPx(picture);
  const belowSubtitles = subtitleBottom(picture, box.height, barOverPicture, slideshow ? coveredBottom : 0);
  const subtitlesAt = centreShown ? subtitleClearOfCentre(belowSubtitles, picture, box.height, subtitlePx, CENTRE_HALF_PX) : belowSubtitles;
  // The bar cannot show in a slideshow or over a video that failed; then it leaves the tab order,
  // or a Tab would put the arrow keys on a timeline nobody can see.
  const unreachable = slideshow || failure !== null;

  // --- the element's own state: sound, speed, readiness
  // The volume is remembered across videos and visits; the speed is the video's own, as the
  // browser's controls keep it.
  const [storedVolume, setStoredVolume] = usePersistedState<string>('lightbox.volume', '1');
  const initialVolumeRef = useRef(parseVolume(storedVolume));
  const [volume, setVolume] = useState(initialVolumeRef.current);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false);
  const canSetVolume = useMemo(volumeSettable, []);
  const toggleMute = useCallback(() => {
    const video = videoElRef.current;
    if (!video) return;
    // Dragged down to nothing, unmuting would still be silent.
    if (video.muted && video.volume === 0) video.volume = 1;
    video.muted = !video.muted;
  }, []);
  const changeVolume = useCallback((value: number) => {
    const video = videoElRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    // Silence is a mute, not a volume for the next video to open with.
    if (value > 0) setStoredVolume(String(value));
  }, [setStoredVolume]);
  const changeRate = useCallback((value: number) => {
    const video = videoElRef.current;
    if (!video) return;
    // The default too, or the element falls back to it when it loads again.
    video.defaultPlaybackRate = value;
    video.playbackRate = value;
  }, []);
  const pip = usePictureInPicture(videoElRef);
  const cast = useCast(videoElRef);
  useEffect(() => {
    const video = videoElRef.current;
    const source = sourceRef.current;
    if (!video) return;
    if (canSetVolume) video.volume = initialVolumeRef.current;
    const onVolume = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onRate = () => setRate(video.playbackRate);
    const onMetadata = () => setReady(true);
    // A `<source>` that fails reports it on itself, not on the video; a decode failure on the video.
    const fail = () => {
      setFailure(failureText(video, media.hasDerivatives));
      onStalledRef.current?.();
    };
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ratechange', onRate);
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('error', fail);
    source?.addEventListener('error', fail);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) setReady(true);
    return () => {
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ratechange', onRate);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('error', fail);
      source?.removeEventListener('error', fail);
    };
  }, [canSetVolume, media.hasDerivatives]);

  // --- fullscreen
  // An iPhone has no fullscreen for a page, only Safari's player for the video itself, which throws
  // until the video has its metadata.
  const nativeFullscreenOnly = !document.fullscreenEnabled && 'webkitEnterFullscreen' in HTMLVideoElement.prototype;
  const lockAskedAtRef = useRef(0);
  const lockedRef = useRef(false);
  const toggleFullscreen = useCallback(() => {
    const video = videoElRef.current as WebkitVideo | null;
    if (nativeFullscreenOnly) {
      video?.webkitEnterFullscreen?.();
      return;
    }
    lockAskedAtRef.current = !fullscreen && pointerTypeRef.current !== 'mouse' ? performance.now() : 0;
    onToggleFullscreen();
  }, [fullscreen, nativeFullscreenOnly, onToggleFullscreen]);
  // A page in fullscreen does not turn the phone: a landscape video on an upright phone would stay
  // small, so the screen is locked to landscape while it lasts, where the browser allows it — only
  // for a fullscreen this player's own button asked for, and given back when it ends or the
  // player goes.
  useEffect(() => {
    const orientation = screen.orientation as LockableOrientation | undefined;
    const release = () => {
      if (!lockedRef.current) return;
      lockedRef.current = false;
      try {
        orientation?.unlock();
      } catch {
        // nothing was locked
      }
    };
    if (!fullscreen) return release();
    const asked = performance.now() - lockAskedAtRef.current < FULLSCREEN_ASKED_MS;
    lockAskedAtRef.current = 0;
    const video = videoElRef.current;
    if (asked && video && video.videoWidth > video.videoHeight && orientation?.lock) {
      orientation.lock('landscape').then(() => {
        lockedRef.current = true;
      }, () => {});
    }
    return release;
  }, [fullscreen]);

  // The native track shows only inside Safari's own fullscreen, and only with subtitles on; Safari can
  // switch a track on by itself from the system's caption setting, which would draw it under ours.
  const subtitlesRef = useRef(subtitles);
  subtitlesRef.current = subtitles;
  const hasTranscript = transcript !== undefined;
  useEffect(() => {
    const video = videoElRef.current;
    if (!video || !hasTranscript) return;
    const tracks = video.textTracks;
    let native = false;
    const settle = () => {
      const mode = native && subtitlesRef.current ? 'showing' : 'disabled';
      for (const track of Array.from(tracks)) if (track.mode !== mode) track.mode = mode;
    };
    const onBegin = () => {
      native = true;
      settle();
    };
    // What the viewer chose in Safari's player is what they have when they come back.
    const onEnd = () => {
      const shown = Array.from(tracks).some((track) => track.mode === 'showing');
      native = false;
      setSubtitlePreference(shown ? 'on' : 'off');
      settle();
    };
    const onChange = () => {
      if (!native) settle();
    };
    video.addEventListener('webkitbeginfullscreen', onBegin);
    video.addEventListener('webkitendfullscreen', onEnd);
    tracks.addEventListener('change', onChange);
    tracks.addEventListener('addtrack', settle);
    settle();
    return () => {
      video.removeEventListener('webkitbeginfullscreen', onBegin);
      video.removeEventListener('webkitendfullscreen', onEnd);
      tracks.removeEventListener('change', onChange);
      tracks.removeEventListener('addtrack', settle);
    };
  }, [hasTranscript, setSubtitlePreference]);

  // --- chapters: one start is no chapters at all
  const starts = chapters && chapters.length > 1 ? chapters : undefined;
  const goChapter = useCallback((direction: 'previous' | 'next') => {
    if (!starts) return;
    const t = videoElRef.current?.currentTime ?? 0;
    const target = direction === 'next' ? nextChapterStart(starts, t) : previousChapterStart(starts, t);
    if (target !== null) transport.seek(chapterSeek(target));
  }, [starts, transport]);
  const atLastChapter = starts ? chapterIndex(starts, position) === starts.length - 1 : true;
  // A tape's hundreds of chapters cannot each be a piece of the timeline on a phone: then a tick at each start.
  const timelineWidth = Math.max(0, box.width - (compact ? 48 : 24));
  const segmented = starts !== undefined && segmentsFit(starts, duration, timelineWidth);

  // --- keys
  useShortcutHelp('Video', VIDEO_SHORTCUTS);
  useHotkeys(
    keysEnabled && failure === null
      ? [
        ['j', () => {
          skip(-SKIP_SECONDS);
          poke('mouse');
        }],
        ['l', () => {
          skip(SKIP_SECONDS);
          poke('mouse');
        }],
        ['m', toggleMute],
        ['c', () => hasTranscript && toggleSubtitles()],
        ['p', () => pip.supported && ready && pip.toggle()],
        // `<` is shifted on some layouts and not on others; its key's name is the same either way.
        ['<', () => changeRate(stepRate(rate, -1))],
        ['shift+<', () => changeRate(stepRate(rate, -1))],
        ['>', () => changeRate(stepRate(rate, 1))],
        ['shift+>', () => changeRate(stepRate(rate, 1))],
        // Plain ←/→ are the lightbox's previous and next; with Shift they go by chapter.
        ['shift+ArrowLeft', () => {
          goChapter('previous');
          poke('mouse');
        }],
        ['shift+ArrowRight', () => {
          goChapter('next');
          poke('mouse');
        }],
      ]
      : [],
  );

  // --- the picture's own clicks: play and pause with a mouse, show and hide the controls with a finger
  const onControls = (target: EventTarget) => target instanceof Element && target.closest('[data-video-controls]') !== null;
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A slideshow's click is the lightbox's: it stops the slideshow.
    if (slideshow || failure !== null || onControls(event.target)) return;
    if (pointerTypeRef.current === 'mouse') {
      toggle();
      poke('mouse');
      return;
    }
    if (visible) {
      globalThis.clearTimeout(idleTimerRef.current);
      setActive(false);
    } else {
      poke('touch');
    }
  };
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Two taps arrive as a dblclick too; a finger has the button. The big play button counts as
    // the picture: the first click of a double-click pauses, and the second lands on it.
    const onBar = event.target instanceof Element && event.target.closest('.mrx-video-bar, .mrx-video-centre') !== null;
    if (slideshow || pointerTypeRef.current !== 'mouse' || onBar) return;
    toggleFullscreen();
  };

  const iconSize = compact ? 24 : 20;
  const buttonSize = compact ? 'xl' : 'lg';
  const waiting = transport.buffering && playing && !transport.scrubbing && failure === null;
  const playIcon = playing ? 'player-pause-filled' : 'player-play-filled';
  const playLabel = playing ? 'Pause' : 'Play';
  // Controls never take the focus from a click or a tap, so the lightbox's arrow keys stay its own.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <Box
      ref={rootRef}
      data-video-player
      onPointerDown={(event) => {
        pointerTypeRef.current = event.pointerType;
      }}
      // A finger on the controls is a sign of the viewer as much as a tap on the picture: a tap on
      // +10, or the end of a scrub, keeps them up for another while.
      onPointerUp={(event) => {
        if (event.pointerType !== 'mouse' && onControls(event.target)) poke('touch');
      }}
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse') poke('mouse');
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className='mrx-video-player'
      // In fullscreen the pointer goes with an idle mouse, whatever the controls are doing.
      style={{ cursor: fullscreen && !active && !hovered ? 'none' : undefined }}
    >
      {/* The picture alone takes the zoom; the subtitles and controls stay where they are. */}
      <Box data-video-picture className='mrx-video-picture' style={pictureStyle}>
        <video
          ref={attachVideo}
          playsInline
          preload='metadata'
          // Not `media.thumbnailUrl`: that is the 320 square *crop*, and a centre-cropped poster
          // under a contain-fitted video is the wrong picture in the wrong shape.
          poster={bust(posterUrl(media.path, media.type, media.hasDerivatives, displayDims(media)), reloadToken)}
          // The browser's menu offers to show its own controls, which would draw a second bar under ours.
          onContextMenu={(event) => event.preventDefault()}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
        >
          {/* Without a rendition the original plays as whatever it is; only the rendition is known to be AV1. */}
          <source ref={sourceRef} src={bust(media.fullUrl, reloadToken)} type={media.hasDerivatives ? VIDEO_SOURCE_TYPE : undefined} />
          {transcript && <track kind='subtitles' src={transcriptUrl} srcLang={transcript.language ?? 'und'} label={transcriptLabel(transcript.language)} />}
        </video>
        {pictureOverlay}
      </Box>

      {subtitles && cue && (
        <Box
          data-video-subtitles
          aria-hidden
          className='mrx-video-subtitles'
          style={{
            left: picture.left + picture.width / 2,
            bottom: subtitlesAt,
            maxWidth: picture.width * 0.9,
            fontSize: subtitlePx,
          }}
        >
          <span>
            {namedVoices && cue.speaker && (
              <b style={{ color: `var(--mantine-color-${speakerColor(cue.speaker.speaker)}-4)`, marginRight: '0.4em' }}>{speakerLabel(cue.speaker)}</b>
            )}
            {cue.text}
          </span>
        </Box>
      )}

      {failure !== null && (
        <Box className='mrx-video-failure' style={centre}>
          <Text size='sm' c='gray.2'>{failure}</Text>
        </Box>
      )}

      {waiting && !(compact && visible) && (
        <Box className='mrx-video-wait' style={centre}>
          <Loader color='white' size='lg' />
        </Box>
      )}

      {!compact && !playing && failure === null && !slideshow && (
        <ActionIcon
          data-video-controls
          className='mrx-video-big-play'
          variant='filled'
          color='dark'
          size={72}
          radius='xl'
          onMouseDown={keepFocus}
          onClick={toggle}
          aria-label='Play'
          style={centre}
        >
          <TablerIcon name='player-play-filled' size={34} color='white' />
        </ActionIcon>
      )}

      {compact && failure === null && !slideshow && (
        <Group
          data-video-controls
          className='mrx-video-centre'
          data-hidden={!visible || undefined}
          gap='xl'
          wrap='nowrap'
          onMouseDown={keepFocus}
          onFocus={trackFocus}
          onBlur={trackFocus}
          style={centre}
        >
          {starts
            ? (
              <ActionIcon variant='subtle' color='gray' size={48} radius='xl' onClick={() => goChapter('previous')} aria-label='Previous chapter'>
                <TablerIcon name='arrow-bar-to-left' size={28} color='white' />
              </ActionIcon>
            )
            : (
              <ActionIcon variant='subtle' color='gray' size={48} radius='xl' onClick={() => skip(-SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`}>
                <TablerIcon name='rewind-backward-10' size={28} color='white' />
              </ActionIcon>
            )}
          <ActionIcon variant='filled' color='dark' size={64} radius='xl' onClick={toggle} aria-label={playLabel}>
            {waiting ? <Loader color='white' size='sm' /> : <TablerIcon name={playIcon} size={30} color='white' />}
          </ActionIcon>
          {starts
            ? (
              <ActionIcon variant='subtle' color='gray' size={48} radius='xl' onClick={() => goChapter('next')} disabled={atLastChapter} aria-label='Next chapter'>
                <TablerIcon name='arrow-bar-to-right' size={28} color='white' />
              </ActionIcon>
            )
            : (
              <ActionIcon variant='subtle' color='gray' size={48} radius='xl' onClick={() => skip(SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`}>
                <TablerIcon name='rewind-forward-10' size={28} color='white' />
              </ActionIcon>
            )}
        </Group>
      )}

      <Box
        ref={barRef}
        data-video-controls
        className='mrx-video-bar'
        data-placement={placement}
        data-compact={compact || undefined}
        data-hidden={!barShown || undefined}
        inert={unreachable}
        onMouseDown={keepFocus}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={trackFocus}
        onBlur={trackFocus}
        style={placement === 'below' ? { top: pictureBottom } : { bottom: box.height - pictureBottom }}
      >
        <Box ref={scrubberRef} style={{ position: 'relative' }}>
          <Scrubber
            transport={transport}
            chapters={starts}
            valueText={starts ? `${formatClock(position) || '0:00'}, ${chapterLabel(starts, position).toLowerCase()}` : undefined}
            onPoint={onPoint}
            className='mrx-video-scrubber'
          >
            {segmented && starts
              ? chapterSegments(starts, duration).map(({ start, end }, i) => (
                <div key={i} data-chapter={i + 1} className='mrx-video-segment' style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }}>
                  <div
                    className='mrx-video-played'
                    style={{ transform: `scaleX(clamp(0, calc((var(--progress, 0) - ${start}) / ${end - start}), 1))` }}
                  />
                </div>
              ))
              : (
                <div className='mrx-video-track'>
                  <div className='mrx-video-played' style={{ transform: 'scaleX(var(--progress, 0))' }} />
                  {starts && duration > 0 && starts.slice(1).map((start) => <div key={start} className='mrx-video-tick' style={{ left: `${(start / duration) * 100}%` }} />)}
                </div>
              )}
            <div className='mrx-video-thumb' />
          </Scrubber>
          {pointed && (
            <TimelinePreview
              storyboard={storyboard}
              chapter={starts ? chapterIndex(starts, pointed.seconds) + 1 : undefined}
              pointed={pointed}
              width={scrubberRef.current?.clientWidth ?? 0}
              longest={compact ? PREVIEW_PX.compact : PREVIEW_PX.desktop}
            />
          )}
        </Box>

        <Group gap={compact ? 4 : 2} wrap='nowrap'>
          {!compact && (
            <>
              <Tooltip label={`${playLabel} (Space)`} withArrow>
                <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={toggle} aria-label={playLabel}>
                  <TablerIcon name={playIcon} size={iconSize} color='white' />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={`Back ${SKIP_SECONDS} s (j)`} withArrow>
                <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={() => skip(-SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`}>
                  <TablerIcon name='rewind-backward-10' size={iconSize} color='white' />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={`Forward ${SKIP_SECONDS} s (l)`} withArrow>
                <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={() => skip(SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`}>
                  <TablerIcon name='rewind-forward-10' size={iconSize} color='white' />
                </ActionIcon>
              </Tooltip>
              {starts && (
                <>
                  <Tooltip label='Previous chapter (Shift+←)' withArrow>
                    <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={() => goChapter('previous')} aria-label='Previous chapter'>
                      <TablerIcon name='arrow-bar-to-left' size={iconSize} color='white' />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label='Next chapter (Shift+→)' withArrow>
                    <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={() => goChapter('next')} disabled={atLastChapter} aria-label='Next chapter'>
                      <TablerIcon name='arrow-bar-to-right' size={iconSize} color='white' />
                    </ActionIcon>
                  </Tooltip>
                </>
              )}
              <Tooltip label={muted ? 'Unmute (m)' : 'Mute (m)'} withArrow>
                <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
                  <TablerIcon name={volumeIcon(volume, muted)} size={iconSize} color='white' />
                </ActionIcon>
              </Tooltip>
              {canSetVolume && <VolumeSlider volume={volume} muted={muted} onChange={changeVolume} />}
            </>
          )}
          {
            /* Monospace and tabular figures, so the digits do not jitter as it counts. */
          }
          <Text size='sm' c='gray.3' ff='monospace' px={compact ? 4 : 6} style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {formatClock(position) || '0:00'} / {formatClock(duration) || '—'}
          </Text>
          {starts && !compact && (
            <Text size='sm' c='gray.4' style={{ whiteSpace: 'nowrap' }}>
              {chapterLabel(starts, position)}
            </Text>
          )}
          <Box style={{ flex: 1 }} />
          {transcript && (
            <Tooltip label={`Subtitles: ${transcriptLabel(transcript.language)} (c)`} withArrow>
              <ActionIcon
                variant='subtle'
                color='gray'
                size={buttonSize}
                onClick={toggleSubtitles}
                aria-label={`Subtitles: ${transcriptLabel(transcript.language)}`}
                aria-pressed={subtitles}
              >
                <TablerIcon name={subtitles ? 'badge-cc-filled' : 'badge-cc'} size={iconSize} color='white' />
              </ActionIcon>
            </Tooltip>
          )}
          {compact
            ? (
              <PlayerMenu
                rate={rate}
                onRate={changeRate}
                onChange={setMenuOpen}
                compact
                target={
                  <ActionIcon variant='subtle' color='gray' size={buttonSize} aria-label='Playback settings'>
                    <TablerIcon name='settings' size={iconSize} color='white' />
                  </ActionIcon>
                }
              >
                {(pip.supported || cast.available) && <Menu.Divider />}
                {pip.supported && (
                  <Menu.Item leftSection={<TablerIcon name={pip.active ? 'picture-in-picture-off' : 'picture-in-picture'} size={18} />} disabled={!ready} onClick={pip.toggle}>
                    {pip.active ? 'Leave picture-in-picture' : 'Picture-in-picture'}
                  </Menu.Item>
                )}
                {cast.available && (
                  <Menu.Item leftSection={<TablerIcon name='cast' size={18} />} onClick={cast.prompt}>
                    {cast.connected ? 'Casting…' : 'Cast to a screen…'}
                  </Menu.Item>
                )}
              </PlayerMenu>
            )
            : (
              <>
                <PlayerMenu
                  rate={rate}
                  onRate={changeRate}
                  onChange={setMenuOpen}
                  target={
                    <Tooltip label='Speed (< >)' withArrow disabled={menuOpen}>
                      <Button variant='subtle' color='gray' size='compact-md' px={6} c='white' aria-label={`Speed: ${rateLabel(rate)}`}>
                        {rateLabel(rate)}
                      </Button>
                    </Tooltip>
                  }
                />
                {pip.supported && (
                  <Tooltip label={pip.active ? 'Leave picture-in-picture (p)' : 'Picture-in-picture (p)'} withArrow>
                    <ActionIcon
                      variant='subtle'
                      color='gray'
                      size={buttonSize}
                      onClick={pip.toggle}
                      disabled={!ready}
                      aria-label='Picture-in-picture'
                      aria-pressed={pip.active}
                    >
                      <TablerIcon name={pip.active ? 'picture-in-picture-off' : 'picture-in-picture'} size={iconSize} color='white' />
                    </ActionIcon>
                  </Tooltip>
                )}
                {cast.available && (
                  <Tooltip label={cast.connected ? 'Casting' : 'Cast to a screen'} withArrow>
                    <ActionIcon variant='subtle' color='gray' size={buttonSize} onClick={cast.prompt} aria-label='Cast to a screen' aria-pressed={cast.connected}>
                      <TablerIcon name='cast' size={iconSize} color={cast.connected ? 'var(--mrx-accent)' : 'white'} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </>
            )}
          <Tooltip label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} withArrow>
            <ActionIcon
              variant='subtle'
              color='gray'
              size={buttonSize}
              onClick={toggleFullscreen}
              disabled={nativeFullscreenOnly && !ready}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              <TablerIcon name={fullscreen ? 'minimize' : 'maximize'} size={iconSize} color='white' />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
    </Box>
  );
}

/**
 * The speed menu, opening upward from the bar, with whatever else a phone's settings hold after it.
 *
 * Kept inside the bar rather than in a portal, so it is part of the controls: a click in it is not
 * a click on the picture, and the swipe and tap handling leave it alone. The keys pressed in it stay
 * there — Escape closes the menu, not the lightbox, and the arrows move through the items, not
 * through the album.
 */
function PlayerMenu({ rate, onRate, onChange, compact = false, target, children }: {
  rate: number;
  onRate: (rate: number) => void;
  onChange: (opened: boolean) => void;
  /** Items sized for a thumb, as the lightbox's own phone menu has them. */
  compact?: boolean;
  target: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Menu
      position='top-end'
      shadow='md'
      withinPortal={false}
      onChange={onChange}
      styles={compact ? { item: { fontSize: 'var(--mantine-font-size-md)', padding: '12px 16px' } } : undefined}
    >
      <Menu.Target>{target}</Menu.Target>
      <Menu.Dropdown onKeyDown={(event: ReactKeyboardEvent) => event.stopPropagation()}>
        <Menu.Label>Speed</Menu.Label>
        <Menu.RadioGroup value={String(rate)} onChange={(value) => value !== null && onRate(Number(value))}>
          {PLAYBACK_RATES.map((step) => (
            <Menu.RadioItem key={step} value={String(step)} closeMenuOnClick>
              {step === 1 ? 'Normal' : rateLabel(step)}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        {children}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * What is under the pointer on the timeline: the frame from the storyboard when the video has one,
 * and the time. Held inside the timeline's width, above it.
 */
function TimelinePreview({ storyboard, chapter, pointed, width, longest }: {
  storyboard?: NonNullable<MediaDetails['storyboard']> & { url: string };
  /** The chapter under the pointer, counted from 1, when the video has chapters. */
  chapter?: number;
  pointed: { seconds: number; x: number };
  width: number;
  longest: number;
}) {
  const size = storyboard ? previewSize(storyboard, longest) : null;
  // Room for the label on one line, which a portrait frame is too narrow to give.
  const boxWidth = Math.max(size?.width ?? 0, chapter ? 148 : 56);
  return (
    <Box aria-hidden className='mrx-video-preview' style={{ left: previewLeft(pointed.x, boxWidth, width), width: boxWidth }}>
      {storyboard && size && (
        <Box
          className='mrx-video-preview-frame'
          style={{ width: size.width, height: size.height, ...tileBackground(storyboard.url, storyboard, pointed.seconds, size.scale) }}
        />
      )}
      <span className='mrx-video-preview-time'>
        {formatClock(pointed.seconds) || '0:00'}
        {chapter ? ` · Chapter ${chapter}` : ''}
      </span>
    </Box>
  );
}
