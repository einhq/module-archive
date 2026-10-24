import { UnknownPersonModal } from '../../people/components/UnknownPersonModal.tsx';
import { Dialog, DrawerButtons, DrawerMenuItems, MapMarkers, MapShape, MapView, TablerIcon } from '@ein/ui/components';
import { PEOPLE_ROOT } from '@archive/paths';
import { ActionIcon, Box, Group, Kbd, Menu, Stack, Text, Tooltip } from '@mantine/core';
import { useHotkeys, useMediaQuery } from '@mantine/hooks';
import { effect } from '@preact/signals-react';
import { useSignals } from '@preact/signals-react/runtime';
import {
  type CSSProperties,
  type ImgHTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type TouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { bumpDerivativeVersion, bust, canWrite, displayDims, fileUrl, forgetAspect, isGuest, mediaItemFrom, posterUrl, shq, versionOf } from '@ein/ui/lib';
import { zoomFromTile, zoomToTile } from '../lib/lightbox-tile-zoom.ts';
import { itemAtAngle, lightboxPhotoSources } from '../lib/lightbox-image.ts';
import { lightboxSheetOpens, lightboxSwipeAction, lightboxSwipeFinish, type LightboxTouchPoint, releaseVelocityX, releaseVelocityY } from '../lib/lightbox-gesture.ts';
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
  ZOOM_IDENTITY,
  zoomAt,
  zoomedSizes,
  type ZoomFrame,
  type ZoomPoint,
  type ZoomState,
} from '../lib/lightbox-zoom.ts';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { useUnknownPerson } from '../../people/hooks/useUnknownPeople.ts';
import { useAccessIds, useShortcutHelp, useSurface } from '@ein/ui/hooks';
import { type StackMemberRef, useMediaDetails } from '../hooks/useMediaDetails.ts';
import { useWakeLock } from '../hooks/useWakeLock.ts';
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
import { FaceOverlay, toFaceMarks } from './FaceOverlay.tsx';
import { type FacePersonChange, FacePersonDialog } from './FacePersonDialog.tsx';
import { MediaSidebar, SIDEBAR_WIDTH } from './MediaSidebar.tsx';
import { TextEditDialog } from './TextEditDialog.tsx';
import { TextOverlay } from './TextOverlay.tsx';
import { VideoPlayer } from './VideoPlayer.tsx';
import { formatTakenParts, type TakenParts, timeSourceLabel, viewerLocalTime } from '../lib/capture-time.ts';
import { requestAlbumMediaRefresh } from '../signals/album.ts';
import { facesVisible, infoSidebarOpen, lightboxCountHidden, toggleFacesVisible, toggleInfoSidebar } from '../signals/lightbox.ts';

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
const SWIPE_ANIMATION_MS = 180;
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
const ZOOM_ANIMATION_MS = 200;
const SWIPE_FRAME_GAP_PX = 10;
/** The settled frame's inset on a desktop, each side, clear of the arrows. */
const SWIPE_ARROW_INSET_PX = 60;
const NATIVE_EDGE_GESTURE_PX = 24;
const GESTURE_CONTROL_SELECTOR = 'button, a, input, textarea, select, audio, [role="button"], [role="slider"], [data-face-mark], [data-text-overlay], [data-video-controls]';

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
 * so a file known only to a year never shows a fabricated day and hour. The month is written
 * out in English, day first, the way the grid's date headers say it, so the two never
 * disagree about the same picture.
 * `short` abbreviates the day and month names ("Sat, 28 Feb 2026") for a narrow bar.
 */
function formatLightboxTaken(iso?: string, short = false): TakenParts {
  return formatTakenParts(iso, 'en-GB', short ? { seconds: true, weekday: 'short' } : { seconds: true, weekday: true, long: true });
}

/** Prefer a named location, then the best human-readable reverse-geocoded location. */
function locationLabel(details: ReturnType<typeof useMediaDetails>['details']): string {
  if (details?.location?.name) return details.location.name;
  if (details?.position?.address) return details.position.address;
  return [details?.position?.city, details?.position?.country].filter(Boolean).join(', ');
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
  // Switches to the swiped-to media; run early when a new touch lands before the slide is over.
  const swipePendingRef = useRef<(() => void) | null>(null);
  const [stackPreview, setStackPreview] = useState<MediaItem | null>(null);
  const [stackBusy, setStackBusy] = useState(false);
  const [addingFace, setAddingFace] = useState(false);
  /** A dialog of the sidebar's is open over the lightbox: the keys it leaves are not the lightbox's either. */
  const [sidebarLayer, setSidebarLayer] = useState(false);
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
  const { details, detailsPath, refetch, setOrientation, orienting, setText } = detailsResult;
  const canEdit = details?.ownership !== undefined && canWrite(details.ownership, access);
  // Only this file's details: straight after a swipe `details` still describes the previous one,
  // whose faces would be drawn over the new picture, and whose state would be taken for this one's,
  // until its own details arrive.
  const faceDetails = details && detailsPath === media?.path ? details : null;
  // Rotating an undecodable source would queue a re-encode of bytes ffmpeg cannot open, so the
  // buttons are not offered for one.
  const canOrient = media?.type !== 'audio' && faceDetails !== null && !faceDetails.undecodable && canEdit;
  const { person: reviewPerson, refetch: refetchReviewPerson } = useUnknownPerson(reviewPersonId ?? undefined);
  const { people: namedPeople } = usePeople(PEOPLE_ROOT, reviewPersonId !== null || personFacePath !== null);

  // Boxes are drawn over photos only: a video's face box holds for the one moment it was seen
  // at, so its faces are listed in the sidebar with when they are on screen instead.
  const faces = useMemo(() => media?.type === 'photo' ? toFaceMarks(faceDetails?.faces ?? []) : [], [faceDetails, media?.type]);
  const personFace = faceDetails?.faces.find((face) => face.facePath === personFacePath) ?? null;
  // The text in a photo, which the "more" menu lays over it, and opens for writing, in a dialog
  // beside the picture, to whoever may write the photo. Shown, it stays on from picture to
  // picture, for paging through scanned pages, until the lightbox closes.
  const pictureText = withDetails && media?.type === 'photo' ? faceDetails?.content : undefined;
  const mayWriteText = withDetails && media?.type === 'photo' && faceDetails !== null && canEdit;
  const [showText, setShowText] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const toggleText = useCallback(() => setShowText((shown) => !shown), []);
  const saveText = useCallback(async (text: string) => {
    await setText(text);
    setEditingText(false);
    setShowText(text.trim() !== '');
  }, [setText]);
  useEffect(() => {
    if (isOpen) return;
    setShowText(false);
    setEditingText(false);
  }, [isOpen]);

  // Opened by its URL alone, a file is known by its path only and shown as a picture; its
  // details say what it is, so a video or a recording gets its player.
  const detailsMimetype = faceDetails?.mimetype;
  useEffect(() => {
    if (!media || !detailsMimetype || detailsMimetype === media.mimetype || media.mimetype !== mediaItemFrom({ path: media.path }).mimetype) return;
    const known = mediaItemFrom({ path: media.path, mimetype: detailsMimetype });
    albumMediaList.value = albumMediaList.peek().map((item) => item.path === known.path ? known : item);
  }, [detailsMimetype, media]);

  // The details are read fresh after a turn, so they know which way the picture stands now; the
  // item came from a list read before it. The shrink back into the tile and the renditions asked
  // for both follow the item's shape.
  const detailsAngle = faceDetails?.angle;
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
    // The unknown-person review dialog is layered above this modal and owns
    // Escape while it is open. Let its capture handler close only that layer.
    if (reviewPersonId) return;
    // So does a dialog the sidebar opened, the edit or the sharing dialog.
    if (sidebarLayer) return;
    if (addingFace) {
      setAddingFace(false);
      setFaceDraftReady(false);
      setFaceMessage(null);
      return;
    }
    if (slideshow) stopSlideshow();
    else requestClose();
  }, [addingFace, editingText, mapOpen, requestClose, reviewPersonId, sidebarLayer, slideshow, stopSlideshow]);

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

  // Warm the browser cache with the neighbours a swipe or arrow key reaches next, using the
  // same source ladder the settled frame and the swipe preview will request. It waits for
  // the current photo so the visible picture never competes with invisible ones; a
  // slideshow's dwell timer still starts from the next slide's own load event, so a slow
  // network never spends the dwell on an invisible image.
  useEffect(() => {
    const list = albumMediaList.value;
    if (!media || list.length < 2) return;
    if (media.type === 'photo' && loadedPhotoId !== media.id) return;
    const index = currentMediaIndex.value;
    const neighbours = [list[nextMediaIndex(index, list.length)], list[prevMediaIndex(index, list.length)]]
      .filter((item, i, all): item is MediaItem => item !== undefined && item.id !== media.id && all.indexOf(item) === i);
    neighbourPreloadRef.current = neighbours.map((item) => {
      const token = versionOf(item.path);
      const preload = new Image();
      if (item.type !== 'photo') {
        preload.src = bust(posterUrl(item.path, item.type, item.hasDerivatives, displayDims(item)), token);
        return preload;
      }
      const sources = lightboxPhotoSources(item, token);
      let usingFallback = false;
      preload.onerror = () => {
        if (usingFallback || !sources.fallback) return;
        usingFallback = true;
        preload.srcset = '';
        preload.removeAttribute('sizes');
        preload.src = sources.fallback.src;
      };
      if (sources.primary.srcSet) {
        preload.srcset = sources.primary.srcSet;
        preload.sizes = '100vw';
      }
      preload.src = sources.primary.src;
      return preload;
    });
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

  const namePerson = useCallback(async (personPath: string, name: string) => {
    await execCommand(`person-name ${shq(personPath)} --name ${shq(name)}`);
    await refetch();
  }, [refetch]);

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
    if (!media || media.type !== 'photo') return;
    setSavingFace(true);
    setFaceMessage(null);
    try {
      const encoded = [box.x, box.y, box.width, box.height].map((value) => value.toFixed(6)).join(',');
      const result = await execCommand<{ personId: string; cropError?: string }>(`face-add ${shq(media.path)} --box ${encoded}`);
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

  // Only a still picture zooms: video has its own controls under the pointer, and the slideshow
  // is already moving the picture itself.
  const zoomable = media?.type === 'photo' && !slideshow;

  const setZoom = useCallback((next: ZoomState, animate: boolean) => {
    zoomRef.current = next;
    setZoomAnimating(animate);
    setZoomState(next);
  }, []);

  /** The transformed box and the contained picture inside it, both at scale 1. */
  const zoomFrame = useCallback((): ZoomFrame => {
    const box = zoomBoxRef.current;
    const viewport = { width: box?.offsetWidth ?? globalThis.innerWidth, height: box?.offsetHeight ?? globalThis.innerHeight };
    const image = mediaRef.current;
    if (image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0) {
      const scale = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight);
      if (scale > 0) return { viewport, content: { width: image.naturalWidth * scale, height: image.naturalHeight * scale } };
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
    const onWheel = (event: WheelEvent) => {
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
    // Two taps arrive here too, as the browser's synthesized dblclick, after the touch
    // handler has already toggled on them; acting twice would undo it.
    if (!zoomable || lastPointerTypeRef.current === 'touch' || isGestureControl(event.target)) return;
    event.preventDefault();
    setZoom(toggleZoom(zoomRef.current, zoomFocal(event.clientX, event.clientY), zoomFrame()), true);
  }, [setZoom, zoomFocal, zoomFrame, zoomable]);

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

  const resetSwipe = useCallback(() => {
    globalThis.clearTimeout(swipeTransitionTimerRef.current);
    const surface = gestureSurfaceRef.current;
    surface?.style.removeProperty('--swipe-transition');
    surface?.style.removeProperty('--swipe-x');
  }, []);

  // Any change of media, a finished swipe included, starts the new frame centred. A layout
  // effect, so the frame is moved back in the same paint that first shows the new media.
  useLayoutEffect(() => resetSwipe(), [media?.id, resetSwipe]);

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
   * either end, takes over.
   */
  const beginSheet = useCallback((progress: number): boolean => {
    const root = sheetRootRef.current;
    const panel = sheetPanelRef.current;
    const info = infoRowRef.current;
    if (!root || !panel || !info) return false;
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

  const handleTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    touchStartRef.current = null;
    touchPanRef.current = null;
    tapStartRef.current = null;
    touchAxisRef.current = null;
    // A second finger while the sheet is held lets it go where it is heading.
    if (sheetDragRef.current && event.touches.length > 1) endSheet(0);
    if (swipePendingRef.current) {
      // A flick straight after a flick: land the first where it was going and start from there.
      globalThis.clearTimeout(swipeTimerRef.current);
      swipePendingRef.current();
    }
    // Drawing a face box takes the finger for itself.
    if (!isMobile || slideshow || addingFace) return;
    // A face box is tapped to open it but is no reason to refuse a drag across the picture; group
    // photos are mostly faces.
    const onFaceMark = event.target instanceof Element && event.target.closest('[data-face-mark]') !== null;
    // A video's picture swipes like a photo; its controls are controls (`data-video-controls`).
    if (isGestureControl(event.target) && !onFaceMark) return;

    if (event.touches.length === 2 && zoomable) {
      // A second finger during a swipe turns it into a pinch; drop the swipe where it is.
      resetSwipe();
      const [a, b] = [event.touches[0], event.touches[1]];
      const geometry = pinchGeometry(zoomFocal(a.clientX, a.clientY), zoomFocal(b.clientX, b.clientY));
      pinchRef.current = { state: zoomRef.current, ...geometry };
      return;
    }
    pinchRef.current = null;
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    // Leave the screen edges to the browser/OS so its native Back gesture can close
    // the history-backed lightbox instead of being mistaken for previous/next media,
    // or for a pan.
    if (touch.clientX <= NATIVE_EDGE_GESTURE_PX || touch.clientX >= globalThis.innerWidth - NATIVE_EDGE_GESTURE_PX) return;
    if (!onFaceMark) tapStartRef.current = touchPoint(touch, event.timeStamp);
    if (zoomable && isZoomed(zoomRef.current)) {
      // One finger on a zoomed picture drags it; previous/next wait until it is back at fit.
      touchPanRef.current = { x: touch.clientX, y: touch.clientY };
      return;
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    swipeSamplesRef.current = [touchStartRef.current];
  }, [addingFace, endSheet, isMobile, resetSwipe, slideshow, zoomFocal, zoomable]);

  const settleSwipe = useCallback(() => {
    moveSwipe(0, { durationMs: SWIPE_ANIMATION_MS, easing: SWIPE_SETTLE_EASING });
  }, [moveSwipe]);

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
    // and ends with the incoming neighbour exactly centred.
    const travel = direction * swipeFrameWidth();
    const finish = lightboxSwipeFinish(Math.abs(travel) - Math.abs(releaseOffset), releaseVelocity * direction);
    // Marked now rather than at the switch, so the sliding neighbour's element is the one kept
    // as the handoff and is never remounted.
    setSwipeTarget(target);
    moveSwipe(travel, finish);
    const complete = () => {
      swipePendingRef.current = null;
      // The incoming preview is centred and the old frame beyond the edge. Freeze them there, so
      // nothing slides while the media switches, then let the switch recentre the frame on the
      // new media above the preview, which stays until the frame has loaded.
      moveSwipe(travel);
      if (action === 'next') goToNextMedia();
      else goToPrevMedia();
    };
    swipePendingRef.current = complete;
    swipeTimerRef.current = globalThis.setTimeout(complete, finish.durationMs);
  }, [moveSwipe, settleSwipe]);

  // The arrow buttons and keys slide the neighbour in as a released swipe would. A press while
  // a slide is still running lands that one and steps on at once, so holding a key or clicking
  // quickly is never held back by the animation.
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
    finishPhotoSwipe(action, 0, 0);
  }, [finishPhotoSwipe, slideshow]);

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
      moveSwipe(allowed ? dx : dx * 0.18);
    } else if (touchAxisRef.current === 'sheet' && sheetDragRef.current) {
      moveSheet(sheetDragRef.current.from - dy / sheetDragRef.current.panelPx);
    }
  }, [beginSheet, mobilePortrait, moveSheet, moveSwipe, setZoom, zoomFocal, zoomFrame]);

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
    if (!start || event.changedTouches.length !== 1) return;

    const touch = event.changedTouches[0];
    const end = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    if (touchAxisRef.current === 'sheet') {
      endSheet(releaseVelocityY(swipeSamplesRef.current, end));
      return;
    }
    const velocityX = releaseVelocityX(swipeSamplesRef.current, end);
    const action = lightboxSwipeAction(start, end, { velocityX, width: globalThis.innerWidth });
    switch (action) {
      case 'next':
      case 'previous':
        finishPhotoSwipe(action, end.x - start.x, velocityX);
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
  }, [endSheet, finishPhotoSwipe, requestClose, setZoom, settleSwipe, toggleSheet, zoomFocal, zoomFrame, zoomable]);

  useShortcutHelp('Lightbox', withDetails ? LIGHTBOX_SHORTCUTS : LIGHTBOX_SHORTCUTS.filter((entry) => entry.keys !== 'i'));
  useHotkeys([
    // The text dialog is over the picture: the keys are its own while it is open.
    ['ArrowLeft', () => !addingFace && !editingText && slideToMedia('previous')],
    ['ArrowRight', () => !addingFace && !editingText && slideToMedia('next')],
    ['Escape', handleEscape],
    ['i', () => !sidebarLayer && !editingText && toggleSheet(!infoSidebarOpen.value)],
    ['f', () => !sidebarLayer && !editingText && toggleFacesVisible()],
    ['t', () => !sidebarLayer && !editingText && pictureText && toggleText()],
    ['s', () => !sidebarLayer && !editingText && toggleStar()],
    // `+` is shifted on most layouts and `=` is its unshifted key on a US one. These keys
    // have no default worth suppressing, so they are left alone for whatever else listens.
    ['plus', () => zoomable && setZoom(stepZoom(zoomRef.current, 1, zoomFrame()), true), { preventDefault: false }],
    ['shift+plus', () => zoomable && setZoom(stepZoom(zoomRef.current, 1, zoomFrame()), true), { preventDefault: false }],
    ['=', () => zoomable && setZoom(stepZoom(zoomRef.current, 1, zoomFrame()), true), { preventDefault: false }],
    ['minus', () => zoomable && setZoom(stepZoom(zoomRef.current, -1, zoomFrame()), true), { preventDefault: false }],
    ['0', () => zoomable && resetZoom(), { preventDefault: false }],
  ]);

  // The players' keys rest while a layer over the lightbox has the keyboard, as the lightbox's own do.
  const playerKeys = !sidebarLayer && !editingText && !addingFace && !mapOpen && reviewPersonId === null && personFacePath === null;
  const attachMediaElement = useCallback((el: HTMLVideoElement | null) => {
    mediaRef.current = el;
  }, []);

  // A recording the browser will not start by itself (an autoplay policy), one that fails, or one
  // known to be undecodable never ends; a slideshow moves past it after one slide's time rather
  // than stopping there. A stall lasts until the recording plays after all.
  const [stalledId, setStalledId] = useState<string | null>(null);
  const undecodableAv = (media?.type === 'video' || media?.type === 'audio') && Boolean(faceDetails?.undecodable);
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

  if (!media) return null;

  const isVideo = media.type === 'video';
  const isAudio = media.type === 'audio';
  // A source ffprobe could not read at all — no rendition exists and none can be made, so the
  // player below would be controls over nothing. Say what is wrong instead. Only for a/v: it is
  // the only family `exif-extract` probes, and `details` is the read the sidebar already makes.
  const undecodable = (isVideo || isAudio) ? faceDetails?.undecodable : undefined;
  const takenAt = details?.takenAt ?? media.takenAt;
  // An upright phone's slideshow bar carries the date beside the counter and location; the short
  // names keep it on one line.
  const taken = formatLightboxTaken(takenAt, slideshow && mobilePortrait);
  const takenLabel = taken.clock ? `${taken.date}, ${taken.clock}` : taken.date;
  // A photograph is shown on the clock the photographer was reading. The viewer's own time is
  // offered beside it only when the two differ, which on this archive means the pictures taken
  // abroad and nothing else.
  const takenHere = viewerLocalTime(takenAt, details?.takenAtUtc);
  const takenSource = timeSourceLabel(details?.takenAtSource, details?.digitized);
  const takenNote = details?.takenAtNote;
  const takenTooltip = [takenHere && `${takenHere} your time`, takenSource, takenNote].filter(Boolean).join(' · ');
  const where = locationLabel(details);
  // Match the sidebar preview: embedded GPS is more specific than the linked
  // location, but either is enough to locate the media on the enlarged map.
  const mapPoint = details?.position ??
    (details?.location?.lat !== undefined && details.location.lng !== undefined
      ? { lat: details.location.lat, lng: details.location.lng, radius: details.location.radius }
      : null);
  // The picture the sidebar's add-to-album row acts on; that is not the guest's to do.
  const actionPath = albumMedia && !isGuest(access) ? albumMedia.path : undefined;
  // The faces, text, fullscreen and download rows that open the "more" menu, on a phone and a desktop
  // alike, with icons the size of the rows around them. Download saves the original file, as the
  // file name in the details does.
  const viewMenuItems = (iconSize: number) => (
    <>
      {media?.type === 'photo' && (
        <Menu.Item
          leftSection={<TablerIcon name='user-square-rounded' size={iconSize} color={showFaces && faces.length > 0 ? 'var(--mrx-accent)' : undefined} />}
          rightSection={isMobile ? undefined : <Kbd size='xs'>f</Kbd>}
          disabled={faces.length === 0}
          onClick={toggleFacesVisible}
        >
          {faces.length === 0 ? 'No faces' : `${showFaces ? 'Unpin' : 'Pin'} faces`}
        </Menu.Item>
      )}
      {pictureText && (
        <Menu.Item
          leftSection={<TablerIcon name='text-scan-2' size={iconSize} color={showText ? 'var(--mrx-accent)' : undefined} />}
          rightSection={isMobile ? undefined : <Kbd size='xs'>t</Kbd>}
          onClick={toggleText}
        >
          {showText ? 'Hide text' : 'Show text'}
        </Menu.Item>
      )}
      {mayWriteText && (
        <Menu.Item leftSection={<TablerIcon name='pencil' size={iconSize} />} onClick={() => setEditingText(true)}>
          {pictureText ? 'Edit text' : 'Add text'}
        </Menu.Item>
      )}
      <Menu.Item leftSection={<TablerIcon name={fullscreen ? 'minimize' : 'maximize'} size={iconSize} />} onClick={toggleFullscreen}>
        {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      </Menu.Item>
      <Menu.Item component='a' href={fileUrl(media.path)} download={media.name} leftSection={<TablerIcon name='download' size={iconSize} />}>
        Download
      </Menu.Item>
    </>
  );
  const kenBurnsClass = kenBurnsClassForIndex(currentMediaIndex.value, kenBurns);
  const zoomed = zoomable && isZoomed(zoom);
  const activeSlideshowPhotoTransition = slideshowPhotoTransition?.incomingId === media.id ? slideshowPhotoTransition : undefined;
  // Both neighbours are kept mounted beside the frame once it has loaded, so the first
  // movement of a drag finds their pictures ready instead of mounting them. With two media the
  // neighbours are one and the same, placed on whichever side the drag goes (`--swipe-side`).
  // Keyed by media, so the one a swipe slides in is the same element that then covers the
  // handoff.
  const swipePreviews: { item: MediaItem; location: 'previous' | 'next' | 'either' | 'handoff' }[] = [];
  if (swipeTarget?.id === media.id) swipePreviews.push({ item: swipeTarget, location: 'handoff' });
  const swipeList = albumMediaList.value;
  if (!slideshow && swipeList.length > 1 && (media.type !== 'photo' || loadedPhotoId === media.id)) {
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
  const swipeFrame = `(100% + ${isMobile ? 0 : 2 * SWIPE_ARROW_INSET_PX}px + ${SWIPE_FRAME_GAP_PX}px)`;
  const swipePreviewBase = { previous: `calc(-1 * ${swipeFrame})`, next: `calc${swipeFrame}`, either: `calc(var(--swipe-side, 1) * ${swipeFrame})` };

  const detailsSidebar = (mobile: boolean) => (
    <MediaSidebar
      key={media.id}
      media={media}
      mobile={mobile}
      result={detailsResult}
      hoveredFace={hoveredFace}
      onHoverFace={setHoveredFace}
      onNavigate={goTo}
      onReviewUnknown={setReviewPersonId}
      onOpenMap={mapPoint ? () => setMapOpen(true) : undefined}
      canEdit={canEdit}
      addToAlbumPath={actionPath}
      canOrient={canOrient}
      orienting={orienting}
      onTurn={turn}
      addingFace={addingFace}
      onAddFace={() => {
        setAddingFace((value) => !value);
        setFaceDraftReady(false);
        setFaceMessage(null);
      }}
      stackBusy={stackBusy}
      onStackPreview={previewStackMember}
      onStackAction={mutateStack}
      onLayer={setSidebarLayer}
    />
  );

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
          {taken.date && isMobile && !slideshow && (
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

          {
            /* A phone's row at the bottom has room for the counter and location only; the
                slideshow, faces, fullscreen and the chat are in a menu up in the corner. Sideways a phone
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
                keepMounted
                keepMountedMode='display-none'
                // Sized for a thumb, like the bar's buttons.
                styles={{ item: { fontSize: 'var(--mantine-font-size-lg)', padding: '14px 18px' }, itemSection: { marginRight: 14 } }}
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
                  {mayStar && (
                    <Menu.Item
                      leftSection={<TablerIcon name={starred ? 'heart-filled' : 'heart'} size={24} color={starred ? 'var(--mantine-color-red-5)' : undefined} />}
                      onClick={toggleStar}
                    >
                      {starred ? 'Unfavourite' : 'Favourite'}
                    </Menu.Item>
                  )}
                  <Menu.Item
                    leftSection={<TablerIcon name='player-play' size={24} />}
                    disabled={albumMediaList.value.length < 2}
                    onClick={startSlideshow}
                  >
                    Start slideshow
                  </Menu.Item>
                  {viewMenuItems(24)}
                  <DrawerMenuItems iconSize={24} />
                </Menu.Dropdown>
              </Menu>
            </Group>
          )}

          {!slideshow && !isMobile && (
            <Group
              justify='space-between'
              px='md'
              py='xs'
              style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, pointerEvents: 'none' }}
            >
              <ActionIcon
                variant='subtle'
                color='gray'
                size='lg'
                onClick={requestClose}
                aria-label='Close lightbox'
                style={{ pointerEvents: 'auto' }}
              >
                <TablerIcon name='x' size={22} color='white' />
              </ActionIcon>

              {/* The details, and the drawer (the chat) beside them: the top bar's button is covered. */}
              <Group gap={4} wrap='nowrap'>
                {withDetails && (
                  <Tooltip label='Details (i)' withArrow>
                    <ActionIcon
                      variant='subtle'
                      color='gray'
                      size='lg'
                      onClick={toggleInfoSidebar}
                      aria-label='Toggle details'
                      style={{ pointerEvents: 'auto' }}
                    >
                      <TablerIcon name='info-circle' size={20} color={sidebarOpen ? 'var(--mrx-accent)' : 'white'} />
                    </ActionIcon>
                  </Tooltip>
                )}
                <DrawerButtons />
              </Group>
            </Group>
          )}

          {/* Media content */}
          <Box
            ref={attachGestureSurface}
            data-lightbox-gesture-surface
            data-lightbox-zoom={zoomed ? zoom.scale.toFixed(2) : undefined}
            onClick={slideshow ? stopSlideshow : undefined}
            onDoubleClick={handleDoubleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
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
              padding: isMobile ? 0 : `0 ${SWIPE_ARROW_INSET_PX}px`,
              minHeight: 0,
              position: 'relative',
              overflow: 'hidden',
              // The browser must not pinch-zoom the page, scroll or pull to refresh under a
              // swipe or while two fingers spread over a picture; every touch on it is
              // interpreted here.
              touchAction: zoomable || (isMobile && !slideshow) ? 'none' : undefined,
              cursor: zoomed ? (panning ? 'grabbing' : 'grab') : undefined,
              userSelect: zoomed ? 'none' : undefined,
            }}
          >
            {swipePreviews.filter(({ item }) => item.type === 'photo' || item.type === 'video').map(({ item, location }) => {
              const token = versionOf(item.path);
              return (
                <Box
                  key={item.id}
                  data-lightbox-swipe-preview={location}
                  style={{
                    position: 'absolute',
                    // Over the same box as the settled frame, inside the desktop arrows' inset.
                    inset: isMobile ? 0 : `0 ${SWIPE_ARROW_INSET_PX}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                    transform: location === 'handoff' ? 'none' : `translate3d(calc(${swipePreviewBase[location]} + var(--swipe-x, 0px)), 0, 0)`,
                    transition: location === 'handoff' ? 'none' : 'var(--swipe-transition, none)',
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
                // Zoom is applied to the same box as the swipe, so the face overlay inside
                // it follows the picture without a second measurement. `zoomFocal` relies
                // on the origin being the centre.
                transformOrigin: 'center',
                transform: `translate3d(calc(var(--swipe-x, 0px) + ${zoom.x}px), ${zoom.y}px, 0) scale(${zoom.scale})`,
                transition: `var(--swipe-transition, ${zoomAnimating ? `transform ${ZOOM_ANIMATION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none'})`,
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
                  />
                )
                : isVideo
                ? (
                  <VideoPlayer
                    key={`${media.id}-${reloadToken}`}
                    media={media}
                    reloadToken={reloadToken}
                    videoRef={attachMediaElement}
                    transcript={faceDetails?.hasTranscript ? { language: faceDetails.transcriptLanguage, speakers: faceDetails.speakers } : undefined}
                    chapters={faceDetails?.chapters}
                    // The sheet's hash is in its URL: one made again under the same name would be served
                    // from the cache for an hour, and read with the new one's geometry.
                    storyboard={faceDetails?.storyboard
                      ? {
                        ...faceDetails.storyboard,
                        url: `${fileUrl(media.path)}/thumbnails/${faceDetails.storyboard.name}?sha=${faceDetails.storyboard.sha256.slice(0, 16)}`,
                      }
                      : undefined}
                    compact={isMobile}
                    slideshow={slideshow}
                    fullscreen={fullscreen}
                    onToggleFullscreen={toggleFullscreen}
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
              {(faces.length > 0 || addingFace) && (!slideshow || showFaces) && (
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
                  onNamePerson={namePerson}
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
                  truncated={faceDetails?.contentTruncated}
                  onEdit={mayWriteText ? () => setEditingText(true) : undefined}
                />
              )}
            </Box>
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
            {!lightboxCountHidden.value && (
              <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                <TablerIcon name='photo' size={barIconSize} style={{ flexShrink: 0 }} />
                <Text size='md' c='inherit' truncate='end'>
                  {currentMediaIndex.value + 1} of {albumMediaList.value.length}
                </Text>
              </Group>
            )}

            {(slideshow || !isMobile) && taken.date && (
              <Tooltip label={takenTooltip} withArrow disabled={!takenTooltip} multiline maw={320}>
                <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                  <TablerIcon name='calendar' size={barIconSize} style={{ flexShrink: 0 }} />
                  <Text size='md' c='inherit' truncate='end'>{takenLabel}</Text>
                </Group>
              </Tooltip>
            )}

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

            {where && (
              // Shrinks a thousand times as readily as the date and the counter, so they keep
              // their words until this one is down to its pin.
              <Group gap={6} wrap='nowrap' style={{ minWidth: barIconSize, flexShrink: 1000 }}>
                <TablerIcon name='map-pin' size={barIconSize} style={{ flexShrink: 0 }} />
                <Text size='md' c='inherit' truncate='end' maw={isMobile ? undefined : 360}>{where}</Text>
              </Group>
            )}

            {!slideshow && !isMobile && mayStar && (
              <Tooltip label={starred ? 'Unfavourite (s)' : 'Favourite (s)'} withArrow>
                <ActionIcon variant='subtle' color='gray' size={barButtonSize} onClick={toggleStar} aria-label={starred ? 'Unfavourite' : 'Favourite'} aria-pressed={starred}>
                  <TablerIcon name={starred ? 'heart-filled' : 'heart'} size={barIconSize} color={starred ? 'var(--mantine-color-red-5)' : 'white'} />
                </ActionIcon>
              </Tooltip>
            )}

            {!slideshow && !isMobile && (
              <Tooltip label='Start slideshow' withArrow>
                <ActionIcon
                  variant='subtle'
                  color='gray'
                  size={barButtonSize}
                  disabled={albumMediaList.value.length < 2}
                  onClick={startSlideshow}
                  aria-label='Start slideshow'
                >
                  <TablerIcon name='player-play' size={barIconSize} color='white' />
                </ActionIcon>
              </Tooltip>
            )}

            {!slideshow && !isMobile && (
              <Menu position='top-end' shadow='md' withinPortal keepMounted keepMountedMode='display-none'>
                <Menu.Target>
                  <Tooltip label='More' withArrow>
                    <ActionIcon variant='subtle' color='gray' size={barButtonSize} aria-label='More actions'>
                      <TablerIcon name='dots-vertical' size={barIconSize} color='white' />
                    </ActionIcon>
                  </Tooltip>
                </Menu.Target>
                <Menu.Dropdown>
                  {viewMenuItems(14)}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>

          {/* Nav arrows */}
          {!slideshow && !isMobile && (
            <ActionIcon
              variant='subtle'
              color='gray'
              size='xl'
              disabled={!hasPrevMedia.value}
              onClick={() => slideToMedia('previous')}
              aria-label='Previous media'
              style={{
                position: 'absolute',
                left: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                opacity: hasPrevMedia.value ? 0.8 : 0.2,
              }}
            >
              <TablerIcon name='chevron-left' size={36} color='white' />
            </ActionIcon>
          )}

          {!slideshow && !isMobile && (
            <ActionIcon
              variant='subtle'
              color='gray'
              size='xl'
              disabled={!hasNextMedia.value}
              onClick={() => slideToMedia('next')}
              aria-label='Next media'
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                opacity: hasNextMedia.value ? 0.8 : 0.2,
              }}
            >
              <TablerIcon name='chevron-right' size={36} color='white' />
            </ActionIcon>
          )}
        </Box>

        {!slideshow && isMobile
          ? withDetails && (
            // A phone keeps its details panel mounted, off screen when closed, so that it can
            // move with a finger or slide (see `beginSheet`): upright a sheet over the bottom
            // half, sideways a panel over the right.
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
              {detailsSidebar(mobilePortrait)}
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
        title={where || 'Where it was taken'}
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
          truncated={faceDetails?.contentTruncated ?? false}
          onSave={saveText}
          onClose={() => setEditingText(false)}
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
