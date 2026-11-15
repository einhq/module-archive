import { UnknownPersonModal } from '../../people/components/UnknownPersonModal.tsx';
import { Dialog, DrawerButtons, DrawerMenuItems, MapMarkers, MapShape, MapView, TablerIcon } from '@ein/ui/components';
import { PEOPLE_ROOT } from '@archive/paths';
import type { FaceAddResult } from '@archive/media/api';
import { ActionIcon, Box, Divider, Group, Kbd, Menu, Stack, Text, Tooltip } from '@mantine/core';
import { useHotkeys, useMediaQuery } from '@mantine/hooks';
import { effect, type Signal, signal } from '@preact/signals-react';
import { useSignals } from '@preact/signals-react/runtime';
import {
  type CSSProperties,
  type ImgHTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  startTransition,
  type TouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { bumpDerivativeVersion, bust, canWrite, displayDims, fileUrl, forgetAspect, isGuest, mediaItemFrom, posterUrl, shq, versionOf } from '@ein/ui/lib';
import { zoomFromTile, zoomToTile } from '../lib/lightbox-tile-zoom.ts';
import { itemAtAngle, lightboxPhotoSources } from '../lib/lightbox-image.ts';
import { lightboxSheetOpens, lightboxSwipeAction, lightboxSwipeFinish, type LightboxTouchPoint, releaseVelocityX, releaseVelocityY } from '../lib/lightbox-gesture.ts';
import { THUMB_MENU_STYLES } from '../lib/lightbox-presentation.ts';
import {
  isDoubleTap,
  isTap,
  isZoomed,
  panZoom,
  pinchGeometry,
  pinchZoom,
  stepZoom,
  type TapPoint,
  toggleZoom,
  wheelZoomScale,
  ZOOM_ANIMATION,
  ZOOM_IDENTITY,
  zoomAt,
  zoomedSizes,
  type ZoomFrame,
  type ZoomPoint,
  type ZoomState,
} from '../lib/lightbox-zoom.ts';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { useUnknownPerson } from '../../people/hooks/useUnknownPeople.ts';
import { useAccessIds, useShortcutHelp, useSurface, useWakeLock } from '@ein/ui/hooks';
import { forgetMediaDetails, type MediaDetails, peekMediaDetails, prefetchMediaDetails, type StackMemberRef, useMediaDetails } from '../hooks/useMediaDetails.ts';
import {
  albumMediaList,
  currentMediaIndex,
  currentMediaItem,
  endLightbox,
  execCommand,
  goToNextMedia,
  goToPrevMedia,
  hasNextMedia,
  hasPrevMedia,
  isAuthenticated,
  isLightboxOpen,
  lightboxReturnPath,
  linkVisitor,
  loadStars,
  type MediaItem,
  nextMediaIndex,
  prevMediaIndex,
  setStarred,
  starredPaths,
  userConfigFlag,
  userConfigNumber,
} from '@ein/ui/signals';
import { AudioPlayer } from './AudioPlayer.tsx';
import { DocumentReader } from './DocumentReader.tsx';
import { FaceOverlay, toFaceMarks } from './FaceOverlay.tsx';
import { VideoFaces } from './VideoFaces.tsx';
import { type FacePersonChange, FacePersonDialog } from './FacePersonDialog.tsx';
import { MediaSidebar, SIDEBAR_WIDTH } from './MediaSidebar.tsx';
import './lightbox-side.css';
import { SubtitleEditDialog } from './SubtitleEditDialog.tsx';
import { TextEditDialog } from './TextEditDialog.tsx';
import { TextOverlay } from './TextOverlay.tsx';
import { FileToolbar } from './FileToolbar.tsx';
import { VideoPlayer } from './VideoPlayer.tsx';
import { formatTakenParts, type TakenParts, timeSourceLabel, viewerLocalTime } from '../lib/capture-time.ts';
import { qualifiedDate } from '@archive/people/date-qualifier';
import { requestAlbumMediaRefresh } from '../signals/album.ts';
import {
  facesVisible,
  infoSidebarOpen,
  lightboxCountHidden,
  lightboxRestedPath,
  textVisible,
  toggleFacesVisible,
  toggleTextVisible,
  toggleToolbarVisible,
  toolbarVisible,
} from '../signals/lightbox.ts';

/** Slide duration when the person has not set `CFG_USER_SLIDESHOW_SECONDS`. */
const DEFAULT_SLIDE_SECONDS = 3;
const SLIDE_CROSSFADE_DURATION_MS = 550;

/**
 * How long the pan runs relative to one slide.
 *
 * The animation is deliberately longer than the dwell and started part-way in
 * (`animationDelay` below is the negative of the dwell), so a slide shows the
 * middle of the movement rather than its slow ends. Two slides' worth, as a
 * ratio so a viewer choosing 10 seconds per slide gets a pan that still fits.
 */
const KEN_BURNS_SLIDES = 2;
const SWIPE_ANIMATION_MS = 215;
const SWIPE_SETTLE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** A phone's details panel opened or closed by a button rather than a finger. */
const SHEET_TOGGLE_MS = 340;
/** Longer than the desktop details panel's slide (`.mrx-lightbox-side`), after which a closed one unmounts. */
const SIDE_SLIDE_MS = 450;
/** Set on the lightbox root only while a phone's details panel moves; see `beginSheet`. */
const SHEET_VARIABLES = [
  '--sheet-viewer-h',
  '--sheet-viewer-w',
  '--sheet-dx',
  '--sheet-dy',
  '--sheet-ds',
  '--sheet-ix',
  '--sheet-iy',
  '--sheet-iw',
  '--sheet-p',
  '--sheet-transition',
];
const SWIPE_FRAME_GAP_PX = 10;
/**
 * A desktop step moves as Google Photos' does: both pictures slide `STEP_SLIDE_SHARE` of the stage
 * the way the pictures run (left going forward), the old one fading out and the new one fading in
 * above it, done a little sooner. Each is cut to its own outline and to a frame that turns from
 * the old picture's outline into the new one's, so a wider picture narrows to a narrower one's.
 */
const STEP_MS = 300;
const STEP_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
const STEP_SLIDE_SHARE = 0.15;
/** The new picture's fade, over the first 250 ms of the step. */
const STEP_FADE_IN: Keyframe[] = [
  { opacity: 0, offset: 0, easing: STEP_EASING },
  { opacity: 1, offset: 250 / STEP_MS },
  { opacity: 1, offset: 1 },
];
/** The longest a step waits for its new picture to be decoded before it shows it all the same. */
const STEP_DECODE_WAIT_MS = 300;

/** A rectangle in the gesture surface's own coordinates. */
type StepRect = { left: number; top: number; right: number; bottom: number };

/** A still of a picture in a desktop step, in a frame of its own that cuts it to the step's frame. */
type StepCopy = { frame: HTMLDivElement; canvas: HTMLCanvasElement; rect: StepRect };

/**
 * A desktop step. A slide waits for the new picture to be decoded and then moves; a cut, a step
 * hard on the heels of another, shows the new picture as soon as it can be drawn; a reversal runs
 * the copies of both pictures back to where the step it turns began.
 */
type DesktopStep = {
  action: 'next' | 'previous';
  mode: 'slide' | 'cut' | 'reverse';
  /** Which way the pictures move: 1 to the left (forward), -1 to the right. */
  sign: 1 | -1;
  /** How far the pictures slide, in pixels. */
  distance: number;
  /** The old picture's outline, and the new one's once the slide starts. */
  from: StepRect | null;
  to: StepRect | null;
  /** A slide's still of the old picture, and how opaque the picture was. */
  copy: StepCopy | null;
  shown: number;
  /** A reversal's stills run back, rather than on again as a reversal of a reversal does. */
  backward: boolean;
  /** When the step's motion is over (`performance.now()`); null until it starts. */
  endsAt: number | null;
};

const intersectRect = (a: StepRect, b: StepRect): StepRect => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});
/** How long a click on a side waits for a second one, which makes it a double-click that zooms. */
const SIDE_CLICK_WAIT_MS = 250;
/** How many pictures on each side of the shown one are fetched ahead, so a run of quick swipes finds them there. */
const PRELOAD_DEPTH = 3;
/** How many of those load at once, nearest first, so the next picture does not share the line with the farthest. */
const PRELOAD_PARALLEL = 2;
/**
 * How long a picture is on screen, with no finger on it, before the viewer counts as stopped on it
 * (`lightboxRestedPath`). A run of swipes is quicker than this from one picture to the next.
 */
const LIGHTBOX_REST_MS = 600;
const NATIVE_EDGE_GESTURE_PX = 24;
const GESTURE_CONTROL_SELECTOR =
  'button, a, input, textarea, select, audio, [role="button"], [role="slider"], [data-face-link], [data-text-overlay], [data-video-controls], [data-document-reader]';

/**
 * A button of the bar's, or a row of the "more" menu when the bar has no room for it. `on` paints
 * its icon `onColor` (the accent unless given); `href` makes it a link that saves `download`.
 */
type BarAction = {
  key: string;
  icon: string;
  label: string;
  shortcut?: string;
  on: boolean;
  onColor?: string;
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
  download?: string;
};

/** The bar's buttons' widths, by Mantine size, for the room a view switch not yet shown would take. */
const BAR_BUTTON_PX: Record<string, number> = { lg: 34, xl: 44 };

type SlideshowPhotoTransition = {
  outgoing: MediaItem;
  outgoingReloadToken: number;
  outgoingTransform: string;
  incomingId: string;
  started: boolean;
};

type LightboxPhotoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes'> & {
  media: MediaItem;
  reloadToken: number;
  imageRef?: Ref<HTMLImageElement>;
  /** The srcset `sizes` hint; a zoomed picture raises it so a larger rendition is chosen. */
  sizes?: string;
};

/** A lightbox photo which retries the original after any display-rendition failure. */
function LightboxPhoto({ media, reloadToken, imageRef, sizes = '100vw', onError, ...imageProps }: LightboxPhotoProps) {
  const identity = `${media.path}#${reloadToken}`;
  const [failedPrimary, setFailedPrimary] = useState<string | null>(null);
  const sources = lightboxPhotoSources(media, reloadToken);
  const usingFallback = failedPrimary === identity && sources.fallback !== undefined;
  const source = usingFallback && sources.fallback ? sources.fallback : sources.primary;

  return (
    <img
      {...imageProps}
      ref={imageRef}
      src={source.src}
      {...(source.srcSet ? { srcSet: source.srcSet, sizes } : {})}
      onError={(event) => {
        if (!usingFallback && sources.fallback) {
          setFailedPrimary(identity);
          return;
        }
        onError?.(event);
      }}
    />
  );
}

/**
 * Fetches `item`'s picture into the browser's cache through the source ladder the frame and the
 * swipe preview ask for, and calls `done` once it has arrived or cannot. Null when there is no
 * picture to fetch: audio, or a video without a poster.
 */
function preloadPicture(item: MediaItem, done: () => void): HTMLImageElement | null {
  const token = versionOf(item.path);
  const image = new Image();
  image.onload = done;
  if (item.type !== 'photo') {
    const poster = posterUrl(item.path, item.type, item.hasDerivatives, displayDims(item));
    if (!poster) return null;
    image.onerror = done;
    image.src = bust(poster, token);
    return image;
  }
  const sources = lightboxPhotoSources(item, token);
  let usingFallback = false;
  image.onerror = () => {
    if (usingFallback || !sources.fallback) return done();
    usingFallback = true;
    image.srcset = '';
    image.removeAttribute('sizes');
    image.src = sources.fallback.src;
  };
  if (sources.primary.srcSet) {
    image.srcset = sources.primary.srcSet;
    image.sizes = '100vw';
  }
  image.src = sources.primary.src;
  return image;
}

/**
 * On a desktop the bottom bar and date strip share the album header's icon size, and its filter
 * and sort triggers' `lg` action icons, so the lightbox and the page it opened from look like one
 * set. A phone's bar is larger (`barIconSize`).
 */
const LIGHTBOX_ICON_SIZE = 18;

/**
 * A phone's date strip lies over the top edge of the picture — over the picture itself once
 * the bottom sheet has pushed the frame up to it — so it sits on its own dark rounded pill
 * rather than trusting whatever the photograph has in that corner.
 */
/** Where a phone's toolbar floats: under the date's pill, two lines high, and the menu button beside it. */
const MOBILE_TOOLBAR_TOP_PX = 68;

/** The icons on the details panel's surface and its handle, as Mantine's subtle grey buttons have them. */
const SIDE_ICON_COLOR = 'var(--mantine-color-gray-light-color)';

const TAKEN_PILL_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  minWidth: 0,
  padding: '4px 12px',
  borderRadius: 'var(--mantine-radius-md)',
  background: 'rgba(0, 0, 0, 0.55)',
};

const touchPoint = (touch: { clientX: number; clientY: number }, time: number): TapPoint => ({ x: touch.clientX, y: touch.clientY, time });

function kenBurnsClassForIndex(index: number, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  return `mrx-lightbox-ken-burns mrx-lightbox-ken-burns-${index % 2 === 0 ? 'a' : 'b'}`;
}

/**
 * Capture weekday, date and clock for the strip above the picture.
 *
 * Delegates to `formatTakenParts`, which renders exactly the precision the stored value has,
 * so a file known only to a year never shows a fabricated day and hour, in the reader's date and
 * time format. The month is written out, as the grid's date headers say it.
 * `short` abbreviates the day and month names ("Sat, 28 Feb 2026") for a narrow bar.
 */
function formatLightboxTaken(iso?: string, short = false): TakenParts {
  return formatTakenParts(iso, undefined, short ? { seconds: true, weekday: 'short' } : { seconds: true, weekday: true, long: true });
}

/** Prefer a named location, then the best human-readable reverse-geocoded location. */
function locationLabel(details: MediaDetails | null): string {
  if (details?.location?.name) return details.location.name;
  if (details?.position?.address) return details.position.address;
  return [details?.position?.city, details?.position?.country].filter(Boolean).join(', ');
}

/** What the bar says about one picture: where it is in the list, when and where it was taken. */
type BarInfo = { index: number; taken: TakenParts; takenLabel: string; takenTooltip: string; where: string };

/** `details` may be missing, or not read yet; the list item's date stands in until they are. */
function barInfoOf(item: MediaItem, details: MediaDetails | null, index: number, short: boolean): BarInfo {
  const takenAt = details?.takenAt ?? item.takenAt;
  // A date only about then is worn as `~1985`, as a person's is.
  const exact = formatLightboxTaken(takenAt, short);
  const taken = details?.takenAtQualifier ? { ...exact, date: qualifiedDate(exact.date, details.takenAtQualifier) } : exact;
  // A photograph is shown on the clock the photographer was reading. The viewer's own time is
  // offered beside it only when the two differ, which on this archive means the pictures taken
  // abroad and nothing else.
  const takenHere = viewerLocalTime(takenAt, details?.takenAtUtc ?? item.takenAtUtc);
  const takenSource = timeSourceLabel(details?.takenAtSource, details?.digitized);
  return {
    index,
    taken,
    takenLabel: taken.clock ? `${taken.date}, ${taken.clock}` : taken.date,
    takenTooltip: [takenHere && `${takenHere} your time`, details?.takenAtQualifier && 'approximate', takenSource, details?.takenAtNote].filter(Boolean).join(' · '),
    where: locationLabel(details),
  };
}

/**
 * The bar's counter, date and place, of the picture that fills most of the frame: during a swipe
 * the incoming one's from the moment it is past half way, `step` pictures on from `current`.
 * Only this renders again when that changes, never the lightbox, so the slide is not held back.
 * The incoming picture's place is there when its details were read ahead with its picture.
 */
function SwipeInfo({ step, current, short, children }: {
  step: Signal<number>;
  current: BarInfo;
  short: boolean;
  children: (info: BarInfo) => ReactNode;
}) {
  useSignals();
  const steps = step.value;
  const list = albumMediaList.value;
  const index = steps === 0 || list.length < 2 ? current.index : steps > 0 ? nextMediaIndex(current.index, list.length) : prevMediaIndex(current.index, list.length);
  const item = index === current.index ? undefined : list[index];
  return <>{children(item ? barInfoOf(item, peekMediaDetails(item.path, item.stackAlbumPath), index, short) : current)}</>;
}

const LIGHTBOX_SHORTCUTS = [
  { keys: '←', label: 'Previous' },
  { keys: '→', label: 'Next' },
  { keys: 'i', label: 'Show or hide the details' },
  { keys: 'f', label: 'Show or hide the faces' },
  { keys: 't', label: 'Show or hide the text in the picture' },
  { keys: 's', label: 'Favourite or unfavourite' },
  { keys: '+', label: 'Zoom in' },
  { keys: '-', label: 'Zoom out' },
  { keys: '0', label: 'Fit the picture' },
  { keys: 'Esc', label: 'Close' },
];

export function MediaLightbox() {
  useSignals();

  const albumMedia = currentMediaItem.value;
  const isOpen = isLightboxOpen.value;
  // A visitor held to a share link sees the pictures and not their details, which tell of the albums,
  // the similar pictures and the people around them that the link does not open.
  const withDetails = !linkVisitor.value;
  const sidebarOpen = withDetails && infoSidebarOpen.value;
  // A desktop's details panel stays mounted while it slides out, then goes.
  const [sideMounted, setSideMounted] = useState(sidebarOpen);
  // The panel slides only when toggled over an open picture. The lightbox opening with it open shows
  // it at once (`data-instant` on the first frame), so the picture zooms in to where it will stay.
  const [sideSettled, setSideSettled] = useState(false);
  useEffect(() => {
    if (!isOpen) return setSideSettled(false);
    const frame = requestAnimationFrame(() => setSideSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);
  useEffect(() => {
    if (sidebarOpen) return setSideMounted(true);
    const timer = globalThis.setTimeout(() => setSideMounted(false), SIDE_SLIDE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [sidebarOpen]);
  const showFaces = facesVisible.value;
  const showToolbar = toolbarVisible.value;
  const isNarrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const isCoarse = useMediaQuery('(hover: none) and (pointer: coarse)', false, { getInitialValueInEffect: false });
  const isLandscape = useMediaQuery('(orientation: landscape)', false, { getInitialValueInEffect: false });
  const isMobile = isNarrow || isCoarse;
  const mobilePortrait = isMobile && !isLandscape;
  // A phone's bar is under a thumb rather than a pointer; it gets larger targets than the header's.
  const barIconSize = isMobile ? 24 : LIGHTBOX_ICON_SIZE;
  const barButtonSize = isMobile ? 'xl' : 'lg';
  const surface = useSurface();
  const access = useAccessIds();

  // Personal slideshow settings. Read off the signal rather than fetched: the
  // lightbox opens constantly and these change about twice a year.
  const slideDurationMs = Math.max(1, userConfigNumber('CFG_USER_SLIDESHOW_SECONDS', DEFAULT_SLIDE_SECONDS)) * 1000;
  const kenBurns = userConfigFlag('CFG_USER_KEN_BURNS', true);
  const kenBurnsTiming = kenBurns
    ? {
      animationDuration: `${(slideDurationMs * KEN_BURNS_SLIDES) / 1000}s`,
      animationDelay: `-${slideDurationMs}ms`,
    }
    : {};

  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const neighbourPreloadRef = useRef<HTMLImageElement[]>([]);
  const slideshowFullscreenRef = useRef(false);
  const slideshowFadeTimerRef = useRef<number | undefined>(undefined);
  const slideshowFadeFrameRef = useRef<number | undefined>(undefined);
  const touchStartRef = useRef<LightboxTouchPoint | null>(null);
  // Recent one-finger positions, from which a released swipe takes its speed.
  const swipeSamplesRef = useRef<LightboxTouchPoint[]>([]);
  // Where the frames stood when the finger came down on them, mid-slide included: a drag moves
  // them on from there.
  const swipeBaseRef = useRef(0);
  // Which way a one-finger drag on the picture went once it passed the threshold; it keeps that
  // axis to the end. `sheet` is a vertical drag that moves the phone's details sheet.
  const touchAxisRef = useRef<'x' | 'y' | 'sheet' | null>(null);
  // The phone's details sheet while it is dragged or sliding; see `beginSheet`.
  const sheetRootRef = useRef<HTMLDivElement | null>(null);
  const sheetPanelRef = useRef<HTMLDivElement | null>(null);
  const infoRowRef = useRef<HTMLDivElement | null>(null);
  const sheetDragRef = useRef<{ from: number; progress: number; panelPx: number } | null>(null);
  const sheetTimerRef = useRef<number | undefined>(undefined);
  const panelTouchRef = useRef<LightboxTouchPoint | null>(null);
  // A swipe to the right on the side panel of a phone held sideways puts it away.
  const sidePanelTouchRef = useRef<{ start: LightboxTouchPoint; dragging: boolean } | null>(null);
  const swipeTimerRef = useRef<number | undefined>(undefined);
  // Zoom lives in a ref as well as state: wheel, pinch and drag handlers read the value the
  // last event left rather than the one their closure was rendered with.
  const zoomRef = useRef<ZoomState>(ZOOM_IDENTITY);
  // State as well as refs: the modal's content mounts a tick after `opened` flips, so an
  // effect keyed on the refs alone would run once against null and never again.
  const zoomBoxRef = useRef<HTMLDivElement | null>(null);
  const gestureSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [zoomBox, setZoomBox] = useState<HTMLDivElement | null>(null);
  const [gestureSurface, setGestureSurface] = useState<HTMLDivElement | null>(null);
  const lastPointerTypeRef = useRef<string>('mouse');
  const attachGestureSurface = useCallback((el: HTMLDivElement | null) => {
    gestureSurfaceRef.current = el;
    setGestureSurface(el);
  }, []);
  const attachZoomBox = useCallback((el: HTMLDivElement | null) => {
    zoomBoxRef.current = el;
    setZoomBox(el);
  }, []);

  // Opening grows the picture out of the tile that was pressed, and closing shrinks
  // it back into its tile (`lib/lightbox-tile-zoom.ts`). Once per opening: stepping to
  // the next picture is not an opening. Keyed on the path rather than the item, so a
  // refresh of the list mid-flight does not cut it short; stepping away does, through
  // the cleanup.
  const openZoomedRef = useRef(false);
  const albumMediaPath = albumMedia?.path;
  useEffect(() => {
    if (!isOpen) {
      openZoomedRef.current = false;
      return;
    }
    const item = currentMediaItem.peek();
    if (openZoomedRef.current || !zoomBox || !item) return;
    openZoomedRef.current = true;
    if (item.type !== 'photo' && item.type !== 'video') return;
    const dims = displayDims(item);
    return zoomFromTile(item.path, zoomBox, dims && dims.width / dims.height, () => mediaRef.current);
  }, [isOpen, zoomBox, albumMediaPath]);

  // The close is caught on the signal rather than in a render: a signal effect runs as
  // the index changes, while the picture is still laid out, and the lightbox renders
  // nothing at all once it is closed. Only a close that returns to a grid shrinks back —
  // not a deletion or a jump elsewhere, which clear the return path.
  useEffect(() => {
    let shown: MediaItem | null = null;
    return effect(() => {
      const item = currentMediaItem.value;
      if (item) {
        shown = item;
        return;
      }
      const closed = shown;
      shown = null;
      const box = zoomBoxRef.current;
      if (!closed || !box || (closed.type !== 'photo' && closed.type !== 'video')) return;
      if (lightboxReturnPath.peek() !== closed.path) return;
      const dims = displayDims(closed);
      zoomToTile(closed.path, sheetRootRef.current, box, dims && dims.width / dims.height, mediaRef.current);
    });
  }, []);
  const pinchRef = useRef<{ state: ZoomState; centre: ZoomPoint; distance: number } | null>(null);
  const pointerPanRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const touchPanRef = useRef<ZoomPoint | null>(null);
  const tapStartRef = useRef<TapPoint | null>(null);
  const lastTapRef = useRef<TapPoint | null>(null);
  const [zoom, setZoomState] = useState<ZoomState>(ZOOM_IDENTITY);
  const [zoomAnimating, setZoomAnimating] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hoveredFace, setHoveredFace] = useState<string | null>(null);
  const [slideshow, setSlideshow] = useState(false);
  // A presentation runs untouched, which is exactly when a phone would lock its screen.
  useWakeLock(slideshow);
  const [fullscreen, setFullscreen] = useState(false);
  const [reviewPersonId, setReviewPersonId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [loadedPhotoId, setLoadedPhotoId] = useState<string | null>(null);
  const [slideshowPhotoTransition, setSlideshowPhotoTransition] = useState<SlideshowPhotoTransition | null>(null);
  // The media a released swipe is sliding in; once it is the current media it stays centred
  // under the new frame until that has loaded.
  const [swipeTarget, setSwipeTarget] = useState<MediaItem | undefined>(undefined);
  const swipeTransitionTimerRef = useRef<number | undefined>(undefined);
  /** The width a drag measures half way against, taken when the finger lands. */
  const swipeWidthRef = useRef(0);
  /**
   * How many pictures on from the current one the bar describes (`SwipeInfo`). Read only there:
   * the lightbox itself must not render again when it changes.
   */
  const swipeInfoStep = useMemo(() => signal(0), []);
  const swipeInfoTimerRef = useRef<number | undefined>(undefined);
  const showSwipeInfo = useCallback((step: number, afterMs = 0) => {
    globalThis.clearTimeout(swipeInfoTimerRef.current);
    if (afterMs > 0) {
      swipeInfoTimerRef.current = globalThis.setTimeout(() => swipeInfoStep.value = step, afterMs);
    } else swipeInfoStep.value = step;
  }, [swipeInfoStep]);
  /** A dragged frame turns the bar to its neighbour once that fills most of the frame. */
  const followSwipeInfo = useCallback((offset: number) => {
    showSwipeInfo(Math.abs(offset) > swipeWidthRef.current / 2 ? (offset < 0 ? 1 : -1) : 0);
  }, [showSwipeInfo]);
  // Switches to the swiped-to media; run early when a new touch lands before the slide is over.
  const swipePendingRef = useRef<(() => void) | null>(null);
  /** Where the stills of a desktop step's pictures move (`stepDesktop`), beneath the shown picture. */
  const stepOutgoingRef = useRef<HTMLDivElement | null>(null);
  /** The last desktop step; a newer one replaces it, so the waits of an overtaken one do nothing. */
  const stepRef = useRef<DesktopStep | null>(null);
  /** The step that switched to the shown media, for the layout effect to take up. */
  const stepArrivalRef = useRef<DesktopStep | null>(null);
  /** The animations of the step's stills, and those of the shown picture's box. */
  const stepCopyAnimationsRef = useRef<Animation[]>([]);
  const stepBoxAnimationsRef = useRef<Animation[]>([]);
  /** When the last desktop step began: one sooner than `STEP_MS` after it cuts. */
  const lastStepAtRef = useRef(-Infinity);
  /** The half of the picture the mouse is over, whose arrow shows; null off the picture. */
  const [hoverSide, setHoverSide] = useState<'previous' | 'next' | null>(null);
  const sideClickTimerRef = useRef<number | undefined>(undefined);
  const [stackPreview, setStackPreview] = useState<MediaItem | null>(null);
  const [stackBusy, setStackBusy] = useState(false);
  const [addingFace, setAddingFace] = useState(false);
  /** A dialog of the sidebar's or the toolbar's is open over the lightbox: the keys it leaves are not the lightbox's either. */
  const [sidebarLayer, setSidebarLayer] = useState(false);
  const [toolbarLayer, setToolbarLayer] = useState(false);
  const dialogLayer = sidebarLayer || toolbarLayer;
  const [faceDraftReady, setFaceDraftReady] = useState(false);
  const [savingFace, setSavingFace] = useState(false);
  /** What the face editor last did, for the information bar; no colour for plain news. */
  const [faceMessage, setFaceMessage] = useState<{ color?: 'red' | 'orange'; text: string } | null>(null);
  /** The face whose person is being changed, by its region path. */
  const [personFacePath, setPersonFacePath] = useState<string | null>(null);
  const media = stackPreview ?? albumMedia;
  // The heart is the file's own, not a stack preview's: what is starred is what the grid shows.
  // The guest has none: favourites are kept in the reader's home.
  const mayStar = isAuthenticated.value;
  const starred = albumMedia ? starredPaths.value.has(albumMedia.path) : false;
  const toggleStar = useCallback(() => {
    if (albumMedia && mayStar) void setStarred([albumMedia.path], !starred).catch(() => {});
  }, [albumMedia, starred, mayStar]);
  useEffect(() => {
    if (mayStar) void loadStars();
  }, [mayStar]);
  // Shared with the grid behind this modal, so a rotation updates the tile too.
  const reloadToken = versionOf(media?.path ?? '');

  // One `media-details` read for the whole lightbox: the sidebar and the face overlay draw
  // from the same response, and the overlay needs it whether the sidebar is open or not.
  const detailsResult = useMediaDetails(media?.path, albumMedia?.stackAlbumPath);
  const { details, detailsPath, refetch, setOrientation, orienting, setText, setTranscript } = detailsResult;
  const canEdit = details?.ownership !== undefined && canWrite(details.ownership, access);
  // Only this file's details: straight after a swipe `details` still describes the previous one,
  // whose faces would be drawn over the new picture, and whose state would be taken for this one's,
  // until its own details arrive.
  const currentDetails = details && detailsPath === media?.path ? details : null;
  // Rotating an undecodable source would queue a re-encode of bytes ffmpeg cannot open, so the
  // buttons are not offered for one.
  const canOrient = media?.type !== 'audio' && currentDetails !== null && !currentDetails.undecodable && canEdit;
  const { person: reviewPerson, refetch: refetchReviewPerson } = useUnknownPerson(reviewPersonId ?? undefined);
  const { people: namedPeople } = usePeople(PEOPLE_ROOT, reviewPersonId !== null || personFacePath !== null);

  // A photo's boxes stand where its faces are. A video's move with them (`VideoFaces`), each on
  // its track, and the face the sidebar picks is followed (`followFace`).
  const faces = useMemo(() => media?.type === 'photo' ? toFaceMarks(currentDetails?.faces ?? []) : [], [currentDetails, media?.type]);
  const videoFaces = useMemo(
    () => media?.type === 'video' ? (currentDetails?.faces ?? []).filter((face) => face.atSeconds !== undefined) : [],
    [currentDetails, media?.type],
  );
  const faceCount = media?.type === 'video' ? videoFaces.length : faces.length;
  const [followedFacePath, setFollowedFacePath] = useState<string | null>(null);
  useEffect(() => setFollowedFacePath(null), [media?.id]);
  const followedFace = media?.type === 'video' ? currentDetails?.faces.find((face) => face.facePath === followedFacePath && face.atSeconds !== undefined) : undefined;
  const personFace = currentDetails?.faces.find((face) => face.facePath === personFacePath) ?? null;
  // The text in a photo, which the bar's text button lays over it, and the sidebar's menu opens
  // for writing, in a dialog beside the picture, to whoever may write the photo. Shown or hidden,
  // it stays so from picture to picture and from visit to visit; off until first shown.
  const pictureText = withDetails && media?.type === 'photo' ? currentDetails?.content : undefined;
  const mayWriteText = withDetails && media?.type === 'photo' && currentDetails !== null && canEdit;
  const showText = textVisible.value;
  const [editingText, setEditingText] = useState(false);
  const saveText = useCallback(async (text: string) => {
    await setText(text);
    setEditingText(false);
  }, [setText]);
  // What is said in a video or a recording, opened for correcting, beside a player of its own, to
  // whoever may write the file. One with no transcript yet gets its first lines there.
  const mayWriteSubtitles = withDetails && (media?.type === 'video' || media?.type === 'audio') && currentDetails !== null && !currentDetails.undecodable && canEdit;
  const [editingSubtitles, setEditingSubtitles] = useState(false);
  const saveSubtitles = useCallback(async (vtt: string) => {
    await setTranscript(vtt);
    setEditingSubtitles(false);
  }, [setTranscript]);
  /** A dialog over the picture has the keys: the text's or the subtitles'. */
  const editing = editingText || editingSubtitles;
  useEffect(() => {
    if (isOpen) return;
    // Opened again, it reads the details anew: other pages change files too.
    forgetMediaDetails();
    setEditingText(false);
    setEditingSubtitles(false);
  }, [isOpen]);

  // Opened by its URL alone, a file is known by its path only and shown as a picture; its
  // details say what it is, so a video or a recording gets its player.
  const detailsMimetype = currentDetails?.mimetype;
  useEffect(() => {
    if (!media || !detailsMimetype || detailsMimetype === media.mimetype || media.mimetype !== mediaItemFrom({ path: media.path }).mimetype) return;
    const known = mediaItemFrom({ path: media.path, mimetype: detailsMimetype });
    albumMediaList.value = albumMediaList.peek().map((item) => item.path === known.path ? known : item);
  }, [detailsMimetype, media]);

  // The details are read fresh after a turn, so they know which way the picture stands now; the
  // item came from a list read before it. The shrink back into the tile and the renditions asked
  // for both follow the item's shape.
  const detailsAngle = currentDetails?.angle;
  useEffect(() => {
    if (!media || detailsAngle === undefined || detailsAngle === (media.angle ?? 0)) return;
    const turned = itemAtAngle(media, detailsAngle);
    if (media === stackPreview) setStackPreview(turned);
    else albumMediaList.value = albumMediaList.peek().map((item) => item === media ? turned : item);
  }, [detailsAngle, media, stackPreview]);

  useEffect(() => {
    setStackPreview(null);
    setMapOpen(false);
    setAddingFace(false);
    setFaceDraftReady(false);
    setSavingFace(false);
    setFaceMessage(null);
    setPersonFacePath(null);
  }, [albumMedia?.id]);
  // The hovered box goes away with its photo without a mouseleave, so the next photo starts
  // with nothing hovered.
  useEffect(() => setHoveredFace(null), [media?.path]);

  // A link out of the lightbox — an album, a person — opens as the page, in the lightbox's location
  // in history: Back from the destination returns to the grid, not to a stale lightbox.
  const goTo = useCallback((path: string) => {
    endLightbox(false);
    surface.openPage(path);
  }, [surface]);

  const requestClose = useCallback(() => {
    endLightbox(true);
    surface.close();
  }, [surface]);

  const clearSlideshowPhotoTransition = useCallback(() => {
    if (slideshowFadeFrameRef.current !== undefined) {
      globalThis.cancelAnimationFrame(slideshowFadeFrameRef.current);
      slideshowFadeFrameRef.current = undefined;
    }
    if (slideshowFadeTimerRef.current !== undefined) {
      globalThis.clearTimeout(slideshowFadeTimerRef.current);
      slideshowFadeTimerRef.current = undefined;
    }
    setSlideshowPhotoTransition(null);
  }, []);

  const advanceSlideshow = useCallback(() => {
    const length = albumMediaList.value.length;
    if (length < 2) return;
    const currentIndex = currentMediaIndex.value;
    const nextIndex = nextMediaIndex(currentIndex, length);
    const current = albumMediaList.value[currentIndex];
    const next = albumMediaList.value[nextIndex];
    // The outgoing layer is a new img. Reapplying its animation class would restart the
    // Ken Burns timeline at an earlier scale and make the picture jump just before fading.
    // Freeze the exact transform currently on screen instead.
    const outgoingTransform = mediaRef.current instanceof HTMLImageElement ? globalThis.getComputedStyle(mediaRef.current).transform : 'none';
    clearSlideshowPhotoTransition();
    // Keep the outgoing still visible while the incoming one decodes. Videos and audio keep
    // their established direct hand-off because there is no second visual frame to blend.
    if (current?.type === 'photo' && next?.type === 'photo') {
      setSlideshowPhotoTransition({
        outgoing: current,
        outgoingReloadToken: versionOf(current.path),
        outgoingTransform,
        incomingId: next.id,
        started: false,
      });
    }
    currentMediaIndex.value = nextIndex;
  }, [clearSlideshowPhotoTransition]);

  const stopSlideshow = useCallback(() => {
    setSlideshow(false);
    clearSlideshowPhotoTransition();
    if (slideshowFullscreenRef.current && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    slideshowFullscreenRef.current = false;
  }, [clearSlideshowPhotoTransition]);

  const startSlideshow = useCallback(() => {
    setStackPreview(null);
    setSlideshow(true);
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      slideshowFullscreenRef.current = true;
      void document.documentElement.requestFullscreen().catch(() => {
        // Fullscreen can be denied by browser policy; slideshow remains useful.
        slideshowFullscreenRef.current = false;
      });
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  const handleEscape = useCallback(() => {
    // This dialog is layered above the lightbox. Close only it, leaving the
    // media and its single history entry untouched.
    if (mapOpen) {
      setMapOpen(false);
      return;
    }
    if (editingText) {
      setEditingText(false);
      return;
    }
    // The subtitle editor owns Escape: it asks before throwing away changes.
    if (editingSubtitles) return;
    // The unknown-person review dialog is layered above this modal and owns
    // Escape while it is open. Let its capture handler close only that layer.
    if (reviewPersonId) return;
    // So does a dialog the sidebar or the toolbar opened, the edit or the sharing dialog.
    if (dialogLayer) return;
    if (addingFace) {
      setAddingFace(false);
      setFaceDraftReady(false);
      setFaceMessage(null);
      return;
    }
    if (slideshow) stopSlideshow();
    else requestClose();
  }, [addingFace, editingSubtitles, editingText, mapOpen, requestClose, reviewPersonId, dialogLayer, slideshow, stopSlideshow]);

  // Mounted with the lightbox's route, already open: that is an opening too.
  const infoPreviousOpenRef = useRef(false);
  useLayoutEffect(() => {
    const wasOpen = infoPreviousOpenRef.current;
    infoPreviousOpenRef.current = isOpen;
    if (!wasOpen && isOpen) infoSidebarOpen.value = !isMobile && withDetails;
  }, [isMobile, isOpen, withDetails]);

  useEffect(() => {
    if (!isOpen) {
      if (slideshow) stopSlideshow();
      if (reviewPersonId) setReviewPersonId(null);
      if (addingFace) setAddingFace(false);
      setFaceDraftReady(false);
      setPersonFacePath(null);
    }
  }, [addingFace, isOpen, reviewPersonId, slideshow, stopSlideshow]);

  useEffect(() => () => {
    if (swipeTimerRef.current !== undefined) globalThis.clearTimeout(swipeTimerRef.current);
    if (slideshowFadeFrameRef.current !== undefined) globalThis.cancelAnimationFrame(slideshowFadeFrameRef.current);
    if (slideshowFadeTimerRef.current !== undefined) globalThis.clearTimeout(slideshowFadeTimerRef.current);
  }, []);

  // Browser Escape exits fullscreen before application key handlers see it.
  // Treat that fullscreen transition as the same request to stop slideshow.
  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
      if (slideshow && slideshowFullscreenRef.current && !document.fullscreenElement) {
        slideshowFullscreenRef.current = false;
        setSlideshow(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [slideshow]);

  // A touch screen turned sideways over the lightbox goes fullscreen, and turned upright again leaves the
  // fullscreen the turn asked for, as does closing the lightbox. The request is made inside the
  // orientation's change event, the one place a browser grants it without a tap; one that refuses
  // (an iPhone has no fullscreen for a page) leaves the lightbox as it is.
  const rotateFullscreenRef = useRef(false);
  useEffect(() => {
    const orientation = screen.orientation;
    if (!isOpen || !isCoarse || !orientation) return;
    const onOrientationChange = () => {
      if (orientation.type.startsWith('landscape')) {
        if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
        rotateFullscreenRef.current = true;
        void document.documentElement.requestFullscreen().catch(() => {
          rotateFullscreenRef.current = false;
        });
      } else if (rotateFullscreenRef.current) {
        rotateFullscreenRef.current = false;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      }
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) rotateFullscreenRef.current = false;
    };
    orientation.addEventListener('change', onOrientationChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      orientation.removeEventListener('change', onOrientationChange);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (rotateFullscreenRef.current && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
      rotateFullscreenRef.current = false;
    };
  }, [isOpen, isCoarse]);

  // Still images get a fixed dwell time. Audio and video advance on their
  // ended event so a long recording is never cut off after one slide's time.
  useEffect(() => {
    if (!slideshow || media?.type !== 'photo' || loadedPhotoId !== media.id) return;
    const timer = globalThis.setTimeout(advanceSlideshow, slideDurationMs);
    return () => globalThis.clearTimeout(timer);
  }, [advanceSlideshow, loadedPhotoId, media?.id, media?.type, slideDurationMs, slideshow]);

  // Warm the browser cache with the pictures a run of swipes or arrow presses reaches next, and
  // the details cache with their details,
  // `PRELOAD_DEPTH` on each side, nearest first and `PRELOAD_PARALLEL` at a time; those already
  // passed on the way are in the cache and come back at once. It waits for the current photo so
  // the visible picture never competes with invisible ones; a slideshow's dwell timer still
  // starts from the next slide's own load event, so a slow network never spends the dwell on an
  // invisible image.
  useEffect(() => {
    const list = albumMediaList.value;
    if (!media || list.length < 2) return;
    if (media.type === 'photo' && loadedPhotoId !== media.id) return;
    const index = currentMediaIndex.value;
    const queue: MediaItem[] = [];
    for (let step = 1; step <= PRELOAD_DEPTH; step++) {
      for (const at of [index + step, index - step]) {
        // Navigation goes round the list, and so does what is fetched for it.
        const item = list[((at % list.length) + list.length) % list.length];
        if (item.id !== media.id && !queue.includes(item)) queue.push(item);
      }
    }
    let stopped = false;
    const loading: HTMLImageElement[] = [];
    neighbourPreloadRef.current = loading;
    const loadNext = () => {
      while (!stopped && queue.length > 0) {
        const item = queue.shift()!;
        // Its details too, so the place, the faces and the panel come with the picture.
        prefetchMediaDetails(item.path, item.stackAlbumPath);
        const image = preloadPicture(item, loadNext);
        if (image) {
          loading.push(image);
          return;
        }
      }
    };
    for (let i = 0; i < PRELOAD_PARALLEL; i++) loadNext();
    // Moving on starts no more of these; those on the way still arrive, mostly for the next one.
    return () => {
      stopped = true;
    };
  }, [loadedPhotoId, media?.id, media?.type]);

  // Hotkeys remain available while presenting. A direct navigation interrupts the automatic
  // transition rather than reviving its outgoing frame on a later slide.
  useEffect(() => {
    if (slideshowPhotoTransition && slideshowPhotoTransition.incomingId !== media?.id) {
      clearSlideshowPhotoTransition();
    }
  }, [clearSlideshowPhotoTransition, media?.id, slideshowPhotoTransition]);

  const handleSlideshowPhotoLoad = useCallback((photoId: string) => {
    setLoadedPhotoId(photoId);
    if (slideshowPhotoTransition?.incomingId !== photoId) return;

    if (slideshowFadeFrameRef.current !== undefined) globalThis.cancelAnimationFrame(slideshowFadeFrameRef.current);
    if (slideshowFadeTimerRef.current !== undefined) globalThis.clearTimeout(slideshowFadeTimerRef.current);
    // Let the incoming image paint at opacity zero once before changing it, otherwise a cached
    // preload can collapse the two opacity states into a direct switch.
    slideshowFadeFrameRef.current = globalThis.requestAnimationFrame(() => {
      slideshowFadeFrameRef.current = undefined;
      setSlideshowPhotoTransition((transition) => {
        if (transition?.incomingId !== photoId) return transition;
        return { ...transition, started: true };
      });
      slideshowFadeTimerRef.current = globalThis.setTimeout(() => {
        slideshowFadeTimerRef.current = undefined;
        setSlideshowPhotoTransition((transition) => transition?.incomingId === photoId ? null : transition);
      }, SLIDE_CROSSFADE_DURATION_MS);
    });
  }, [slideshowPhotoTransition?.incomingId]);

  const handleSlideshowPhotoError = useCallback((photoId: string) => {
    setLoadedPhotoId(photoId);
    if (slideshowPhotoTransition?.incomingId === photoId) {
      clearSlideshowPhotoTransition();
    }
  }, [clearSlideshowPhotoTransition, slideshowPhotoTransition?.incomingId]);

  const nameReviewedPerson = useCallback(async (personPath: string, name: string) => {
    const result = await execCommand<{ path: string }>(`person-name ${shq(personPath)} --name ${shq(name)}`);
    await refetch();
    return result.path;
  }, [refetch]);

  const mergeReviewedPerson = useCallback(async (sourcePath: string, destinationPath: string) => {
    await execCommand(`person-merge ${shq(sourcePath)} ${shq(destinationPath)}`);
    await refetch();
  }, [refetch]);

  const discardReviewedPerson = useCallback(async (personPath: string) => {
    await execCommand(`person-discard ${shq(personPath)}`);
    await refetch();
  }, [refetch]);

  const createFace = useCallback(async (box: { x: number; y: number; width: number; height: number }) => {
    if (!media || (media.type !== 'photo' && media.type !== 'video')) return;
    // A box on a video is of the frame on screen.
    const video = mediaRef.current;
    const at = media.type === 'video' ? (video instanceof HTMLVideoElement ? video.currentTime : undefined) : undefined;
    if (media.type === 'video' && at === undefined) return;
    setSavingFace(true);
    setFaceMessage(null);
    try {
      const encoded = [box.x, box.y, box.width, box.height].map((value) => value.toFixed(6)).join(',');
      const atFlag = at !== undefined ? ` --at ${at.toFixed(3)}` : '';
      const result = await execCommand<FaceAddResult>(`face-add ${shq(media.path)} --box ${encoded}${atFlag}`);
      await refetch();
      setAddingFace(false);
      setFaceDraftReady(false);
      if (result.cropError) {
        setFaceMessage({ color: 'orange', text: 'Face added; its preview crop still needs regeneration.' });
      }
      // The established review dialog already owns both follow-up choices: give the person a
      // name, or merge this one-face unknown into somebody who already exists.
      setReviewPersonId(result.personId);
    } catch (error) {
      setFaceMessage({ color: 'red', text: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      setSavingFace(false);
    }
  }, [media, refetch]);

  const updateFace = useCallback(async (facePath: string, box: { x: number; y: number; width: number; height: number }) => {
    setSavingFace(true);
    setFaceMessage(null);
    try {
      const encoded = [box.x, box.y, box.width, box.height].map((value) => value.toFixed(6)).join(',');
      const result = await execCommand<{ cropError?: string }>(`face-set-box ${shq(facePath)} --box ${encoded}`);
      bumpDerivativeVersion(facePath);
      await refetch();
      if (result.cropError) {
        setFaceMessage({ color: 'orange', text: 'Face box updated; its preview crop still needs regeneration.' });
      }
    } catch (error) {
      setFaceMessage({ color: 'red', text: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      setSavingFace(false);
    }
  }, [refetch]);

  const removeFace = useCallback(async (facePath: string) => {
    setSavingFace(true);
    setFaceMessage(null);
    try {
      await execCommand(`face-remove ${shq(facePath)}`);
      await refetch();
    } catch (error) {
      setFaceMessage({ color: 'red', text: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      setSavingFace(false);
    }
  }, [refetch]);

  const facePersonChanged = useCallback(async (change: FacePersonChange) => {
    setFaceMessage(null);
    await refetch();
    if (change.kind === 'new-person') {
      // Named in the review dialog, as a face drawn by hand is.
      setReviewPersonId(change.personId);
    } else if (change.kind === 'rematch') {
      const person = change.person;
      setFaceMessage({
        text: !person
          ? 'Recognition left the face unassigned: too small or unclear to start a new person.'
          : person.unnamed
          ? 'Recognition made the face a new unidentified person.'
          : `Recognition matched the face to ${person.name}.`,
      });
    }
  }, [refetch]);

  const turn = useCallback(async (change: Parameters<typeof setOrientation>[0]) => {
    await setOrientation(change);
    if (media) {
      // Every rendition of this file has been rewritten under a URL that has not changed,
      // and renditions are cached for an hour — so the bump is what makes both this
      // modal and the grid behind it ask again.
      bumpDerivativeVersion(media.path);
      // A quarter turn swaps the display frame's axes, so the aspect the grid measured is wrong.
      forgetAspect(media.path);
    }
  }, [setOrientation, media]);

  const previewStackMember = useCallback((member: StackMemberRef) => {
    setStackPreview(mediaItemFrom(member));
  }, []);

  const mutateStack = useCallback(async (action: 'front' | 'separate' | 'allow', member: StackMemberRef) => {
    const albumPath = details?.albumStack?.albumPath ?? albumMedia?.stackAlbumPath;
    if (!albumPath) return;
    setStackBusy(true);
    try {
      const result = await execCommand<{ focusPath: string }>(`album-stack ${action} ${shq(albumPath)} ${shq(member.path)}`);
      if (action === 'front' || action === 'separate') setStackPreview(mediaItemFrom(member));
      requestAlbumMediaRefresh(albumPath, result.focusPath);
      await refetch();
    } finally {
      setStackBusy(false);
    }
  }, [albumMedia?.stackAlbumPath, details?.albumStack?.albumPath, refetch]);

  // A photo and a video's picture zoom; the slideshow is already moving the picture itself, and
  // a video that cannot be played has only its message to show.
  const zoomable = (media?.type === 'photo' || (media?.type === 'video' && !currentDetails?.undecodable)) && !slideshow;

  const setZoom = useCallback((next: ZoomState, animate: boolean) => {
    zoomRef.current = next;
    setZoomAnimating(animate);
    setZoomState(next);
  }, []);

  /** The transformed box and the contained picture inside it, both at scale 1. */
  const zoomFrame = useCallback((): ZoomFrame => {
    const box = zoomBoxRef.current;
    const viewport = { width: box?.offsetWidth ?? globalThis.innerWidth, height: box?.offsetHeight ?? globalThis.innerHeight };
    const picture = mediaRef.current;
    const width = picture instanceof HTMLVideoElement ? picture.videoWidth : picture?.naturalWidth ?? 0;
    const height = picture instanceof HTMLVideoElement ? picture.videoHeight : picture?.naturalHeight ?? 0;
    if (picture && width > 0 && height > 0) {
      const scale = Math.min(picture.clientWidth / width, picture.clientHeight / height);
      if (scale > 0) return { viewport, content: { width: width * scale, height: height * scale } };
    }
    return { viewport, content: viewport };
  }, []);

  /** A client-coordinate point relative to the untransformed centre of the zoom box. */
  const zoomFocal = useCallback((clientX: number, clientY: number): ZoomPoint => {
    const surface = gestureSurfaceRef.current;
    const box = zoomBoxRef.current;
    if (!surface || !box) return { x: 0, y: 0 };
    // The box is the element being transformed, so its own bounding rect moves with the zoom;
    // its offset within the untransformed surface does not.
    const bounds = surface.getBoundingClientRect();
    return {
      x: clientX - (bounds.left + box.offsetLeft + box.offsetWidth / 2),
      y: clientY - (bounds.top + box.offsetTop + box.offsetHeight / 2),
    };
  }, []);

  const isGestureControl = (target: EventTarget | null) => target instanceof Element && target.closest(GESTURE_CONTROL_SELECTOR) !== null;

  // A new picture starts at fit. So does leaving the zoomable state, which is what makes a
  // slideshow started while zoomed in begin from the whole frame.
  useLayoutEffect(() => {
    pinchRef.current = null;
    pointerPanRef.current = null;
    touchPanRef.current = null;
    setPanning(false);
    setZoom(ZOOM_IDENTITY, false);
  }, [media?.id, setZoom, zoomable]);

  // Opening the sidebar or turning the phone resizes the box; a picture panned to an edge
  // would otherwise be left showing a gap on the far side.
  useEffect(() => {
    if (!zoomBox || !zoomable) return;
    const observer = new ResizeObserver(() => {
      if (isZoomed(zoomRef.current)) setZoom(panZoom(zoomRef.current, 0, 0, zoomFrame()), false);
    });
    observer.observe(zoomBox);
    return () => observer.disconnect();
  }, [setZoom, zoomBox, zoomFrame, zoomable]);

  // Native rather than React's `onWheel`: React registers wheel passively, and the default
  // here (scrolling the modal body, or ctrl+wheel zooming the whole page) must be stopped.
  useEffect(() => {
    if (!gestureSurface || !zoomable) return;
    // A face hit-box is only a hover target; the text laid over the picture is the one thing
    // inside the surface that scrolls, and the wheel scrolls it rather than zooming.
    // A video's controls are left the wheel too.
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-video-controls]')) return;
      if (!event.ctrlKey && event.target instanceof Element && event.target.closest('[data-text-overlay]')) return;
      event.preventDefault();
      const current = zoomRef.current;
      setZoom(zoomAt(current, zoomFocal(event.clientX, event.clientY), wheelZoomScale(current.scale, event.deltaY), zoomFrame()), false);
    };
    gestureSurface.addEventListener('wheel', onWheel, { passive: false });
    return () => gestureSurface.removeEventListener('wheel', onWheel);
  }, [gestureSurface, setZoom, zoomFocal, zoomFrame, zoomable]);

  const resetZoom = useCallback(() => setZoom(ZOOM_IDENTITY, true), [setZoom]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    globalThis.clearTimeout(sideClickTimerRef.current);
    // Two taps arrive here too, as the browser's synthesized dblclick, after the touch
    // handler has already toggled on them; acting twice would undo it. A video's double-click
    // is its player's: fullscreen.
    if (!zoomable || media?.type === 'video' || lastPointerTypeRef.current === 'touch' || isGestureControl(event.target)) return;
    event.preventDefault();
    setZoom(toggleZoom(zoomRef.current, zoomFocal(event.clientX, event.clientY), zoomFrame()), true);
  }, [media?.type, setZoom, zoomFocal, zoomFrame, zoomable]);

  // Mouse and pen drag the zoomed picture around. Touch is left to the touch handlers below,
  // which have to tell a pan from a swipe and a pinch.
  const handlePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    lastPointerTypeRef.current = event.pointerType;
    if (event.pointerType === 'touch' || event.button !== 0) return;
    if (!zoomable || !isZoomed(zoomRef.current) || isGestureControl(event.target)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerPanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
  }, [zoomable]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const pan = pointerPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    pan.x = event.clientX;
    pan.y = event.clientY;
    setZoom(panZoom(zoomRef.current, dx, dy, zoomFrame()), false);
  }, [setZoom, zoomFrame]);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    const pan = pointerPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    pointerPanRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  /**
   * Previous/next moves the frame and its neighbours through CSS variables on the gesture
   * surface rather than through state, so following the finger re-renders nothing. Without a
   * transition the frames jump to `offset`, which is what a drag wants; with one they slide there
   * and the frame's own zoom transition applies again afterwards.
   */
  const moveSwipe = useCallback((offset: number, transition?: { durationMs: number; easing: string }) => {
    const surface = gestureSurfaceRef.current;
    if (!surface) return;
    globalThis.clearTimeout(swipeTransitionTimerRef.current);
    surface.style.setProperty('--swipe-transition', transition ? `transform ${transition.durationMs}ms ${transition.easing}` : 'none');
    surface.style.setProperty('--swipe-x', `${offset}px`);
    if (offset !== 0) surface.style.setProperty('--swipe-side', offset < 0 ? '1' : '-1');
    if (transition) {
      swipeTransitionTimerRef.current = globalThis.setTimeout(() => surface.style.removeProperty('--swipe-transition'), transition.durationMs + 50);
    }
  }, []);

  /**
   * How far apart the frame and its neighbours sit: the width of the surface they slide across,
   * which on a desktop is the window less the side panel, and a small gap.
   */
  const swipeFrameWidth = () => (gestureSurfaceRef.current?.clientWidth ?? globalThis.innerWidth) + SWIPE_FRAME_GAP_PX;

  /** How far along the swipe the frame stands this moment, a running slide included, in px. */
  const swipeOffsetNow = () => {
    const box = zoomBoxRef.current;
    const transform = box ? getComputedStyle(box).transform : 'none';
    const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
    return Math.abs(offset) < 0.5 ? 0 : offset;
  };

  const resetSwipe = useCallback(() => {
    globalThis.clearTimeout(swipeTransitionTimerRef.current);
    const surface = gestureSurfaceRef.current;
    surface?.style.removeProperty('--swipe-transition');
    surface?.style.removeProperty('--swipe-x');
    showSwipeInfo(0);
  }, [showSwipeInfo]);

  // Any change of media, a finished swipe included, starts the new frame centred. A layout
  // effect, so the frame is moved back in the same paint that first shows the new media.
  useLayoutEffect(() => resetSwipe(), [media?.id, resetSwipe]);

  // The viewer has stopped on the picture once it has been shown for `LIGHTBOX_REST_MS` with no step
  // and no finger on it. What can wait for that waits: the route moving to it
  // (`lightboxRestedPath`), and a phone's closed details panel, which is kept mounted (see the
  // panel below) and whose drawing is most of what a step to the next picture costs. Closed, the
  // panel draws the picture the viewer stops on, so a run of swipes draws none of those it passes;
  // open, or starting to move, it draws the current one at once.
  const [detailsMediaId, setDetailsMediaId] = useState<string | null>(null);
  const mediaId = media?.id ?? null;
  if (sidebarOpen && detailsMediaId !== mediaId) setDetailsMediaId(mediaId);
  const detailsCurrent = detailsMediaId === mediaId;
  useEffect(() => {
    if (!mediaId) return;
    let timer: number | undefined;
    const rest = () => {
      if (touchStartRef.current || swipePendingRef.current) {
        timer = globalThis.setTimeout(rest, LIGHTBOX_REST_MS);
        return;
      }
      lightboxRestedPath.value = currentMediaItem.peek()?.path ?? null;
      startTransition(() => setDetailsMediaId(mediaId));
    };
    timer = globalThis.setTimeout(rest, LIGHTBOX_REST_MS);
    return () => {
      globalThis.clearTimeout(timer);
      lightboxRestedPath.value = null;
    };
  }, [mediaId]);
  const undrawnDetailsRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    undrawnDetailsRef.current = detailsCurrent ? null : mediaId;
  });
  /** The details last drawn, shown as they are while a run of swipes passes. */
  const drawnDetailsRef = useRef<ReactNode>(null);

  const clearSheet = useCallback(() => {
    globalThis.clearTimeout(sheetTimerRef.current);
    sheetDragRef.current = null;
    const root = sheetRootRef.current;
    for (const name of SHEET_VARIABLES) root?.style.removeProperty(name);
  }, []);

  /**
   * Starts moving a phone's details panel, `progress` 0 closed and 1 open: upright it is a sheet
   * over the bottom half, sideways a panel over the right.
   *
   * Animating the real layout (the viewer's size, the panel's) would re-lay-out the details
   * and re-fit the picture every frame. Instead, while the panel moves the viewer keeps its
   * closed layout and CSS variables on the lightbox root slide the panel in, the info row and
   * date along with it, and shift and shrink the picture to where the open layout puts it; at
   * rest the variables are removed and the real layout, which those transforms reproduce at
   * either end, takes over. A panel that has not drawn the picture shown draws it first.
   */
  const beginSheet = useCallback((progress: number): boolean => {
    const root = sheetRootRef.current;
    const panel = sheetPanelRef.current;
    const info = infoRowRef.current;
    if (!root || !panel || !info) return false;
    const undrawn = undrawnDetailsRef.current;
    if (undrawn) flushSync(() => setDetailsMediaId(undrawn));
    globalThis.clearTimeout(sheetTimerRef.current);
    const upright = mobilePortrait;
    const panelPx = upright ? panel.offsetHeight : panel.offsetWidth;
    const closed = { width: root.clientWidth, height: root.clientHeight - info.offsetHeight };
    const open = upright ? { width: closed.width, height: closed.height - panelPx } : { width: closed.width - panelPx, height: closed.height };
    const el = mediaRef.current;
    const intrinsic = el instanceof HTMLImageElement
      ? { width: el.naturalWidth, height: el.naturalHeight }
      : el instanceof HTMLVideoElement
      ? { width: el.videoWidth, height: el.videoHeight }
      : null;
    // The picture is contained in the surface, so its size is the contain fit of the surface.
    const fit = (box: { width: number; height: number }) =>
      intrinsic && intrinsic.width > 0 && intrinsic.height > 0 ? Math.min(box.width / intrinsic.width, box.height / intrinsic.height) : 1;
    root.style.setProperty(upright ? '--sheet-viewer-h' : '--sheet-viewer-w', '100%');
    root.style.setProperty('--sheet-dx', `${(open.width - closed.width) / 2}px`);
    root.style.setProperty('--sheet-dy', `${(open.height - closed.height) / 2}px`);
    root.style.setProperty('--sheet-ds', String(fit(open) / fit(closed) - 1));
    // The date is centred over what a side panel leaves; the info row sits on top of an upright
    // sheet and spans what a side panel leaves.
    root.style.setProperty('--sheet-ix', `${upright ? 0 : -panelPx / 2}px`);
    root.style.setProperty('--sheet-iy', `${upright ? -panelPx : 0}px`);
    root.style.setProperty('--sheet-iw', `${upright ? 0 : panelPx}px`);
    root.style.setProperty('--sheet-transition', 'none');
    root.style.setProperty('--sheet-p', String(progress));
    sheetDragRef.current = { from: progress, progress, panelPx };
    return true;
  }, [mobilePortrait]);

  const moveSheet = useCallback((progress: number, transition?: { durationMs: number; easing: string }) => {
    const root = sheetRootRef.current;
    const drag = sheetDragRef.current;
    if (!root || !drag) return;
    drag.progress = Math.min(1, Math.max(0, progress));
    root.style.setProperty(
      '--sheet-transition',
      transition ? `transform ${transition.durationMs}ms ${transition.easing}, width ${transition.durationMs}ms ${transition.easing}` : 'none',
    );
    root.style.setProperty('--sheet-p', String(drag.progress));
  }, []);

  const slideSheet = useCallback((open: boolean, finish: { durationMs: number; easing: string }) => {
    moveSheet(open ? 1 : 0, finish);
    infoSidebarOpen.value = open;
    sheetTimerRef.current = globalThis.setTimeout(clearSheet, finish.durationMs + 20);
  }, [clearSheet, moveSheet]);

  /**
   * Lets go of the panel: it slides on at the finger's speed to whichever end it was going.
   * `velocity` is the finger's speed along the panel's axis, negative towards open.
   */
  const endSheet = useCallback((velocity: number) => {
    const drag = sheetDragRef.current;
    if (!drag) return;
    const open = lightboxSheetOpens(drag.progress, velocity);
    slideSheet(open, lightboxSwipeFinish(Math.abs((open ? 1 : 0) - drag.progress) * drag.panelPx, open ? -velocity : velocity));
  }, [slideSheet]);

  /** Opens or closes the details, sliding a phone's panel rather than switching it. */
  const toggleSheet = useCallback((open: boolean) => {
    if (!withDetails || open === infoSidebarOpen.value) return;
    if (!isMobile || slideshow || !beginSheet(open ? 0 : 1)) {
      infoSidebarOpen.value = open;
      return;
    }
    // Lay out the starting position before the slide, or the transition would start from the
    // real layout the variables have just replaced.
    void sheetRootRef.current?.offsetHeight;
    slideSheet(open, { durationMs: SHEET_TOGGLE_MS, easing: SWIPE_SETTLE_EASING });
  }, [beginSheet, isMobile, slideSheet, slideshow, withDetails]);

  useEffect(() => () => globalThis.clearTimeout(sheetTimerRef.current), []);

  // Swiping the sheet down closes it, from anywhere on it while its content is scrolled to the top.
  const handlePanelTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    panelTouchRef.current = null;
    if (event.touches.length !== 1 || !infoSidebarOpen.value) return;
    const scroller = event.currentTarget.querySelector('[data-media-sidebar]');
    if (scroller && scroller.scrollTop > 0) return;
    const touch = event.touches[0];
    panelTouchRef.current = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    swipeSamplesRef.current = [panelTouchRef.current];
  }, []);

  const handlePanelTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const start = panelTouchRef.current;
    if (!start || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const samples = swipeSamplesRef.current;
    samples.push({ x: touch.clientX, y: touch.clientY, time: event.timeStamp });
    if (samples.length > 16) samples.shift();
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!sheetDragRef.current) {
      if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) return;
      // Anything but a downward drag is the content's own scrolling.
      if (!(dy > 0 && dy > Math.abs(dx) * 1.2) || !beginSheet(1)) {
        panelTouchRef.current = null;
        return;
      }
    }
    moveSheet(1 - dy / sheetDragRef.current!.panelPx);
  }, [beginSheet, moveSheet]);

  const handlePanelTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    const start = panelTouchRef.current;
    panelTouchRef.current = null;
    if (!start || !sheetDragRef.current || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    endSheet(releaseVelocityY(swipeSamplesRef.current, { x: touch.clientX, y: touch.clientY, time: event.timeStamp }));
  }, [endSheet]);

  // A phone held sideways has the details beside the picture: a swipe to the right on the panel
  // slides it away with the finger.
  const handleSidePanelTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    sidePanelTouchRef.current = null;
    if (event.touches.length !== 1 || !infoSidebarOpen.value) return;
    const panel = event.currentTarget;
    // A map pans and a strip of thumbnails scrolls sideways; a drag on those is theirs.
    for (let el = event.target instanceof Element ? event.target : null; el && el !== panel; el = el.parentElement) {
      if (el.matches('.leaflet-container, input, textarea')) return;
      const overflowX = getComputedStyle(el).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return;
    }
    const touch = event.touches[0];
    sidePanelTouchRef.current = { start: { x: touch.clientX, y: touch.clientY, time: event.timeStamp }, dragging: false };
    swipeSamplesRef.current = [sidePanelTouchRef.current.start];
  }, []);

  const handleSidePanelTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const touch = sidePanelTouchRef.current;
    if (!touch || event.touches.length !== 1) return;
    const point = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: event.timeStamp };
    const samples = swipeSamplesRef.current;
    samples.push(point);
    if (samples.length > 16) samples.shift();
    const dx = point.x - touch.start.x;
    const dy = point.y - touch.start.y;
    if (!touch.dragging) {
      if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) return;
      // Anything but a drag to the right is the content's own scrolling.
      if (!(dx > 0 && dx > Math.abs(dy) * 1.2) || !beginSheet(1)) {
        sidePanelTouchRef.current = null;
        return;
      }
      touch.dragging = true;
    }
    moveSheet(1 - dx / sheetDragRef.current!.panelPx);
  }, [beginSheet, moveSheet]);

  const handleSidePanelTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    const touch = sidePanelTouchRef.current;
    sidePanelTouchRef.current = null;
    if (!touch?.dragging) return;
    const changed = event.changedTouches[0];
    const end = { x: changed?.clientX ?? touch.start.x, y: changed?.clientY ?? touch.start.y, time: event.timeStamp };
    // To the right closes, which is the positive direction on this axis.
    endSheet(releaseVelocityX(swipeSamplesRef.current, end));
  }, [endSheet]);

  const settleSwipe = useCallback(() => {
    moveSwipe(0, { durationMs: SWIPE_ANIMATION_MS, easing: SWIPE_SETTLE_EASING });
    showSwipeInfo(0);
  }, [moveSwipe, showSwipeInfo]);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    touchStartRef.current = null;
    touchPanRef.current = null;
    tapStartRef.current = null;
    touchAxisRef.current = null;
    // A second finger while the sheet is held lets it go where it is heading.
    if (sheetDragRef.current && event.touches.length > 1) endSheet(0);
    if (swipePendingRef.current) {
      // A finger on a picture still sliding in switches to it now, and takes it where it is (below).
      globalThis.clearTimeout(swipeTimerRef.current);
      swipePendingRef.current();
    }
    // Drawing a face box takes the finger for itself.
    if (!isMobile || slideshow || addingFace) return;
    // A pinned face box is tapped to open it but is no reason to refuse a drag across the picture;
    // group photos are mostly faces.
    const onFaceLink = event.target instanceof Element && event.target.closest('[data-face-link]') !== null;
    // A video's picture swipes like a photo; its controls are controls (`data-video-controls`).
    if (isGestureControl(event.target) && !onFaceLink) return;

    if (event.touches.length === 2 && zoomable) {
      // A second finger during a swipe turns it into a pinch; drop the swipe where it is.
      resetSwipe();
      const [a, b] = [event.touches[0], event.touches[1]];
      const geometry = pinchGeometry(zoomFocal(a.clientX, a.clientY), zoomFocal(b.clientX, b.clientY));
      pinchRef.current = { state: zoomRef.current, ...geometry };
      return;
    }
    pinchRef.current = null;
    if (event.touches.length !== 1) {
      // A second finger on a picture the first one holds lets it go.
      if (swipeBaseRef.current !== 0) settleSwipe();
      swipeBaseRef.current = 0;
      return;
    }

    const touch = event.touches[0];
    // Leave the screen edges to the browser/OS so its native Back gesture can close
    // the history-backed lightbox instead of being mistaken for previous/next media,
    // or for a pan.
    if (touch.clientX <= NATIVE_EDGE_GESTURE_PX || touch.clientX >= globalThis.innerWidth - NATIVE_EDGE_GESTURE_PX) return;
    if (!onFaceLink) tapStartRef.current = touchPoint(touch, event.timeStamp);
    if (zoomable && isZoomed(zoomRef.current)) {
      // One finger on a zoomed picture drags it; previous/next wait until it is back at fit.
      touchPanRef.current = { x: touch.clientX, y: touch.clientY };
      return;
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    swipeSamplesRef.current = [touchStartRef.current];
    // A finger that lands on a moving picture, sliding in or settling back, holds it where it is.
    swipeBaseRef.current = swipeOffsetNow();
    // Measured once here: a layout read on every move would force a layout per frame.
    swipeWidthRef.current = swipeFrameWidth();
    if (swipeBaseRef.current !== 0) moveSwipe(swipeBaseRef.current);
    followSwipeInfo(swipeBaseRef.current);
  }, [addingFace, endSheet, followSwipeInfo, isMobile, moveSwipe, resetSwipe, settleSwipe, slideshow, zoomFocal, zoomable]);

  const finishPhotoSwipe = useCallback((
    action: Extract<ReturnType<typeof lightboxSwipeAction>, 'next' | 'previous'>,
    releaseOffset: number,
    releaseVelocity: number,
  ) => {
    const canMove = action === 'next' ? hasNextMedia.value : hasPrevMedia.value;
    if (!canMove) {
      settleSwipe();
      return;
    }

    const direction = action === 'next' ? -1 : 1;
    const targetIndex = action === 'next'
      ? nextMediaIndex(currentMediaIndex.value, albumMediaList.value.length)
      : prevMediaIndex(currentMediaIndex.value, albumMediaList.value.length);
    const target = albumMediaList.value[targetIndex];
    if (!target) {
      settleSwipe();
      return;
    }

    // The slide carries on at the speed the finger let go with, over what is left of the way,
    // and ends with the incoming neighbour exactly centred. Nothing renders until the handover a
    // few pixels from the end: a render here would hold the slide's first frame back by as long
    // as it takes.
    const travel = direction * swipeFrameWidth();
    const finish = lightboxSwipeFinish(Math.abs(travel) - Math.abs(releaseOffset), releaseVelocity * direction);
    const startedAt = performance.now();
    moveSwipe(travel, finish);
    // The bar turns to the incoming picture as it passes half way, by the slide's own curve.
    let halfWayMs = 0;
    while (halfWayMs < finish.handoverMs && finish.leftAt(halfWayMs) > Math.abs(travel) / 2) halfWayMs++;
    showSwipeInfo(-direction, halfWayMs);
    const complete = () => {
      swipePendingRef.current = null;
      // Hold the frames where the slide has got to, so nothing slides while the switch renders
      // them again. One render both marks the incoming preview as the new frame's handoff and
      // switches to its media, so its element is kept rather than remounted; the switch recentres
      // the frames on the new media (`resetSwipe`), above the preview, which stays until the
      // frame has loaded.
      moveSwipe(travel - direction * finish.leftAt(performance.now() - startedAt));
      flushSync(() => {
        showSwipeInfo(0);
        setSwipeTarget(target);
        if (action === 'next') goToNextMedia();
        else goToPrevMedia();
      });
      // What is left of the slide eases in on the new frame, from where the old one had got to by
      // now. The start is laid out first, or the transition would run from the centre.
      const rest = finish.restFrom(performance.now() - startedAt);
      if (rest.leftPx <= 0) return;
      moveSwipe(-direction * rest.leftPx);
      void gestureSurfaceRef.current?.offsetWidth;
      moveSwipe(0, rest);
    };
    swipePendingRef.current = complete;
    swipeTimerRef.current = globalThis.setTimeout(complete, finish.handoverMs);
  }, [moveSwipe, settleSwipe, showSwipeInfo]);

  /**
   * Where `contain` draws a picture in `box`: by the picture's own size once it has loaded, else
   * the file's, so a picture not yet loaded is not taken for the whole box.
   */
  const drawnRect = (box: StepRect, picture: HTMLImageElement | HTMLVideoElement | null, item: MediaItem | null): StepRect => {
    const own = picture instanceof HTMLVideoElement
      ? { width: picture.videoWidth, height: picture.videoHeight }
      : picture
      ? { width: picture.naturalWidth, height: picture.naturalHeight }
      : null;
    const pixels = own && own.width > 0 && own.height > 0 ? own : item && (item.type === 'photo' || item.type === 'video') ? displayDims(item) : undefined;
    if (!pixels) return box;
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    const fit = Math.min(width / pixels.width, height / pixels.height);
    const dx = (width - pixels.width * fit) / 2;
    const dy = (height - pixels.height * fit) / 2;
    return { left: box.left + dx, top: box.top + dy, right: box.right - dx, bottom: box.bottom - dy };
  };

  /** The shown picture's outline at rest: by its box's layout, not its zoom or a step's slide. */
  const restingRect = (): StepRect | null => {
    const box = zoomBoxRef.current;
    if (!box) return null;
    const layout = { left: box.offsetLeft, top: box.offsetTop, right: box.offsetLeft + box.offsetWidth, bottom: box.offsetTop + box.offsetHeight };
    return drawnRect(layout, mediaRef.current, currentMediaItem.peek());
  };

  /** Where the shown picture is drawn this moment, its zoom included. */
  const shownRect = (): StepRect | null => {
    const surface = gestureSurfaceRef.current;
    const picture = mediaRef.current ?? zoomBoxRef.current;
    if (!surface || !picture) return null;
    const area = surface.getBoundingClientRect();
    const drawn = picture.getBoundingClientRect();
    const box = { left: drawn.left - area.left, top: drawn.top - area.top, right: drawn.right - area.left, bottom: drawn.bottom - area.top };
    return drawnRect(box, mediaRef.current, currentMediaItem.peek());
  };

  const pictureReady = (picture: HTMLImageElement | HTMLVideoElement | null): picture is HTMLImageElement | HTMLVideoElement =>
    picture instanceof HTMLVideoElement ? picture.videoWidth > 0 : picture ? picture.complete && picture.naturalWidth > 0 : false;

  /**
   * A still of `picture` drawn over `rect`, cut to the surface, added to the step's layer above the
   * stills already there. Painted at once from what is already decoded, where a copied img would be
   * decoded again and blink.
   */
  const paintCopy = (picture: HTMLImageElement | HTMLVideoElement, rect: StepRect): StepCopy | null => {
    const layer = stepOutgoingRef.current;
    const surface = gestureSurfaceRef.current;
    if (!layer || !surface) return null;
    const shown = intersectRect(rect, { left: 0, top: 0, right: surface.clientWidth, bottom: surface.clientHeight });
    const width = shown.right - shown.left;
    const height = shown.bottom - shown.top;
    if (width < 1 || height < 1) return null;
    const pixels = picture instanceof HTMLVideoElement ? { w: picture.videoWidth, h: picture.videoHeight } : { w: picture.naturalWidth, h: picture.naturalHeight };
    const across = pixels.w / (rect.right - rect.left);
    const down = pixels.h / (rect.bottom - rect.top);
    const scale = globalThis.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d')?.drawImage(
      picture,
      (shown.left - rect.left) * across,
      (shown.top - rect.top) * down,
      width * across,
      height * down,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    Object.assign(canvas.style, { position: 'absolute', left: `${shown.left}px`, top: `${shown.top}px`, width: `${width}px`, height: `${height}px` });
    const frame = document.createElement('div');
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, { position: 'absolute', inset: '0' });
    frame.append(canvas);
    layer.append(frame);
    return { frame, canvas, rect: shown };
  };

  /** `rect` as the `clip-path` of an element laid out over `box` and moved `shift` across. */
  const insetOf = (rect: StepRect, box: StepRect, shift = 0) =>
    `inset(${rect.top - box.top}px ${box.right + shift - rect.right}px ${box.bottom - rect.bottom}px ${rect.left - box.left - shift}px)`;

  /**
   * One picture's motion in a step, on its still or on the shown picture's box: the old picture
   * (`out`) slides away and fades out, the new one (`in`) slides in and fades in. Each is cut to the
   * frame that turns from the old outline into the new one, and so to its own outline at rest.
   */
  const stepMotion = (target: StepCopy | HTMLElement, role: 'out' | 'in', step: DesktopStep, from: StepRect, to: StepRect): Animation[] => {
    const surface = gestureSurfaceRef.current;
    if (!surface) return [];
    const meet = intersectRect(from, to);
    const [frameFrom, frameTo] = role === 'out' ? [from, meet] : [meet, to];
    const shift = step.sign * step.distance;
    const [shiftFrom, shiftTo] = role === 'out' ? [0, -shift] : [shift, 0];
    const move = (x: number) => `translate3d(${x}px, 0, 0)`;
    // Held at both ends: a reversal runs the stills back to their start, where they must stay put.
    const timing: KeyframeAnimationOptions = { duration: STEP_MS, easing: STEP_EASING, fill: 'both' };
    const fade = role === 'out' ? { opacity: [step.shown, 0] } : STEP_FADE_IN;
    const fadeTiming = role === 'out' ? timing : { ...timing, easing: 'linear' };
    if (target instanceof HTMLElement) {
      // The box moves with its picture, so its cut is set back by the slide and the frame stays put.
      // Its animations leave nothing behind: at the end the box is where its own style puts it.
      const box = { left: target.offsetLeft, top: target.offsetTop, right: target.offsetLeft + target.offsetWidth, bottom: target.offsetTop + target.offsetHeight };
      return [
        target.animate(
          { clipPath: [insetOf(frameFrom, box, shiftFrom), insetOf(frameTo, box, shiftTo)], transform: [move(shiftFrom), move(shiftTo)] },
          { ...timing, fill: 'none' },
        ),
        target.animate(fade, { ...fadeTiming, fill: 'none' }),
      ];
    }
    const stage = { left: 0, top: 0, right: surface.clientWidth, bottom: surface.clientHeight };
    return [
      target.frame.animate({ clipPath: [insetOf(frameFrom, stage), insetOf(frameTo, stage)] }, timing),
      target.canvas.animate({ transform: [move(shiftFrom), move(shiftTo)] }, timing),
      target.canvas.animate(fade, fadeTiming),
    ];
  };

  const releaseBox = () => {
    for (const animation of stepBoxAnimationsRef.current) animation.cancel();
    stepBoxAnimationsRef.current = [];
  };

  /** Hides the shown picture's box while stills stand in for it. */
  const holdBox = () => {
    releaseBox();
    const hold = zoomBoxRef.current?.animate({ opacity: [0, 0] }, { duration: STEP_MS });
    if (!hold) return;
    hold.pause();
    stepBoxAnimationsRef.current = [hold];
  };

  const dropCopies = () => {
    for (const animation of stepCopyAnimationsRef.current) animation.cancel();
    stepCopyAnimationsRef.current = [];
    stepOutgoingRef.current?.replaceChildren();
  };

  /**
   * A desktop step (`STEP_MS`). A slide leaves a still of the old picture where it is drawn, to move
   * out once the new picture can be drawn. A step sooner than `STEP_MS` after the last cuts: what
   * shows stands still, the shown picture at rest if it has loaded, until the new picture can be
   * drawn. A step back against one still moving runs the stills of both pictures back from where
   * they are, the shown picture handing over to a still of itself at the same point of its motion.
   */
  const stepDesktop = (action: 'next' | 'previous') => {
    const surface = gestureSurfaceRef.current;
    const list = albumMediaList.value;
    const target = list[action === 'next' ? nextMediaIndex(currentMediaIndex.value, list.length) : prevMediaIndex(currentMediaIndex.value, list.length)];
    if (!surface || !target) return;
    const now = performance.now();
    const last = stepRef.current;
    const waiting = last !== null && last.endsAt === null;
    const moving = last !== null && last.endsAt !== null && now < last.endsAt;
    const quick = now - lastStepAtRef.current < STEP_MS;
    lastStepAtRef.current = now;
    const picture = mediaRef.current;
    const step: DesktopStep = {
      action,
      mode: 'slide',
      sign: action === 'next' ? 1 : -1,
      distance: STEP_SLIDE_SHARE * surface.clientWidth,
      from: null,
      to: null,
      copy: null,
      shown: 1,
      backward: false,
      endsAt: null,
    };
    const turns = moving && last.mode !== 'cut' && last.action !== action;
    if (turns && last.mode === 'slide' && last.from && last.to && pictureReady(picture)) {
      const at = stepBoxAnimationsRef.current[0]?.currentTime ?? null;
      const copy = paintCopy(picture, last.to);
      if (copy && at !== null) {
        const motion = stepMotion(copy, 'in', last, last.from, copy.rect);
        for (const animation of motion) animation.currentTime = at;
        stepCopyAnimationsRef.current.push(...motion);
      }
    }
    const stills = stepCopyAnimationsRef.current;
    if (turns && stills.length > 0) {
      const at = Number(stills[0].currentTime ?? 0);
      for (const animation of stills) animation.reverse();
      holdBox();
      step.mode = 'reverse';
      step.backward = last.mode === 'slide' || !last.backward;
      step.endsAt = now + (step.backward ? at : STEP_MS - at);
    } else if (waiting || moving || quick) {
      step.mode = 'cut';
      const rect = pictureReady(picture) ? (waiting || moving ? restingRect() : shownRect()) : null;
      for (const animation of stills) animation.pause();
      if (picture && rect) {
        dropCopies();
        paintCopy(picture, rect);
      }
      holdBox();
    } else {
      const rect = shownRect();
      dropCopies();
      releaseBox();
      step.copy = rect && pictureReady(picture) ? paintCopy(picture, rect) : null;
      step.from = step.copy?.rect ?? null;
      step.shown = zoomBoxRef.current ? Number(getComputedStyle(zoomBoxRef.current).opacity) : 1;
    }
    stepRef.current = step;
    stepArrivalRef.current = step;
    if (action === 'next') goToNextMedia();
    else goToPrevMedia();
  };

  // Takes up the step that switched to the shown media. Its box stays hidden behind the stills
  // until its picture is decoded, or a moment has passed, so neither a blank frame nor a half-drawn
  // picture shows. Then a slide moves, measured from the picture as it is drawn; a cut shows the
  // picture; a reversal shows it once the stills are back where they began. Media shown any other
  // way ends a step in flight.
  useLayoutEffect(() => {
    const step = stepArrivalRef.current;
    stepArrivalRef.current = null;
    if (!step) {
      if (stepRef.current) {
        stepRef.current = null;
        dropCopies();
        releaseBox();
      }
      return;
    }
    holdBox();
    const current = () => stepRef.current === step;
    const settle = () => {
      if (!current()) return;
      dropCopies();
      releaseBox();
    };
    const picture = mediaRef.current;
    let started = false;
    const start = () => {
      if (started || !current()) return;
      started = true;
      if (step.mode === 'cut') {
        step.endsAt = performance.now();
        settle();
        return;
      }
      if (step.mode === 'reverse') {
        void Promise.all(stepCopyAnimationsRef.current.map((animation) => animation.finished)).then(settle, () => {});
        return;
      }
      const box = zoomBoxRef.current;
      const to = restingRect();
      if (!box || !to) {
        settle();
        return;
      }
      const from = step.from ?? to;
      step.to = to;
      releaseBox();
      stepBoxAnimationsRef.current = stepMotion(box, 'in', step, from, to);
      stepCopyAnimationsRef.current = step.copy ? stepMotion(step.copy, 'out', step, from, to) : [];
      step.endsAt = performance.now() + STEP_MS;
      void Promise.all([...stepBoxAnimationsRef.current, ...stepCopyAnimationsRef.current].map((animation) => animation.finished)).then(settle, () => {});
    };
    if (picture instanceof HTMLImageElement) void picture.decode().then(start, start);
    else start();
    globalThis.setTimeout(start, STEP_DECODE_WAIT_MS);
  }, [media?.id]);

  // The arrow buttons and keys step: on a desktop by `stepDesktop`; elsewhere the neighbour slides
  // in as a released swipe would. A press while a slide is still running lands that one and steps
  // on at once, so holding a key or clicking quickly is never held back by the animation.
  const slideToMedia = useCallback((action: 'next' | 'previous') => {
    if (swipePendingRef.current) {
      globalThis.clearTimeout(swipeTimerRef.current);
      swipePendingRef.current();
      if (action === 'next') goToNextMedia();
      else goToPrevMedia();
      return;
    }
    // A slideshow cross-fades its own way and keeps no neighbours to slide in.
    if (slideshow) {
      if (action === 'next') goToNextMedia();
      else goToPrevMedia();
      return;
    }
    if (!isMobile) {
      if (action === 'next' ? hasNextMedia.value : hasPrevMedia.value) stepDesktop(action);
      return;
    }
    finishPhotoSwipe(action, 0, 0);
  }, [finishPhotoSwipe, isMobile, slideshow]);

  /** The half of the surface a point is on, the picture's centre between them. */
  const sideAt = (clientX: number): 'previous' | 'next' => {
    const area = gestureSurfaceRef.current?.getBoundingClientRect();
    return area && clientX < area.left + area.width / 2 ? 'previous' : 'next';
  };

  /**
   * A desktop click on a half of the picture steps that way, as its arrow does, once the wait for a
   * double-click (a zoom) is over. Not on a zoomed picture, which a drag pans, nor while drawing a
   * face; on a video, a recording or a document only off the player, which has clicks of its own.
   */
  const handleSurfaceClick = (event: MouseEvent<HTMLElement>) => {
    if (slideshow) return stopSlideshow();
    globalThis.clearTimeout(sideClickTimerRef.current);
    if (isMobile || event.detail > 1 || lastPointerTypeRef.current === 'touch' || addingFace || isGestureControl(event.target)) return;
    if (zoomable && isZoomed(zoomRef.current)) return;
    const offPlayer = event.target === event.currentTarget || event.target === zoomBoxRef.current;
    if (media?.type !== 'photo' && !offPlayer) return;
    const side = sideAt(event.clientX);
    sideClickTimerRef.current = globalThis.setTimeout(() => slideToMedia(side), SIDE_CLICK_WAIT_MS);
  };

  useEffect(() => {
    if (!swipeTarget || swipeTarget.id !== media?.id) return;
    // Loaded is not yet painted; a moment more covers the decode. A frame that never loads
    // gives up the cover rather than keep it for good.
    const ready = media.type !== 'photo' || loadedPhotoId === media.id;
    const timer = globalThis.setTimeout(() => setSwipeTarget(undefined), ready ? 50 : 1000);
    return () => globalThis.clearTimeout(timer);
  }, [loadedPhotoId, media, swipeTarget]);

  const handleTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const pinch = pinchRef.current;
    if (pinch && event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]];
      const geometry = pinchGeometry(zoomFocal(a.clientX, a.clientY), zoomFocal(b.clientX, b.clientY));
      setZoom(pinchZoom(pinch, geometry, zoomFrame()), false);
      return;
    }
    const pan = touchPanRef.current;
    if (pan && event.touches.length === 1) {
      const touch = event.touches[0];
      const dx = touch.clientX - pan.x;
      const dy = touch.clientY - pan.y;
      pan.x = touch.clientX;
      pan.y = touch.clientY;
      setZoom(panZoom(zoomRef.current, dx, dy, zoomFrame()), false);
      return;
    }

    const start = touchStartRef.current;
    if (!start || event.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }

    const touch = event.touches[0];
    const samples = swipeSamplesRef.current;
    samples.push({ x: touch.clientX, y: touch.clientY, time: event.timeStamp });
    if (samples.length > 16) samples.shift();
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!touchAxisRef.current) {
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) touchAxisRef.current = 'x';
      else if (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) * 1.2) {
        // A phone held upright pulls the details sheet with the finger; elsewhere the release decides.
        // Pulling down with the sheet closed is not the sheet's: that swipe closes the lightbox.
        const dismissing = dy > 0 && !infoSidebarOpen.value;
        touchAxisRef.current = mobilePortrait && !dismissing && beginSheet(infoSidebarOpen.value ? 1 : 0) ? 'sheet' : 'y';
      }
    }
    if (touchAxisRef.current === 'x') {
      const allowed = dx < 0 ? hasNextMedia.value : hasPrevMedia.value;
      // With nothing to go to, give a small elastic response instead of moving into empty space.
      const offset = swipeBaseRef.current + (allowed ? dx : dx * 0.18);
      moveSwipe(offset);
      followSwipeInfo(offset);
    } else if (touchAxisRef.current === 'sheet' && sheetDragRef.current) {
      moveSheet(sheetDragRef.current.from - dy / sheetDragRef.current.panelPx);
    }
  }, [beginSheet, followSwipeInfo, mobilePortrait, moveSheet, moveSwipe, setZoom, zoomFocal, zoomFrame]);

  const handleTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    if (pinchRef.current) {
      if (event.touches.length >= 2) return;
      pinchRef.current = null;
      // The finger still down carries straight on as a pan; nothing is re-planted.
      touchPanRef.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
      if (!touchPanRef.current) setZoom(panZoom(zoomRef.current, 0, 0, zoomFrame()), true);
      return;
    }

    // Two quick taps zoom in on the spot, or back out; the same on a zoomed picture as at fit.
    const tapStart = tapStartRef.current;
    tapStartRef.current = null;
    if (tapStart && event.changedTouches.length === 1 && event.touches.length === 0) {
      const tap = touchPoint(event.changedTouches[0], event.timeStamp);
      if (isTap(tapStart, tap)) {
        if (zoomable && isDoubleTap(lastTapRef.current, tap)) {
          // Cancelling the touchend withholds the browser's click for this tap, which would
          // otherwise be hit-tested against the picture after the zoom has moved it under the
          // finger. React registers touchend non-passively, so this takes effect.
          event.preventDefault();
          lastTapRef.current = null;
          touchStartRef.current = null;
          touchPanRef.current = null;
          swipeBaseRef.current = 0;
          resetSwipe();
          setZoom(toggleZoom(zoomRef.current, zoomFocal(tap.x, tap.y), zoomFrame()), true);
          return;
        }
        lastTapRef.current = tap;
      }
    }

    if (touchPanRef.current) {
      if (event.touches.length === 0) touchPanRef.current = null;
      return;
    }

    const start = touchStartRef.current;
    touchStartRef.current = null;
    const base = swipeBaseRef.current;
    swipeBaseRef.current = 0;
    if (!start || event.changedTouches.length !== 1) {
      if (base !== 0) settleSwipe();
      return;
    }

    const touch = event.changedTouches[0];
    const end = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    if (touchAxisRef.current === 'sheet') {
      endSheet(releaseVelocityY(swipeSamplesRef.current, end));
      if (base !== 0) settleSwipe();
      return;
    }
    const velocityX = releaseVelocityX(swipeSamplesRef.current, end);
    const action = lightboxSwipeAction(start, end, { velocityX, width: globalThis.innerWidth });
    switch (action) {
      case 'next':
      case 'previous':
        finishPhotoSwipe(action, base + end.x - start.x, velocityX);
        return;
      case 'open-details':
        toggleSheet(true);
        settleSwipe();
        return;
      case 'close-details':
        // Down with nothing open to put away: the swipe puts the picture away, as Back would.
        if (!infoSidebarOpen.value) {
          settleSwipe();
          requestClose();
          return;
        }
        toggleSheet(false);
        settleSwipe();
        return;
      case null:
        settleSwipe();
        return;
    }
  }, [endSheet, finishPhotoSwipe, requestClose, resetSwipe, setZoom, settleSwipe, toggleSheet, zoomFocal, zoomFrame, zoomable]);

  useShortcutHelp('Lightbox', withDetails ? LIGHTBOX_SHORTCUTS : LIGHTBOX_SHORTCUTS.filter((entry) => entry.keys !== 'i'));
  useHotkeys([
    // The text and subtitle dialogs are over the picture: the keys are theirs while one is open.
    ['ArrowLeft', () => !addingFace && !editing && slideToMedia('previous')],
    ['ArrowRight', () => !addingFace && !editing && slideToMedia('next')],
    ['Escape', handleEscape],
    ['i', () => !dialogLayer && !editing && toggleSheet(!infoSidebarOpen.value)],
    ['f', () => !dialogLayer && !editing && toggleFacesVisible()],
    ['t', () => !dialogLayer && !editing && pictureText && toggleTextVisible()],
    ['s', () => !dialogLayer && !editing && toggleStar()],
    // `+` is shifted on most layouts and `=` is its unshifted key on a US one. These keys
    // have no default worth suppressing, so they are left alone for whatever else listens.
    ['plus', () => zoomable && setZoom(stepZoom(zoomRef.current, 1, zoomFrame()), true), { preventDefault: false }],
    ['shift+plus', () => zoomable && setZoom(stepZoom(zoomRef.current, 1, zoomFrame()), true), { preventDefault: false }],
    ['=', () => zoomable && setZoom(stepZoom(zoomRef.current, 1, zoomFrame()), true), { preventDefault: false }],
    ['minus', () => zoomable && setZoom(stepZoom(zoomRef.current, -1, zoomFrame()), true), { preventDefault: false }],
    ['0', () => zoomable && resetZoom(), { preventDefault: false }],
  ]);

  // The players' keys rest while a layer over the lightbox has the keyboard, as the lightbox's own do.
  const playerKeys = !dialogLayer && !editing && !addingFace && !mapOpen && reviewPersonId === null && personFacePath === null;
  const attachMediaElement = useCallback((el: HTMLVideoElement | null) => {
    mediaRef.current = el;
  }, []);

  /**
   * Follow a video's face: pause on the frame it was seen most clearly in, boxed, and keep the box
   * on it as the video plays. The same face again stops following it.
   */
  const followFace = useCallback((facePath: string) => {
    if (facePath === followedFacePath) return setFollowedFacePath(null);
    const face = currentDetails?.faces.find((candidate) => candidate.facePath === facePath);
    const video = mediaRef.current;
    if (face?.atSeconds === undefined || !(video instanceof HTMLVideoElement)) return;
    video.pause();
    video.currentTime = face.atSeconds;
    setFollowedFacePath(facePath);
  }, [currentDetails, followedFacePath]);

  // A recording the browser will not start by itself (an autoplay policy), one that fails, or one
  // known to be undecodable never ends; a slideshow moves past it after one slide's time rather
  // than stopping there. A stall lasts until the recording plays after all.
  const [stalledId, setStalledId] = useState<string | null>(null);
  const undecodableAv = (media?.type === 'video' || media?.type === 'audio') && Boolean(currentDetails?.undecodable);
  useEffect(() => {
    if (!slideshow || !media || (stalledId !== media.id && !undecodableAv)) return;
    const timer = globalThis.setTimeout(advanceSlideshow, slideDurationMs);
    return () => globalThis.clearTimeout(timer);
  }, [advanceSlideshow, media, slideDurationMs, slideshow, stalledId, undecodableAv]);

  // A slideshow's information bar lies over the bottom of the picture; a video's subtitles clear it.
  const [infoRowHeight, setInfoRowHeight] = useState(0);
  useEffect(() => {
    const row = infoRowRef.current;
    if (!slideshow || !row) return setInfoRowHeight(0);
    const observer = new ResizeObserver(() => setInfoRowHeight(row.offsetHeight));
    observer.observe(row);
    return () => observer.disconnect();
  }, [slideshow]);

  /**
   * How many of the bar's actions (`barActions`) it has room for. Measured after each render and on
   * every resize of the bar: one fewer while the bar cuts a text of its short, one more while the
   * space left over takes another button and its gap. The last one takes no more than the room of
   * the "more" button, which goes with it.
   */
  const [barActionsShown, setBarActionsShown] = useState(Infinity);
  const barActionCountRef = useRef(0);
  const [, setBarResized] = useState(0);
  useEffect(() => {
    const row = infoRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => setBarResized((n) => n + 1));
    observer.observe(row);
    return () => observer.disconnect();
  }, [media === null]);
  useLayoutEffect(() => {
    const row = infoRowRef.current;
    if (!row || slideshow) return;
    const style = getComputedStyle(row);
    const gap = parseFloat(style.columnGap) || 0;
    const items = [...row.children] as HTMLElement[];
    const used = items.reduce((sum, item) => sum + item.offsetWidth, 0) + gap * Math.max(0, items.length - 1);
    const free = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - used;
    // Cut short by the bar, that is: a text held to a width of its own (the place's) counts only below that.
    const cut = [...row.querySelectorAll<HTMLElement>('[data-bar-text]')].some((text) => {
      const cap = parseFloat(getComputedStyle(text).maxWidth);
      return Math.min(text.scrollWidth, Number.isNaN(cap) ? Infinity : cap) > text.clientWidth + 1;
    });
    const total = barActionCountRef.current;
    const shown = row.querySelectorAll('[data-bar-action]').length;
    const room = shown + 1 === total ? 0 : (BAR_BUTTON_PX[barButtonSize] ?? 34) + gap + 2;
    if (cut && shown > 0) setBarActionsShown(shown - 1);
    else if (!cut && shown < total && free >= room) setBarActionsShown(shown + 1);
  });

  if (!media) return null;

  const isVideo = media.type === 'video';
  const isAudio = media.type === 'audio';
  // A document is read in place; a slideshow shows its first page like a photo.
  const readsDocument = media.type === 'document' && !slideshow;
  // A source ffprobe could not read at all — no rendition exists and none can be made, so the
  // player below would be controls over nothing. Say what is wrong instead. Only for a/v: it is
  // the only family `exif-extract` probes, and `details` is the read the sidebar already makes.
  const undecodable = (isVideo || isAudio) ? currentDetails?.undecodable : undefined;
  // An upright phone's slideshow bar carries the date beside the counter and location; the short
  // names keep it on one line.
  const shortTaken = slideshow && mobilePortrait;
  // Only this file's details: straight after a step `details` may still be the last file's.
  const barInfo = barInfoOf(media, currentDetails, currentMediaIndex.value, shortTaken);
  // Match the sidebar preview: embedded GPS is more specific than the linked
  // location, but either is enough to locate the media on the enlarged map.
  const mapPoint = currentDetails?.position ??
    (currentDetails?.location?.lat !== undefined && currentDetails.location.lng !== undefined
      ? { lat: currentDetails.location.lat, lng: currentDetails.location.lng, radius: currentDetails.location.radius }
      : null);
  // The picture the sidebar's add-to-album row acts on; that is not the guest's to do.
  const actionPath = albumMedia && !isGuest(access) ? albumMedia.path : undefined;
  // The details panel's file actions, floating over the picture when asked for: for whoever may
  // change the file, not for one who may only add it to an album.
  const mayUseToolbar = withDetails && canEdit;
  // The bar's actions, in the order they give way to the "more" menu from the end: the favourite
  // and the slideshow, the view switches (the text, the faces, fullscreen) and the download, which
  // saves the original file as the file name in the details does. Each keeps its place in the bar
  // as far as there is room (`barActionsShown`). A phone's bar holds the view switches only; the
  // rest are always in its menu up in the corner, with the toolbar, which a computer's cog toggles.
  const favouriteAction: BarAction | undefined = mayStar
    ? {
      key: 'favourite',
      icon: starred ? 'heart-filled' : 'heart',
      label: starred ? 'Unfavourite' : 'Favourite',
      shortcut: 's',
      on: starred,
      onColor: 'var(--mantine-color-red-5)',
      onClick: toggleStar,
    }
    : undefined;
  const slideshowAction: BarAction = {
    key: 'slideshow',
    icon: 'player-play',
    label: 'Start slideshow',
    on: false,
    disabled: albumMediaList.value.length < 2,
    onClick: startSlideshow,
  };
  const viewActions: BarAction[] = [];
  if (pictureText) {
    viewActions.push({ key: 'text', icon: 'text-scan-2', label: showText ? 'Hide text' : 'Show text', shortcut: 't', on: showText, onClick: toggleTextVisible });
  }
  if ((media?.type === 'photo' || media?.type === 'video') && faceCount > 0) {
    viewActions.push({
      key: 'faces',
      icon: 'user-square-rounded',
      label: `${showFaces ? 'Unpin' : 'Pin'} faces`,
      shortcut: 'f',
      on: showFaces,
      onClick: toggleFacesVisible,
    });
  }
  viewActions.push({
    key: 'fullscreen',
    icon: fullscreen ? 'minimize' : 'maximize',
    label: fullscreen ? 'Exit fullscreen' : 'Fullscreen',
    on: false,
    onClick: toggleFullscreen,
  });
  const toolbarAction: BarAction | undefined = mayUseToolbar
    ? { key: 'toolbar', icon: 'settings', label: showToolbar ? 'Hide toolbar' : 'Show toolbar', on: showToolbar, onClick: toggleToolbarVisible }
    : undefined;
  const downloadAction: BarAction = { key: 'download', icon: 'download', label: 'Download', on: false, href: fileUrl(media.path), download: media.name };
  const barActions = slideshow ? [] : isMobile ? viewActions : [...(favouriteAction ? [favouriteAction] : []), slideshowAction, ...viewActions, downloadAction];
  barActionCountRef.current = barActions.length;
  const inBar = new Set(barActions.slice(0, barActionsShown).map((action) => action.key));
  const barButton = (action: BarAction | undefined) =>
    action && inBar.has(action.key) && (
      <Tooltip key={action.key} label={action.shortcut ? `${action.label} (${action.shortcut})` : action.label} withArrow disabled={isMobile}>
        <ActionIcon
          data-bar-action
          variant='subtle'
          color='gray'
          size={barButtonSize}
          disabled={action.disabled}
          onClick={action.onClick}
          aria-label={action.label}
          aria-pressed={action.href ? undefined : action.on}
          style={{ flexShrink: 0 }}
          {...(action.href ? { component: 'a' as const, href: action.href, download: action.download } : {})}
        >
          <TablerIcon name={action.icon} size={barIconSize} color={action.on ? action.onColor ?? 'var(--mrx-accent)' : 'white'} />
        </ActionIcon>
      </Tooltip>
    );
  // The rows of the "more" menu, on a phone and a desktop alike, in the bar's order, with icons the
  // size of the rows around them: what the bar has no room for, and on a phone what it never holds.
  const menuActions = isMobile
    ? [
      ...(favouriteAction ? [favouriteAction] : []),
      slideshowAction,
      ...viewActions.filter((action) => !inBar.has(action.key)),
      ...(toolbarAction ? [toolbarAction] : []),
      downloadAction,
    ]
    : barActions.filter((action) => !inBar.has(action.key));
  // A computer's top right corner, of the details panel while it is open, else of the picture's
  // background: the cog that shows the toolbar, and close.
  const cornerButtons = (color: string) => (
    <>
      {toolbarAction && (
        <Tooltip label={toolbarAction.label} withArrow>
          <ActionIcon
            variant='subtle'
            color='gray'
            size='lg'
            loading={orienting}
            onClick={toolbarAction.onClick}
            aria-label={toolbarAction.label}
            aria-pressed={showToolbar}
            style={{ pointerEvents: 'auto' }}
          >
            <TablerIcon name='settings' size={20} color={showToolbar ? 'var(--mrx-accent)' : color} />
          </ActionIcon>
        </Tooltip>
      )}
      <Tooltip label='Close' withArrow>
        <ActionIcon variant='subtle' color='gray' size='lg' onClick={requestClose} aria-label='Close lightbox' style={{ pointerEvents: 'auto' }}>
          <TablerIcon name='x' size={22} color={color} />
        </ActionIcon>
      </Tooltip>
    </>
  );
  const actionMenuItems = (iconSize: number) =>
    menuActions.map((action) => (
      <Menu.Item
        key={action.key}
        leftSection={<TablerIcon name={action.icon} size={iconSize} color={action.on ? action.onColor ?? 'var(--mrx-accent)' : undefined} />}
        rightSection={isMobile || !action.shortcut ? undefined : <Kbd size='xs'>{action.shortcut}</Kbd>}
        disabled={action.disabled}
        onClick={action.onClick}
        {...(action.href ? { component: 'a' as const, href: action.href, download: action.download } : {})}
      >
        {action.label}
      </Menu.Item>
    ));
  const kenBurnsClass = kenBurnsClassForIndex(currentMediaIndex.value, kenBurns);
  const zoomed = zoomable && isZoomed(zoom);
  const zoomTransition = zoomAnimating ? ZOOM_ANIMATION : 'none';
  // A video's zoom moves its picture inside the player (`zoom`), and its controls with the picture's edge.
  const zoomInPlayer = isVideo;
  const activeSlideshowPhotoTransition = slideshowPhotoTransition?.incomingId === media.id ? slideshowPhotoTransition : undefined;
  // Both neighbours are kept mounted beside the frame once it has loaded, or once a swipe has
  // brought its picture in, so the first movement of a drag finds their pictures ready instead of
  // mounting them. With two media the neighbours are one and the same, placed on whichever side
  // the drag goes (`--swipe-side`). Keyed by media, so the one a swipe slides in is the same
  // element that then covers the handoff; it moves with the frame, so a swipe that starts before
  // the frame has loaded takes the picture along rather than leaving it behind.
  const swipePreviews: { item: MediaItem; location: 'previous' | 'next' | 'either' | 'handoff' }[] = [];
  const handoff = swipeTarget?.id === media.id;
  if (handoff) swipePreviews.push({ item: swipeTarget, location: 'handoff' });
  const swipeList = albumMediaList.value;
  if (isMobile && !slideshow && swipeList.length > 1 && (media.type !== 'photo' || loadedPhotoId === media.id || handoff)) {
    const previous = swipeList[prevMediaIndex(currentMediaIndex.value, swipeList.length)];
    const next = swipeList[nextMediaIndex(currentMediaIndex.value, swipeList.length)];
    if (previous && next && previous.id === next.id) swipePreviews.push({ item: next, location: 'either' });
    else {
      if (previous) swipePreviews.push({ item: previous, location: 'previous' });
      if (next) swipePreviews.push({ item: next, location: 'next' });
    }
  }
  // One surface's width plus the gap (`swipeFrameWidth`), but as a share of the preview's own box
  // (the surface less the desktop arrows' inset) rather than pixels measured at render: when the
  // details sidebar opens or closes the surface resizes without a render, and a measured width
  // would leave the neighbours peeking in at its edges.
  const swipeFrame = `(100% + ${SWIPE_FRAME_GAP_PX}px)`;
  const swipePreviewBase = {
    previous: `calc(-1 * ${swipeFrame})`,
    next: `calc${swipeFrame}`,
    either: `calc(var(--swipe-side, 1) * ${swipeFrame})`,
    handoff: '0px',
  };

  // A video's box is drawn on a still frame, so the video stops for it; one that cannot be
  // played has no frame to draw on.
  const addFace = media.type === 'video' && currentDetails?.undecodable ? undefined : () => {
    const video = mediaRef.current;
    if (!addingFace && video instanceof HTMLVideoElement) video.pause();
    setAddingFace((value) => !value);
    setFaceDraftReady(false);
    setFaceMessage(null);
  };
  const detailsSidebar = (mobile: boolean) => (
    <MediaSidebar
      media={media}
      mobile={mobile}
      result={detailsResult}
      hoveredFace={hoveredFace}
      onHoverFace={setHoveredFace}
      onNavigate={goTo}
      onReviewUnknown={setReviewPersonId}
      onShowFace={media.type === 'video' ? followFace : undefined}
      followedFace={followedFacePath}
      onOpenMap={mapPoint ? () => setMapOpen(true) : undefined}
      canEdit={canEdit}
      stackBusy={stackBusy}
      onStackPreview={previewStackMember}
      onStackAction={mutateStack}
      onLayer={setSidebarLayer}
      headerActions={mobile ? undefined : cornerButtons(SIDE_ICON_COLOR)}
      // The foot that hides the details, as the app's navbar collapses, mirrored; the chat at its
      // other end while it is closed.
      foot={mobile ? undefined : (
        <Box className='mrx-lightbox-side-foot'>
          <Divider mb='xs' />
          <Group justify='space-between' wrap='nowrap'>
            <Tooltip label='Hide details (i)' position='left' withArrow>
              <ActionIcon variant='subtle' color='gray' size='lg' radius='md' aria-label='Hide details' onClick={() => toggleSheet(false)}>
                <TablerIcon name='layout-sidebar-right-collapse' size={20} />
              </ActionIcon>
            </Tooltip>
            <Group gap={4} wrap='nowrap'>
              <DrawerButtons color={SIDE_ICON_COLOR} hideOpen />
            </Group>
          </Group>
        </Box>
      )}
    />
  );
  // The same element while the phone's closed panel waits to draw the picture shown, which React
  // passes over without rendering it again.
  if (detailsCurrent) drawnDetailsRef.current = isMobile && !slideshow ? detailsSidebar(mobilePortrait) : null;

  return (
    <>
      <Box
        ref={sheetRootRef}
        data-lightbox-media-path={media.path}
        style={{
          height: '100%',
          background: 'var(--mrx-media-bg)',
          display: 'flex',
          flexDirection: mobilePortrait ? 'column' : 'row',
          // The phone's details sheet lies over the bottom of this box, below it when closed.
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Main viewer area */}
        <Box
          style={{
            // On a phone the viewer is what an open details panel leaves, the top half upright and
            // the left sideways; `--sheet-viewer-*` holds it whole while the panel moves.
            ...(mobilePortrait
              ? { flex: '0 0 auto', height: `var(--sheet-viewer-h, ${sidebarOpen && !slideshow ? '50dvh' : '100%'})` }
              : isMobile && !slideshow
              ? { flex: '0 0 auto', width: `var(--sheet-viewer-w, ${sidebarOpen ? `calc(100% - ${SIDEBAR_WIDTH}px)` : '100%'})` }
              : { flex: 1 }),
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {
            /* A phone shows the date centred over the top edge of the picture: in the bar
                below it would push a narrow screen onto a second line. A
                desktop bar has the room, and so has a slideshow's, which floats over the
                picture and may wrap; both keep it down there beside the counter. */
          }
          {isMobile && !slideshow && (
            <SwipeInfo step={swipeInfoStep} current={barInfo} short={shortTaken}>
              {({ taken, takenTooltip }) =>
                taken.date && (
                  <Box
                    data-lightbox-taken
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      zIndex: 10,
                      display: 'flex',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                      padding: 'var(--mantine-spacing-xs) 56px',
                      color: 'white',
                      // Stays centred over the picture while a sideways panel moves (see `beginSheet`).
                      transform: 'translateX(calc(var(--sheet-p, 0) * var(--sheet-ix, 0px)))',
                      transition: 'var(--sheet-transition, none)',
                    }}
                  >
                    <Tooltip label={takenTooltip} withArrow disabled={!takenTooltip} multiline maw={320}>
                      {
                        /* The day on one line and the clock beneath it, in a size that survives a
                          glance; the icon would only crowd the narrow strip. */
                      }
                      <Stack gap={0} align='center' style={TAKEN_PILL_STYLE}>
                        <Text size='md' fw={500} c='inherit' truncate='end'>{taken.date}</Text>
                        {taken.clock && <Text size='sm' c='inherit'>{taken.clock}</Text>}
                      </Stack>
                    </Tooltip>
                  </Box>
                )}
            </SwipeInfo>
          )}

          {
            /* A phone's row at the bottom has room for the counter, the location and the view
                switches at most; the favourite, the slideshow, the toolbar, the download, the view
                switches the row leaves out and the chat are in a menu up in the corner. Sideways a phone
                has no swipe up to spare for the details either, so a button beside the menu
                opens them, and is gone while they are open. */
          }
          {!slideshow && isMobile && (
            <Group gap={8} wrap='nowrap' style={{ position: 'absolute', top: 8, right: 8, zIndex: 11 }}>
              {withDetails && !mobilePortrait && !sidebarOpen && (
                <ActionIcon
                  variant='subtle'
                  color='gray'
                  size={barButtonSize}
                  onClick={() => toggleSheet(true)}
                  aria-label='Show details'
                  style={{ background: TAKEN_PILL_STYLE.background }}
                >
                  <TablerIcon name='info-circle' size={barIconSize} color='white' />
                </ActionIcon>
              )}
              <Menu
                position='bottom-end'
                shadow='md'
                withinPortal
                // Fixed: laid out once before it is placed, an absolute dropdown would stick out past
                // the screen's right edge, and a phone widens the page to it, the picture with it.
                floatingStrategy='fixed'
                keepMounted
                keepMountedMode='display-none'
                // Sized for a thumb, like the bar's buttons.
                styles={THUMB_MENU_STYLES}
              >
                <Menu.Target>
                  <ActionIcon
                    data-lightbox-menu
                    variant='subtle'
                    color='gray'
                    size={barButtonSize}
                    aria-label='More actions'
                    style={{ background: TAKEN_PILL_STYLE.background }}
                  >
                    <TablerIcon name='dots-vertical' size={barIconSize} color='white' />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {actionMenuItems(24)}
                  <DrawerMenuItems iconSize={24} />
                </Menu.Dropdown>
              </Menu>
            </Group>
          )}

          {!slideshow && !isMobile && (
            <Group
              justify='flex-end'
              gap={4}
              px='md'
              py='xs'
              wrap='nowrap'
              style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, pointerEvents: 'none' }}
            >
              {/* The drawer (the chat), where there are no details to keep it: the top bar's button is covered. */}
              {!withDetails && <DrawerButtons />}
              {/* The toolbar's cog and close, here while the details panel does not hold them. */}
              {(!withDetails || !sidebarOpen) && cornerButtons('white')}
            </Group>
          )}

          {/* Media content */}
          <Box
            ref={attachGestureSurface}
            data-lightbox-gesture-surface
            data-lightbox-zoom={zoomed ? zoom.scale.toFixed(2) : undefined}
            onClick={handleSurfaceClick}
            onDoubleClick={handleDoubleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={(event) => {
              if (!isMobile && event.pointerType !== 'touch') setHoverSide(sideAt(event.clientX));
              handlePointerMove(event);
            }}
            onPointerLeave={() => setHoverSide(null)}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            // A drag on a zoomed picture pans it; the browser's own image drag would take over.
            onDragStart={(event) => event.preventDefault()}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={() => {
              touchStartRef.current = null;
              pinchRef.current = null;
              touchPanRef.current = null;
              tapStartRef.current = null;
              swipeBaseRef.current = 0;
              settleSwipe();
            }}
            style={{
              ...(isMobile && !slideshow
                ? {
                  transform:
                    'translate(calc(var(--sheet-p, 0) * var(--sheet-dx, 0px)), calc(var(--sheet-p, 0) * var(--sheet-dy, 0px))) scale(calc(1 + var(--sheet-p, 0) * var(--sheet-ds, 0)))',
                  transition: 'var(--sheet-transition, none)',
                }
                : {}),
              flex: 1,
              display: 'flex',
              // The swipe preview is absolutely positioned against this surface. Keep mobile
              // media full-width too, otherwise it visibly shrinks when the preview hands off
              // to the settled frame.
              minHeight: 0,
              position: 'relative',
              overflow: 'hidden',
              // The browser must not pinch-zoom the page, scroll or pull to refresh under a
              // swipe or while two fingers spread over a picture; every touch on it is
              // interpreted here.
              touchAction: zoomable || (isMobile && !slideshow && !readsDocument) ? 'none' : undefined,
              cursor: zoomed ? (panning ? 'grabbing' : 'grab') : undefined,
              userSelect: zoomed ? 'none' : undefined,
            }}
          >
            {/* A desktop step's old picture, fading out beneath the new one (`stepDesktop`). */}
            <Box ref={stepOutgoingRef} data-lightbox-step-outgoing style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />

            {swipePreviews.filter(({ item }) => item.type === 'photo' || item.type === 'video').map(({ item, location }) => {
              const token = versionOf(item.path);
              return (
                <Box
                  key={item.id}
                  data-lightbox-swipe-preview={location}
                  style={{
                    position: 'absolute',
                    // Over the same box as the settled frame.
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                    transform: `translate3d(calc(${swipePreviewBase[location]} + var(--swipe-x, 0px)), 0, 0)`,
                    transition: 'var(--swipe-transition, none)',
                    willChange: 'transform',
                  }}
                >
                  {item.type === 'photo'
                    ? (
                      <LightboxPhoto
                        key={`${item.id}-${token}`}
                        media={item}
                        reloadToken={token}
                        alt=''
                        fetchPriority='low'
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )
                    : (
                      <img
                        src={bust(posterUrl(item.path, item.type, item.hasDerivatives, displayDims(item)), token)}
                        alt=''
                        fetchPriority='low'
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      />
                    )}
                </Box>
              );
            })}

            <Box
              ref={attachZoomBox}
              data-lightbox-swipe-current
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 0,
                position: 'relative',
                // A photo's zoom is applied to the same box as the swipe, so the face overlay
                // inside it follows the picture without a second measurement. `zoomFocal` relies
                // on the origin being the centre, as does the video's picture, which fills this box.
                transformOrigin: 'center',
                transform: zoomInPlayer
                  ? 'translate3d(var(--swipe-x, 0px), 0, 0)'
                  : `translate3d(calc(var(--swipe-x, 0px) + ${zoom.x}px), ${zoom.y}px, 0) scale(${zoom.scale})`,
                transition: `var(--swipe-transition, ${zoomInPlayer ? 'none' : zoomTransition})`,
                willChange: isMobile || zoomed ? 'transform' : undefined,
              }}
            >
              {undecodable
                ? (
                  <Box style={{ textAlign: 'center', color: 'var(--mantine-color-gray-4)', maxWidth: 460 }}>
                    <TablerIcon name='file-alert' size={48} stroke={1.2} />
                    <Text size='md' mt='sm' c='gray.2'>This file cannot be played</Text>
                    <Text size='sm' mt={4}>
                      The original is damaged, so no preview or playable version could be made from it.
                    </Text>
                    <Text size='xs' mt='sm' c='dimmed' style={{ wordBreak: 'break-word' }}>{undecodable}</Text>
                  </Box>
                )
                : readsDocument
                ? <DocumentReader key={`${media.id}-${reloadToken}`} media={media} reloadToken={reloadToken} compact={isMobile} />
                : isAudio
                // Keyed like the video and the img: without it, stepping to the next track
                // reuses the instance and carries the old playhead and play state across.
                ? (
                  <AudioPlayer
                    key={`${media.id}-${reloadToken}`}
                    media={media}
                    bust={(url) => bust(url, reloadToken)}
                    onEnded={slideshow ? advanceSlideshow : undefined}
                    onStalled={() => setStalledId(media.id)}
                    onPlay={() => setStalledId(null)}
                    keysEnabled={playerKeys}
                    transcript={currentDetails?.hasTranscript ? { language: currentDetails.transcriptLanguage, speakers: currentDetails.speakers } : undefined}
                    compact={isMobile}
                  />
                )
                : isVideo
                ? (
                  <VideoPlayer
                    key={`${media.id}-${reloadToken}`}
                    media={media}
                    reloadToken={reloadToken}
                    videoRef={attachMediaElement}
                    zoom={{ ...zoom, animate: zoomAnimating }}
                    pictureOverlay={(videoFaces.length > 0 || addingFace) && (!slideshow || showFaces) && (
                      <VideoFaces
                        key={`video-faces-${media.id}-${reloadToken}`}
                        mediaRef={mediaRef}
                        faces={videoFaces}
                        followed={followedFace ? followedFace.facePath : null}
                        pinned={showFaces}
                        hoveredKey={hoveredFace}
                        onHover={setHoveredFace}
                        onOpenPerson={goTo}
                        onReviewUnknown={setReviewPersonId}
                        scale={zoom.scale}
                        drawing={addingFace}
                        saving={savingFace}
                        onCreateFace={createFace}
                        onRemoveFace={removeFace}
                        onChangePerson={setPersonFacePath}
                        onDraftChange={setFaceDraftReady}
                      />
                    )}
                    transcript={currentDetails?.hasTranscript ? { language: currentDetails.transcriptLanguage, speakers: currentDetails.speakers } : undefined}
                    chapters={currentDetails?.chapters}
                    // The sheet's hash is in its URL: one made again under the same name would be served
                    // from the cache for an hour, and read with the new one's geometry.
                    storyboard={currentDetails?.storyboard
                      ? {
                        ...currentDetails.storyboard,
                        url: `${fileUrl(media.path)}/thumbnails/${currentDetails.storyboard.name}?sha=${currentDetails.storyboard.sha256.slice(0, 16)}`,
                      }
                      : undefined}
                    compact={isMobile}
                    slideshow={slideshow}
                    drawing={addingFace}
                    keysEnabled={playerKeys}
                    coveredBottom={infoRowHeight}
                    onEnded={slideshow ? advanceSlideshow : undefined}
                    onStalled={() => setStalledId(media.id)}
                    onPlay={() => setStalledId(null)}
                  />
                )
                : (
                  <>
                    {activeSlideshowPhotoTransition && (
                      <LightboxPhoto
                        key={`${activeSlideshowPhotoTransition.outgoing.id}-${activeSlideshowPhotoTransition.outgoingReloadToken}`}
                        media={activeSlideshowPhotoTransition.outgoing}
                        reloadToken={activeSlideshowPhotoTransition.outgoingReloadToken}
                        data-lightbox-slideshow-outgoing
                        alt=''
                        aria-hidden
                        style={{
                          position: 'absolute',
                          inset: 0,
                          zIndex: 0,
                          width: '100%',
                          height: '100%',
                          objectFit: 'contain',
                          pointerEvents: 'none',
                          transform: activeSlideshowPhotoTransition.outgoingTransform,
                          opacity: activeSlideshowPhotoTransition.started ? 0 : 1,
                          transition: `opacity ${SLIDE_CROSSFADE_DURATION_MS}ms ease`,
                          willChange: 'opacity',
                        }}
                      />
                    )}
                    <LightboxPhoto
                      key={`${media.id}-${reloadToken}`}
                      media={media}
                      reloadToken={reloadToken}
                      data-lightbox-slideshow-incoming={activeSlideshowPhotoTransition ? '' : undefined}
                      imageRef={(el) => {
                        mediaRef.current = el;
                      }}
                      alt={media.name}
                      sizes={zoomedSizes(zoom.scale)}
                      className={slideshow ? kenBurnsClass : undefined}
                      onLoad={() => handleSlideshowPhotoLoad(media.id)}
                      // A missing rendition should not freeze the whole slideshow.
                      onError={() => handleSlideshowPhotoError(media.id)}
                      style={{
                        position: 'relative',
                        zIndex: 1,
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        opacity: activeSlideshowPhotoTransition?.started ? 1 : activeSlideshowPhotoTransition ? 0 : 1,
                        transition: activeSlideshowPhotoTransition ? `opacity ${SLIDE_CROSSFADE_DURATION_MS}ms ease` : undefined,
                        ...kenBurnsTiming,
                        animationPlayState: loadedPhotoId === media.id ? 'running' : 'paused',
                      }}
                    />
                  </>
                )}

              {
                /* Always mounted: the boxes are invisible hit targets until one is hovered,
                and `showFaces` only pins them permanently on. */
              }
              {media.type === 'photo' && (faces.length > 0 || addingFace) && (!slideshow || showFaces) && (
                <FaceOverlay
                  // The media element is keyed too. Remount the observer with it so its
                  // load/resize listeners never stay attached to the image we just left.
                  key={`face-overlay-${media.id}-${reloadToken}`}
                  mediaRef={mediaRef}
                  faces={faces}
                  pinned={showFaces}
                  hoveredKey={hoveredFace}
                  onHover={setHoveredFace}
                  onOpenPerson={goTo}
                  onReviewUnknown={setReviewPersonId}
                  labelsOnly={slideshow}
                  motionClassName={slideshow ? kenBurnsClass : undefined}
                  motionRunning={loadedPhotoId === media.id}
                  scale={zoom.scale}
                  drawing={addingFace}
                  saving={savingFace}
                  onCreateFace={createFace}
                  onUpdateFace={updateFace}
                  onRemoveFace={removeFace}
                  onChangePerson={setPersonFacePath}
                  onDraftChange={setFaceDraftReady}
                />
              )}
              {showText && pictureText && !slideshow && (
                <TextOverlay
                  key={`text-overlay-${media.id}-${reloadToken}`}
                  mediaRef={mediaRef}
                  path={media.path}
                  text={pictureText}
                  truncated={currentDetails?.contentTruncated}
                  onEdit={mayWriteText ? () => setEditingText(true) : undefined}
                />
              )}
            </Box>
            {/* Over the picture, the arrow of the half the mouse is on, where there is a file that way. */}
            {!slideshow && !isMobile && ([['previous', 'chevron-left', 'Previous media'], ['next', 'chevron-right', 'Next media']] as const).map((
              [side, icon, label],
            ) =>
              hoverSide === side && (side === 'next' ? hasNextMedia.value : hasPrevMedia.value) && (
                <ActionIcon
                  key={side}
                  variant='subtle'
                  color='gray'
                  size='xl'
                  onClick={() => slideToMedia(side)}
                  aria-label={label}
                  style={{
                    position: 'absolute',
                    zIndex: 9,
                    [side === 'previous' ? 'left' : 'right']: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 48,
                    height: 64,
                    borderRadius: 'var(--mantine-radius-md)',
                    background: 'rgba(0, 0, 0, 0.55)',
                    backdropFilter: 'blur(4px)',
                  }}
                >
                  <TablerIcon name={icon} size={32} color='white' />
                </ActionIcon>
              )
            )}

            {showToolbar && mayUseToolbar && !slideshow && (
              <FileToolbar
                media={media}
                result={detailsResult}
                mobile={isMobile}
                canEdit={canEdit}
                addToAlbumPath={actionPath}
                canOrient={canOrient}
                orienting={orienting}
                onTurn={turn}
                addingFace={addingFace}
                onAddFace={addFace}
                onEditText={mayWriteText ? () => setEditingText(true) : undefined}
                onEditSubtitles={mayWriteSubtitles ? () => setEditingSubtitles(true) : undefined}
                onLayer={setToolbarLayer}
                // Below the phone's date and menu button at the top, between the desktop's close and chat buttons.
                top={isMobile ? MOBILE_TOOLBAR_TOP_PX : 8}
                // A phone's icons larger than the bar's, in buttons that keep eight in a narrow phone's width.
                iconSize={isMobile ? 28 : barIconSize}
                buttonSize={barButtonSize}
              />
            )}
          </Box>

          <Group
            ref={infoRowRef}
            data-lightbox-info
            justify='center'
            // The row takes its height from the picture, so it stays one line at any width: a
            // second line arriving with the details would shrink the picture under the zoom
            // that opened it. The location gives way first and truncates, then the date and
            // the counter. A
            // phone's row has tight gaps besides. A slideshow's bar floats over the picture
            // and costs it no height, so there the date may push the location onto a second
            // line.
            gap={isMobile ? 8 : 'lg'}
            px={isMobile ? 'xs' : 'md'}
            // A phone's larger buttons carry their own padding.
            py={isMobile ? 4 : 'xs'}
            wrap={slideshow ? 'wrap' : 'nowrap'}
            style={{
              minHeight: 44,
              flexShrink: 0,
              color: 'white',
              // Moves with a phone's details panel (see `beginSheet`).
              ...(isMobile && !slideshow
                ? {
                  // Upright it rides up on the sheet. Sideways it spans what the panel leaves, and
                  // its items are spread across that, so it narrows rather than moves: a small
                  // row's layout, the one thing here that is not a transform.
                  transform: 'translateY(calc(var(--sheet-p, 0) * var(--sheet-iy, 0px)))',
                  width: 'calc(100% - var(--sheet-p, 0) * var(--sheet-iw, 0px))',
                  transition: 'var(--sheet-transition, none)',
                }
                : {}),
              ...(slideshow
                ? {
                  position: 'absolute',
                  zIndex: 10,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.72))',
                  paddingTop: 24,
                }
                : {}),
            }}
          >
            {barButton(favouriteAction)}

            <SwipeInfo step={swipeInfoStep} current={barInfo} short={shortTaken}>
              {({ index }) =>
                !lightboxCountHidden.value && (
                  <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                    <TablerIcon name='photo' size={barIconSize} style={{ flexShrink: 0 }} />
                    <Text data-bar-text size='md' c='inherit' truncate='end'>
                      {index + 1} of {albumMediaList.value.length}
                    </Text>
                  </Group>
                )}
            </SwipeInfo>

            {slideshow && !isMobile
              ? (
                <Tooltip label='Stop slideshow' withArrow>
                  <ActionIcon variant='subtle' color='gray' size={barButtonSize} onClick={stopSlideshow} aria-label='Stop slideshow' style={{ flexShrink: 0 }}>
                    <TablerIcon name='player-stop' size={barIconSize} color='white' />
                  </ActionIcon>
                </Tooltip>
              )
              : barButton(slideshowAction)}

            <SwipeInfo step={swipeInfoStep} current={barInfo} short={shortTaken}>
              {({ taken, takenLabel, takenTooltip }) =>
                (slideshow || !isMobile) && taken.date && (
                  <Tooltip label={takenTooltip} withArrow disabled={!takenTooltip} multiline maw={320}>
                    <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                      <TablerIcon name='calendar' size={barIconSize} style={{ flexShrink: 0 }} />
                      <Text data-bar-text size='md' c='inherit' truncate='end'>{takenLabel}</Text>
                    </Group>
                  </Tooltip>
                )}
            </SwipeInfo>

            {addingFace && (
              <Group data-lightbox-face-draw-hint gap='xs' wrap='nowrap'>
                <Text size='md' c='inherit'>
                  {savingFace ? 'Saving face…' : faceDraftReady ? 'Adjust the box, change who it is, or remove it' : 'Draw a new box or select a face'}
                </Text>
                <ActionIcon
                  variant='subtle'
                  color='gray'
                  size={barButtonSize}
                  disabled={savingFace}
                  onClick={() => {
                    setAddingFace(false);
                    setFaceDraftReady(false);
                    setFaceMessage(null);
                  }}
                  aria-label='Cancel drawing face'
                >
                  <TablerIcon name='x' size={barIconSize} color='white' />
                </ActionIcon>
              </Group>
            )}

            {faceMessage && <Text size='xs' c={faceMessage.color ?? 'inherit'}>{faceMessage.text}</Text>}

            <SwipeInfo step={swipeInfoStep} current={barInfo} short={shortTaken}>
              {({ where }) =>
                where && (
                  // Shrinks a thousand times as readily as the date and the counter, so they keep
                  // their words until this one is down to its pin.
                  <Group gap={6} wrap='nowrap' style={{ minWidth: barIconSize, flexShrink: 1000 }}>
                    <TablerIcon name='map-pin' size={barIconSize} style={{ flexShrink: 0 }} />
                    <Text data-bar-text size='md' c='inherit' truncate='end' maw={isMobile ? undefined : 360}>{where}</Text>
                  </Group>
                )}
            </SwipeInfo>

            {viewActions.map(barButton)}
            {barButton(downloadAction)}

            {!slideshow && !isMobile && menuActions.length > 0 && (
              <Menu position='top-end' shadow='md' withinPortal>
                <Menu.Target>
                  <Tooltip label='More' withArrow>
                    <ActionIcon variant='subtle' color='gray' size={barButtonSize} aria-label='More actions' style={{ flexShrink: 0 }}>
                      <TablerIcon name='dots-vertical' size={barIconSize} color='white' />
                    </ActionIcon>
                  </Tooltip>
                </Menu.Target>
                <Menu.Dropdown>
                  {actionMenuItems(14)}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>

          {
            /* Hidden, the details leave a handle at the right edge, above the bar, to bring them back,
              with the chat's button beneath while the chat is closed. */
          }
          {withDetails && !slideshow && !isMobile && !sidebarOpen && (
            <Box className='mrx-lightbox-side-handle'>
              <Tooltip label='Show details (i)' position='left' withArrow>
                <ActionIcon variant='subtle' color='gray' size='lg' radius='md' aria-label='Show details' onClick={() => toggleSheet(true)}>
                  <TablerIcon name='layout-sidebar-right-expand' size={20} />
                </ActionIcon>
              </Tooltip>
              <DrawerButtons color={SIDE_ICON_COLOR} hideOpen tooltipPosition='left' />
            </Box>
          )}
        </Box>

        {!slideshow && isMobile
          ? withDetails && (
            // A phone keeps its details panel mounted, off screen when closed, so that it can
            // move with a finger or slide (see `beginSheet`): upright a sheet over the bottom
            // half, sideways a panel over the right. Closed, it draws the picture the viewer
            // stays on rather than each one passed (`detailsMediaId`).
            <Box
              ref={sheetPanelRef}
              data-lightbox-mobile-bottom-bar={mobilePortrait ? '' : undefined}
              data-lightbox-side-panel={mobilePortrait ? undefined : ''}
              aria-hidden={!sidebarOpen}
              inert={!sidebarOpen}
              onTouchStart={mobilePortrait ? handlePanelTouchStart : handleSidePanelTouchStart}
              onTouchMove={mobilePortrait ? handlePanelTouchMove : handleSidePanelTouchMove}
              onTouchEnd={mobilePortrait ? handlePanelTouchEnd : handleSidePanelTouchEnd}
              onTouchCancel={() => {
                panelTouchRef.current = null;
                sidePanelTouchRef.current = null;
                endSheet(0);
              }}
              style={{
                position: 'absolute',
                zIndex: 20,
                display: 'flex',
                minHeight: 0,
                overflow: 'hidden',
                pointerEvents: sidebarOpen ? 'auto' : 'none',
                transition: 'var(--sheet-transition, none)',
                willChange: 'transform',
                ...(mobilePortrait
                  ? {
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: '50dvh',
                    transform: `translateY(calc((1 - var(--sheet-p, ${sidebarOpen ? 1 : 0})) * 100%))`,
                  }
                  : {
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: SIDEBAR_WIDTH,
                    transform: `translateX(calc((1 - var(--sheet-p, ${sidebarOpen ? 1 : 0})) * 100%))`,
                  }),
              }}
            >
              {drawnDetailsRef.current}
            </Box>
          )
          : sideMounted && !slideshow && (
            // Slides in from the right as the room for it opens beside the picture, and back out.
            <Box
              className='mrx-lightbox-side'
              data-closing={!sidebarOpen || undefined}
              data-instant={!sideSettled || undefined}
              inert={!sidebarOpen}
              style={{ '--mrx-lightbox-side-w': `${SIDEBAR_WIDTH}px` } as CSSProperties}
            >
              {detailsSidebar(false)}
            </Box>
          )}
      </Box>
      <Dialog
        opened={mapOpen && !!mapPoint}
        onClose={() => setMapOpen(false)}
        closeOnEscape={false}
        fullScreen={isMobile}
        size='min(1000px, calc(100vw - 32px))'
        zIndex={300}
        title={barInfo.where || 'Where it was taken'}
        subtitle={media.name}
        icon='map-pin'
        pattern='location'
        bleed
      >
        {mapPoint && (
          <Box
            data-lightbox-location-map
            style={{ flex: isMobile ? 1 : undefined, height: isMobile ? undefined : 'min(70dvh, 700px)', minHeight: 320 }}
          >
            <MapView center={mapPoint} zoom={14} style={{ height: '100%' }}>
              <MapShape shape={mapPoint} />
              <MapMarkers
                markers={[{
                  id: `lightbox-${media.id}`,
                  lat: mapPoint.lat,
                  lng: mapPoint.lng,
                  label: media.name,
                  thumbnailUrl: media.thumbnailUrl,
                }]}
              />
            </MapView>
          </Box>
        )}
      </Dialog>
      {mayWriteText && (
        <TextEditDialog
          opened={editingText}
          media={media}
          reloadToken={reloadToken}
          text={pictureText ?? ''}
          truncated={currentDetails?.contentTruncated ?? false}
          onSave={saveText}
          onClose={() => setEditingText(false)}
        />
      )}
      {mayWriteSubtitles && (
        <SubtitleEditDialog
          opened={editingSubtitles}
          media={media}
          reloadToken={reloadToken}
          transcript={currentDetails?.hasTranscript ? { language: currentDetails.transcriptLanguage, speakers: currentDetails.speakers } : undefined}
          onSave={saveSubtitles}
          onClose={() => setEditingSubtitles(false)}
        />
      )}
      <FacePersonDialog face={personFace} named={namedPeople} onClose={() => setPersonFacePath(null)} onChanged={facePersonChanged} />
      <UnknownPersonModal
        person={reviewPerson}
        named={namedPeople}
        onClose={() => setReviewPersonId(null)}
        onName={nameReviewedPerson}
        onMerge={mergeReviewedPerson}
        onDiscard={discardReviewedPerson}
        onFacesChanged={() => {
          refetch();
          refetchReviewPerson();
        }}
        overLightbox
      />
    </>
  );
}
