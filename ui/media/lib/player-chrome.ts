/**
 * When the video player's controls show, and where they and the subtitles sit over the picture.
 *
 * Pure, so it is tested without a browser. The rects are in the player's own box, as
 * `useContentRect` measures them.
 */

type PictureRect = { left: number; top: number; width: number; height: number };

/** How long the controls stay after the last sign of the viewer: a mouse moving, or a tap. */
export const CHROME_IDLE_MS = { mouse: 2500, touch: 3500 } as const;

/** What keeps the controls on screen however long nobody has touched them. */
type ChromePins = {
  /** Paused, ended, or not yet started: the controls are what starts it. */
  paused: boolean;
  scrubbing: boolean;
  /** The mouse is over the controls. */
  hovered: boolean;
  /** A keyboard user is on one of the controls (`:focus-visible`, not a clicked button's focus). */
  focused: boolean;
  /** A menu of the controls' is open: a phone's, with what does not fit the bar. */
  menuOpen: boolean;
};

/** Whether the controls over the picture show: pinned, or touched within the idle time. Never in a slideshow. */
export const chromeVisible = (pins: ChromePins, active: boolean, slideshow: boolean): boolean =>
  !slideshow && (active || pins.paused || pins.scrubbing || pins.hovered || pins.focused || pins.menuOpen);

/**
 * Where the bar goes: under the picture when the letterbox below it has the room (a landscape film
 * on an upright phone), over the picture's bottom edge otherwise.
 *
 * Below, it covers nothing, so it stays on screen while the picture plays.
 */
export const barPlacement = (picture: PictureRect, boxHeight: number, barHeight: number): 'below' | 'overlay' =>
  barHeight > 0 && boxHeight - (picture.top + picture.height) >= barHeight ? 'below' : 'overlay';

/** The lightbox's zoom of the picture: scaled about the player box's centre, then moved. */
export type PictureZoom = { scale: number; x: number; y: number };

/**
 * The part of a zoomed picture that is on screen: the picture scaled and moved as the lightbox zooms
 * it, cut to the box. The bar, the subtitles and a phone's centre buttons are placed by it, so a
 * zoomed picture takes the bar down to the bottom of the view instead of leaving it where the
 * unzoomed picture ended. Before the box is measured the picture is all there is to go by.
 */
export const visiblePicture = (picture: PictureRect, box: { width: number; height: number }, zoom: PictureZoom): PictureRect => {
  if (box.width <= 0 || box.height <= 0 || (zoom.scale === 1 && zoom.x === 0 && zoom.y === 0)) return picture;
  const left = box.width / 2 + (picture.left - box.width / 2) * zoom.scale + zoom.x;
  const top = box.height / 2 + (picture.top - box.height / 2) * zoom.scale + zoom.y;
  const shown = {
    left: Math.max(0, left),
    top: Math.max(0, top),
    right: Math.min(box.width, left + picture.width * zoom.scale),
    bottom: Math.min(box.height, top + picture.height * zoom.scale),
  };
  return { left: shown.left, top: shown.top, width: Math.max(0, shown.right - shown.left), height: Math.max(0, shown.bottom - shown.top) };
};

/** The picture's rect before the video has its own size: the metadata's aspect, contain-fitted into the box. */
export const fittedPicture = (box: { width: number; height: number }, aspect: number | undefined): PictureRect => {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: 0, top: 0, width: box.width, height: box.height };
  }
  const width = Math.min(box.width, box.height * aspect);
  const height = width / aspect;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
};

/**
 * How far above the box's bottom edge the subtitles sit.
 *
 * A little above the picture's bottom edge, or above the bar while it is over the picture. In a
 * slideshow the information bar lies over the bottom of the box (`coveredBottom` of it); the
 * subtitles clear it, but only by what it actually covers of the picture.
 */
export const subtitleBottom = (picture: PictureRect, boxHeight: number, barOverPicture: number, coveredBottom: number): number => {
  const pictureBottom = boxHeight - (picture.top + picture.height);
  const floor = Math.max(pictureBottom + barOverPicture, coveredBottom);
  return floor + (barOverPicture > 0 ? 8 : picture.height * 0.06);
};

/**
 * Where the subtitles sit when a phone's centre buttons are over the middle of the picture
 * (`centreHalf` is half their height): where `subtitleBottom` put them while two lines fit under
 * the buttons, else just above the buttons, as a short landscape picture has no room below them.
 */
export const subtitleClearOfCentre = (bottom: number, picture: PictureRect, boxHeight: number, fontPx: number, centreHalf: number): number => {
  const centre = boxHeight - (picture.top + picture.height / 2);
  const twoLines = fontPx * 1.35 * 2 + 8;
  return centre - centreHalf - bottom >= twoLines ? bottom : centre + centreHalf + 8;
};

/** The subtitles' size: readable on a phone's small picture, not shouting on a large screen. */
export const subtitleFontPx = (picture: PictureRect): number => Math.min(Math.max(picture.height * 0.045, 14), 30);
