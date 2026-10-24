/**
 * An invented Google Photos Takeout part, as a zip, for the tests and for trying an import by hand.
 *
 *   deno run --allow-read --allow-write takeout.ts <out.zip> [<picture.jpg>…]
 *
 * Each picture (a tiny invented JPEG for each of 20 when none are given) has its EXIF and XMP
 * segments taken out, so the JSON beside it is all that dates and places it, as for a picture
 * Google stored without its tags. The JSON gives it an invented time (`photoTakenTime`), an upload
 * a long time after (`creationTime`), an invented place near an invented town, a caption to every
 * fourth and a favourite to every fifth. The names show Google's habits: both JSON forms by turns,
 * a second photo of one name numbered `(1)` with the number moved to the end of its JSON's name, and
 * a name over 51 characters cut. The last five lie in an album folder with its `metadata.json`.
 *
 * Written stored, not deflated: a few lines here rather than a dependency, and pictures do not
 * shrink anyway.
 */

/** One file of the zip, by its path inside it. */
type Entry = { path: string; body: Uint8Array };

/** A picture of the part as its JSON describes it. */
export type TakeoutPhoto = { path: string; takenAt: string; favorited: boolean; description?: string; where: { lat: number; lng: number } };

const ROOT = 'Takeout/Google Photos';
const YEAR = `${ROOT}/Photos from 2019`;
export const TAKEOUT_ALBUM = `${ROOT}/Sommar i Exempelstad`;
export const TAKEOUT_ALBUM_TITLE = 'Sommar i Exempelstad';

/** When the first picture was taken, and how far apart they are, in seconds. */
const FIRST = Date.parse('2019-06-01T09:00:00Z') / 1000;
const STEP = 3 * 3600 + 17 * 60;
/** When they were uploaded: years later, so no time is mistaken for the upload's. */
const UPLOADED = Date.parse('2026-07-01T10:00:00Z') / 1000;

/** A tiny JPEG that is no picture: its markers and a comment, enough to be told a JPEG. */
const tinyJpeg = (i: number): Uint8Array => {
  const comment = new TextEncoder().encode(`invented picture ${i}`);
  return new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, comment.length + 2, ...comment, 0xff, 0xd9]);
};

/** `jpeg` without its APP1 segments (EXIF and XMP), or as it is when it is no JPEG. */
export const stripExif = (jpeg: Uint8Array): Uint8Array => {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const kept: Uint8Array[] = [jpeg.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    // From the start of the scan on, the rest is the picture.
    if (marker === 0xda) break;
    const length = (jpeg[at + 2] << 8) | jpeg[at + 3];
    if (marker !== 0xe1) kept.push(jpeg.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  kept.push(jpeg.subarray(at));
  const out = new Uint8Array(kept.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of kept) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2));

/** The entries of the part for `pictures`, and what its JSON says of each. */
export const takeoutEntries = (pictures: Uint8Array[]): { entries: Entry[]; photos: TakeoutPhoto[] } => {
  const entries: Entry[] = [];
  const photos: TakeoutPhoto[] = [];
  pictures.forEach((picture, index) => {
    const i = index + 1;
    const folder = index >= pictures.length - 5 ? TAKEOUT_ALBUM : YEAR;
    // The names Google gives: a cut long name, a second photo of one name, and plain ones.
    const title = i === 1 ? 'Exempelstad_hamnfest_med_segelbatar_och_musik_2019.jpg' : i === 3 ? 'IMG_0002.jpg' : `IMG_${String(i).padStart(4, '0')}.jpg`;
    const name = i === 3 ? 'IMG_0002(1).jpg' : title;
    const sidecar = i === 1
      ? `${title.slice(0, 46)}.json`
      : i === 3
      ? 'IMG_0002.jpg.supplemental-metadata(1).json'
      : i % 2 === 0
      ? `${title}.supplemental-metadata.json`
      : `${title}.json`;
    const taken = FIRST + index * STEP;
    const where = { lat: Number((57.7 + index * 0.002).toFixed(4)), lng: Number((11.95 + index * 0.003).toFixed(4)) };
    const description = i % 4 === 0 ? `Bild ${i} från sommaren i Exempelstad` : undefined;
    const favorited = i % 5 === 0;
    entries.push({ path: `${folder}/${name}`, body: stripExif(picture) });
    entries.push({
      path: `${folder}/${sidecar}`,
      body: json({
        title,
        description: description ?? '',
        imageViews: '0',
        creationTime: { timestamp: String(UPLOADED + index), formatted: '' },
        photoTakenTime: { timestamp: String(taken), formatted: '' },
        geoData: { latitude: where.lat, longitude: where.lng, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
        geoDataExif: { latitude: where.lat, longitude: where.lng, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
        url: `https://photos.google.com/photo/invented-${i}`,
        googlePhotosOrigin: { mobileUpload: { deviceType: 'ANDROID_PHONE' } },
        ...(favorited ? { favorited: true } : {}),
      }),
    });
    photos.push({ path: `${folder}/${name}`, takenAt: iso(taken), favorited, where, ...(description ? { description } : {}) });
  });
  entries.push({
    path: `${TAKEOUT_ALBUM}/metadata.json`,
    body: json({ title: TAKEOUT_ALBUM_TITLE, description: 'Veckan vid sjön', access: 'protected', date: { timestamp: String(FIRST), formatted: '' } }),
  });
  return { entries, photos };
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** `entries` as a zip whose entries are stored, their names UTF-8. */
export const zipStored = (entries: Entry[]): Uint8Array<ArrayBuffer> => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.body.length, true);
    local.setUint32(22, entry.body.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, entry.body);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, entry.body.length, true);
    header.setUint32(24, entry.body.length, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + entry.body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** The part for `pictures`, or for 20 tiny invented JPEGs, as a zip. */
export const takeoutZip = (pictures: Uint8Array[] = Array.from({ length: 20 }, (_, i) => tinyJpeg(i + 1))): { zip: Uint8Array<ArrayBuffer>; photos: TakeoutPhoto[] } => {
  const { entries, photos } = takeoutEntries(pictures);
  return { zip: zipStored(entries), photos };
};

if (import.meta.main) {
  const [out, ...paths] = Deno.args;
  if (!out) {
    console.error('usage: takeout.ts <out.zip> [<picture.jpg>…]');
    Deno.exit(1);
  }
  const { zip, photos } = takeoutZip(paths.length > 0 ? await Promise.all(paths.map((path) => Deno.readFile(path))) : undefined);
  await Deno.writeFile(out, zip);
  console.log(JSON.stringify(photos.map(({ path, takenAt, favorited }) => ({ path, takenAt, favorited }))));
}
