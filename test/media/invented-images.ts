/**
 * Invented pictures for the container tier, made at test time: a scene of coloured shapes drawn at
 * any size, as a PNG with an EXIF block (`eXIf`) giving its camera and capture time. Drawing one
 * scene at a smaller size makes a downscaled copy of it; drawing it with one shape moved makes the
 * next frame of a burst. Nothing here needs a media tool, which the EiN image has none of.
 */

/** A shape of a scene, in fractions of the picture's width and height. */
type Shape = { kind: 'box' | 'disc'; x: number; y: number; w: number; h: number; rgb: [number, number, number] };

/** A scene: a gradient and shapes over it. */
export type Scene = { from: [number, number, number]; to: [number, number, number]; shapes: Shape[] };

/** A scene of `count` shapes, the same for the same `seed`. */
export const inventScene = (seed: number, count = 24): Scene => {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const colour = (): [number, number, number] => [Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256)];
  const shapes = Array.from({ length: count }, (): Shape => ({
    kind: next() < 0.5 ? 'box' : 'disc',
    x: next() * 0.9,
    y: next() * 0.9,
    w: 0.05 + next() * 0.25,
    h: 0.05 + next() * 0.25,
    rgb: colour(),
  }));
  return { from: colour(), to: colour(), shapes };
};

/** `scene` with its shape `index` moved by `dx`, `dy` (fractions) and grown by `grow`: the next shot of a burst. */
export const moveShape = (scene: Scene, index: number, dx: number, dy: number, grow = 1): Scene => ({
  ...scene,
  shapes: scene.shapes.map((shape, i) => i === index ? { ...shape, x: shape.x + dx, y: shape.y + dy, w: shape.w * grow, h: shape.h * grow } : shape),
});

/** The scene's pixels at `width`×`height`, as RGB rows. */
const draw = (scene: Scene, width: number, height: number): Uint8Array => {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const at = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) pixels[at + c] = Math.round(scene.from[c] * (1 - t) + scene.to[c] * t);
    }
  }
  for (const shape of scene.shapes) {
    const x0 = Math.floor(shape.x * width);
    const y0 = Math.floor(shape.y * height);
    const x1 = Math.min(width, Math.ceil((shape.x + shape.w) * width));
    const y1 = Math.min(height, Math.ceil((shape.y + shape.h) * height));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) {
        if (shape.kind === 'disc' && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        pixels.set(shape.rgb, (y * width + x) * 3);
      }
    }
  }
  return pixels;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(new TextEncoder().encode(type), 4);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc32(concat([head.subarray(4), data])));
  return concat([head, data, tail]);
};

/** What a picture's EXIF block says: its camera, when it was taken (`YYYY:MM:DD HH:MM:SS`), and the fraction of that second. */
export type InventedExif = { make: string; model: string; taken: string; subSecond?: string };

/**
 * A little-endian TIFF block of two IFDs: the camera in the first, the capture time and its
 * fraction of a second in the EXIF one it points at. ASCII values longer than four bytes follow
 * the IFDs.
 */
const exifBlock = (exif: InventedExif): Uint8Array => {
  const ascii = (text: string) => new TextEncoder().encode(`${text}\0`);
  const ifd0 = [{ tag: 0x010f, value: ascii(exif.make) }, { tag: 0x0110, value: ascii(exif.model) }];
  const sub = [{ tag: 0x9003, value: ascii(exif.taken) }, ...(exif.subSecond ? [{ tag: 0x9291, value: ascii(exif.subSecond) }] : [])];
  const ifdSize = (count: number) => 2 + count * 12 + 4;
  const ifd0At = 8;
  const subAt = ifd0At + ifdSize(ifd0.length + 1);
  let dataAt = subAt + ifdSize(sub.length);
  const out = new Uint8Array(dataAt + [...ifd0, ...sub].reduce((sum, entry) => sum + (entry.value.length > 4 ? entry.value.length : 0), 0));
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, ifd0At, true);
  const writeIfd = (at: number, entries: { tag: number; value: Uint8Array }[], pointer?: number) => {
    const all = [...entries.map((entry) => ({ ...entry, type: 2 })), ...(pointer !== undefined ? [{ tag: 0x8769, type: 4, value: new Uint8Array(0) }] : [])];
    view.setUint16(at, all.length, true);
    all.forEach((entry, i) => {
      const slot = at + 2 + i * 12;
      view.setUint16(slot, entry.tag, true);
      view.setUint16(slot + 2, entry.type, true);
      if (entry.type === 4) {
        view.setUint32(slot + 4, 1, true);
        view.setUint32(slot + 8, pointer!, true);
      } else if (entry.value.length <= 4) {
        view.setUint32(slot + 4, entry.value.length, true);
        out.set(entry.value, slot + 8);
      } else {
        view.setUint32(slot + 4, entry.value.length, true);
        view.setUint32(slot + 8, dataAt, true);
        out.set(entry.value, dataAt);
        dataAt += entry.value.length;
      }
    });
    view.setUint32(at + 2 + all.length * 12, 0, true);
  };
  writeIfd(ifd0At, ifd0, subAt);
  writeIfd(subAt, sub);
  return out;
};

/** `scene` drawn at `width`×`height` as a PNG, with `exif` in its `eXIf` chunk. */
export const scenePng = async (scene: Scene, width: number, height: number, exif: InventedExif): Promise<Uint8Array<ArrayBuffer>> => {
  const pixels = draw(scene, width, height);
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const deflated = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('eXIf', exifBlock(exif)),
    chunk('IDAT', deflated),
    chunk('IEND', new Uint8Array(0)),
  ]);
};
