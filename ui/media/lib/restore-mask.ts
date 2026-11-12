/**
 * The marks a person paints over a picture for `file-restore --mask`: strokes in the display frame,
 * drawn small over the picture as they are made and, once filled, into a full-size mask of the
 * picture as stored — a one-channel PNG, 255 where marked — which is what EMS fills.
 */

/** One stroke of the brush: points in fractions of the display frame, a radius in fractions of its width. */
export type MaskStroke = { mode: 'paint' | 'erase'; radius: number; points: [number, number][] };

/** A 2D affine transform as a canvas takes it: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

/** The display frame's size for a picture stored at `width` × `height`: a quarter turn swaps them. */
export const displaySize = (width: number, height: number, angle: number): { width: number; height: number } =>
  angle === 90 || angle === 270 ? { width: height, height: width } : { width, height };

/**
 * Display-frame pixels to stored pixels, for a picture stored at `width` × `height` and shown
 * turned counter-clockwise by `angle`, then flopped when `mirror`.
 */
export const displayToStored = (width: number, height: number, angle: number, mirror: boolean): Affine => {
  const display = displaySize(width, height, angle);
  const turn: Affine = angle === 90 ? [0, 1, -1, 0, width, 0] : angle === 270 ? [0, -1, 1, 0, 0, height] : angle === 180 ? [-1, 0, 0, -1, width, height] : [1, 0, 0, 1, 0, 0];
  // The flop is undone first, in the display frame.
  return mirror ? multiply(turn, [-1, 0, 0, 1, display.width, 0]) : turn;
};

/** `outer` after `inner`: a point goes through `inner` first. */
const multiply = ([a1, b1, c1, d1, e1, f1]: Affine, [a2, b2, c2, d2, e2, f2]: Affine): Affine => [
  a1 * a2 + c1 * b2,
  b1 * a2 + d1 * b2,
  a1 * c2 + c1 * d2,
  b1 * c2 + d1 * d2,
  a1 * e2 + c1 * f2 + e1,
  b1 * e2 + d1 * f2 + f1,
];

/** Draw `stroke` on `ctx`, in a frame `width` pixels wide and `height` high, in `color` (erasing clears instead). */
export const drawStroke = (ctx: CanvasRenderingContext2D, stroke: MaskStroke, width: number, height: number, color: string, erase: string | null) => {
  ctx.save();
  if (stroke.mode === 'erase' && erase === null) ctx.globalCompositeOperation = 'destination-out';
  const ink = stroke.mode === 'paint' ? color : erase ?? '#000';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, 2 * stroke.radius * width);
  const [first, ...rest] = stroke.points;
  if (!first) return ctx.restore();
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first[0] * width, first[1] * height, ctx.lineWidth / 2, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first[0] * width, first[1] * height);
    for (const [x, y] of rest) ctx.lineTo(x * width, y * height);
    ctx.stroke();
  }
  ctx.restore();
};

/** Pixels a band of the full-size mask holds at most, so a large scan never needs one canvas its size. */
const BAND_PIXELS = 4_000_000;

/**
 * The full-size mask of a picture stored at `width` × `height`: `base` (a mask of that size, such
 * as the defect finder's) where given, with `strokes` painted on and erased from it, as a PNG.
 */
export const renderMask = async (
  opts: { width: number; height: number; angle: number; mirror: boolean; base?: CanvasImageSource; strokes: MaskStroke[] },
): Promise<Blob> => {
  const { width, height, angle, mirror, base, strokes } = opts;
  const display = displaySize(width, height, angle);
  const toStored = displayToStored(width, height, angle, mirror);
  const bandHeight = Math.max(1, Math.min(height, Math.floor(BAND_PIXELS / width)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = bandHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('this browser cannot draw the mask');
  return await grayPng(width, height, async (top, rows) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, bandHeight);
    if (base) ctx.drawImage(base, 0, top, width, rows, 0, 0, width, rows);
    ctx.setTransform(1, 0, 0, 1, 0, -top);
    ctx.transform(...toStored);
    for (const stroke of strokes) drawStroke(ctx, stroke, display.width, display.height, '#fff', '#000');
    const { data } = ctx.getImageData(0, 0, width, rows);
    const gray = new Uint8Array(width * rows);
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4] >= 128 ? 255 : 0;
    return gray;
  }, bandHeight);
};

/**
 * An 8-bit grayscale PNG `width` × `height`, its rows asked for a band at a time: `band(top, rows)`
 * gives `rows` rows from `top` down, `width` bytes each.
 */
export const grayPng = async (
  width: number,
  height: number,
  band: (top: number, rows: number) => Promise<Uint8Array> | Uint8Array,
  bandHeight = height,
): Promise<Blob> => {
  const deflate = new CompressionStream('deflate');
  const compressed = new Response(deflate.readable).arrayBuffer();
  const writer = deflate.writable.getWriter();
  for (let top = 0; top < height; top += bandHeight) {
    const rows = Math.min(bandHeight, height - top);
    const pixels = await band(top, rows);
    const filtered = new Uint8Array(rows * (width + 1));
    for (let y = 0; y < rows; y++) filtered.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    await writer.write(filtered);
  }
  await writer.close();
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(await compressed)),
    chunk('IEND', new Uint8Array(0)),
  ], { type: 'image/png' });
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 a PNG chunk ends with. */
export const crc32 = (bytes: Uint8Array, crc = 0xffffffff): number => {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A PNG chunk: its length, type, data and CRC. */
const chunk = (type: string, data: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/**
 * The `file-restore` flags that make a restored copy again with a mask given in place of its
 * dust step: the same colours, fill and grain.
 */
export const againFlags = (steps: { op: string; params: Record<string, unknown> }[]): string[] =>
  steps.flatMap((step) => {
    if (step.op === 'image.unfade') return ['--unfade'];
    if (step.op === 'image.inpaint' && typeof step.params.method === 'string' && step.params.method !== 'ns') return ['--fill', step.params.method];
    if (step.op === 'image.denoise' && typeof step.params.strength === 'number') return ['--grain', String(step.params.strength)];
    return [];
  });
