import type { FaceBox } from '../hooks/useMediaDetails.ts';

export type DrawPoint = { x: number; y: number };
export type FaceBoxEdit = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/**
 * Turn a pointer drag over the rendered picture into its stored fractional face box.
 *
 * The drag may run in any direction or leave the picture while pointer capture is active.
 * Tiny movements are clicks, not faces: requiring a useful hit target also prevents an
 * accidental click in draw mode from minting an unidentified person.
 */
export function faceBoxFromDrag(
  start: DrawPoint,
  end: DrawPoint,
  frame: { width: number; height: number },
  minimumPixels = 12,
): FaceBox | null {
  if (!(frame.width > 0) || !(frame.height > 0)) return null;

  const startX = clamp(start.x, frame.width);
  const startY = clamp(start.y, frame.height);
  const endX = clamp(end.x, frame.width);
  const endY = clamp(end.y, frame.height);
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);
  if (width < minimumPixels || height < minimumPixels) return null;

  return {
    x: left / frame.width,
    y: top / frame.height,
    width: width / frame.width,
    height: height / frame.height,
  };
}

/** Move or resize a fractional face box while keeping it inside the rendered picture. */
export function editFaceBox(
  box: FaceBox,
  start: DrawPoint,
  end: DrawPoint,
  frame: { width: number; height: number },
  edit: FaceBoxEdit,
  minimumPixels = 12,
): FaceBox {
  if (!(frame.width > 0) || !(frame.height > 0)) return box;

  const startX = clamp(start.x, frame.width) / frame.width;
  const startY = clamp(start.y, frame.height) / frame.height;
  const endX = clamp(end.x, frame.width) / frame.width;
  const endY = clamp(end.y, frame.height) / frame.height;
  const dx = endX - startX;
  const dy = endY - startY;
  const minimumWidth = Math.min(minimumPixels / frame.width, box.width);
  const minimumHeight = Math.min(minimumPixels / frame.height, box.height);

  if (edit === 'move') {
    return {
      ...box,
      x: Math.min(Math.max(box.x + dx, 0), 1 - box.width),
      y: Math.min(Math.max(box.y + dy, 0), 1 - box.height),
    };
  }

  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;

  if (edit.includes('w')) left = Math.min(Math.max(left + dx, 0), right - minimumWidth);
  if (edit.includes('e')) right = Math.max(Math.min(right + dx, 1), left + minimumWidth);
  if (edit.includes('n')) top = Math.min(Math.max(top + dy, 0), bottom - minimumHeight);
  if (edit.includes('s')) bottom = Math.max(Math.min(bottom + dy, 1), top + minimumHeight);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The same box, to the six decimals the lightbox writes a box with. */
export const sameFaceBox = (a: FaceBox, b: FaceBox): boolean => (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(a[key] - b[key]) < 5e-7);
