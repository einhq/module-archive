/**
 * XMP sidecars: the `.xmp` files a photo editor (Lightroom, darktable, digiKam) or a scanning tool
 * writes beside a picture, with what a person said about it (`@archive/media/xmp`).
 *
 * **Reading** (`parseXmp`). The packet is RDF/XML; a property is read in either of its two
 * spellings, as an attribute of `rdf:Description` or as an element of its own, and a language
 * alternative (`rdf:Alt`) or a bag (`rdf:Bag`) by its items. The capture time is
 * `photoshop:DateCreated`, else `exif:DateTimeOriginal`, at the precision written (a scan dated
 * `1968-07` is a month); `xmp:CreateDate` is when the file was made, a scan's scan time, and is
 * not read. The position is `exif:GPSLatitude` / `exif:GPSLongitude` (`59,19.83N`, or with
 * seconds); then `dc:title`, `dc:description`, `xmp:Rating`, `xmp:Label` and the keywords of
 * `dc:subject`.
 *
 * **Pairing** (`matchXmp`). `IMG_0001.jpg.xmp` belongs to `IMG_0001.jpg`, and `IMG_0001.xmp` to
 * the one file named `IMG_0001` with any extension; beside both a camera RAW and the JPEG made
 * from it, to the RAW, which is what an editor writes it for. Anything else two files could claim
 * is left unmatched.
 *
 * Pure: no IO.
 */

import { isCaptureTime, isRawExtension, isRawMimetype } from '@ein/client';
import type { SidecarPoint, XmpSidecar } from '@archive/media/api';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its entities and character references read. */
const decode = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });

const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every value a property holds, in either spelling: an attribute, a plain element, or the items of a list. */
const values = (packet: string, name: string): string[] => {
  const prop = escape(name);
  const found: string[] = [];
  for (const match of packet.matchAll(new RegExp(`\\s${prop}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g'))) found.push(decode(match[1] ?? match[2]));
  for (const match of packet.matchAll(new RegExp(`<${prop}(?:\\s[^>]*)?>([\\s\\S]*?)</${prop}>`, 'g'))) {
    const body = match[1];
    const items = [...body.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((item) => decode(item[1]));
    found.push(...(items.length > 0 || /<rdf:(Alt|Bag|Seq)\b/.test(body) ? items : [decode(body)]));
  }
  return found.map((value) => value.trim()).filter((value) => value !== '');
};

const first = (packet: string, name: string): string | undefined => values(packet, name)[0];

/**
 * An XMP date as a capture time: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a time to the minute or second
 * with its offset when it has one; fractions of a second are dropped. The EXIF spelling
 * (`2019:06:01 12:34:56`) is read too. Undefined for anything else.
 */
export const xmpDate = (value: string): string | undefined => {
  const exif = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  const iso = exif ? `${exif[1]}-${exif[2]}-${exif[3]}T${exif[4]}:${exif[5]}${exif[6] ? `:${exif[6]}` : ''}` : value.replace(/(T\d{2}:\d{2}:\d{2})\.\d+/, '$1');
  return isCaptureTime(iso) ? iso : undefined;
};

/** `59,19.83N` or `59,19,49.8N` (degrees, minutes and seconds, then the hemisphere), or plain degrees. */
const coordinate = (value: string | undefined, negative: string): number | undefined => {
  if (value === undefined) return undefined;
  const dms = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/i.exec(value);
  if (dms) {
    const degrees = Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3] ?? 0) / 3600;
    return dms[4].toUpperCase() === negative ? -degrees : degrees;
  }
  const plain = Number(value);
  return Number.isFinite(plain) ? plain : undefined;
};

/** What an XMP packet says, or undefined when the text is no XMP. */
export const parseXmp = (packet: string): XmpSidecar | undefined => {
  if (!/<x:xmpmeta\b|<rdf:RDF\b/.test(packet)) return undefined;
  const sidecar: XmpSidecar = { kind: 'xmp' };
  const date = [first(packet, 'photoshop:DateCreated'), first(packet, 'exif:DateTimeOriginal')].map((value) => value && xmpDate(value)).find((value) => value);
  if (date) sidecar.wallClock = date;
  const lat = coordinate(first(packet, 'exif:GPSLatitude'), 'S');
  const lng = coordinate(first(packet, 'exif:GPSLongitude'), 'W');
  if (lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    sidecar.where = { lat, lng } satisfies SidecarPoint;
  }
  const title = first(packet, 'dc:title');
  const description = first(packet, 'dc:description');
  const rating = Number(first(packet, 'xmp:Rating'));
  const label = first(packet, 'xmp:Label');
  const keywords = [...new Set(values(packet, 'dc:subject'))];
  if (title) sidecar.title = title;
  if (description) sidecar.description = description;
  if (Number.isInteger(rating) && rating >= -1 && rating <= 5) sidecar.rating = rating;
  if (label) sidecar.label = label;
  if (keywords.length > 0) sidecar.keywords = keywords;
  return sidecar;
};

/** A file an XMP sidecar may belong to: its name, and its mimetype when known. */
type XmpCandidate = { name: string; mimetype?: string };

const isRaw = (file: XmpCandidate): boolean => isRawMimetype(file.mimetype) || isRawExtension(file.name);

const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * Match the XMP sidecars `xmps` of one folder (by name) with its media files: each matched
 * sidecar's file, by name. A file takes one sidecar, the first by name.
 */
export const matchXmp = (xmps: string[], media: XmpCandidate[]): Map<string, string> => {
  const names = new Set(media.map((file) => file.name));
  const claimed = new Set<string>();
  const paired = new Map<string, string>();
  const ordered = xmps.toSorted();
  for (const xmp of ordered) {
    const base = /^(.*)\.xmp$/i.exec(xmp)?.[1];
    if (base && names.has(base) && !claimed.has(base)) {
      claimed.add(base);
      paired.set(xmp, base);
    }
  }
  for (const xmp of ordered) {
    const base = /^(.*)\.xmp$/i.exec(xmp)?.[1];
    if (!base || paired.has(xmp)) continue;
    const same = media.filter((file) => stemOf(file.name) === base && !claimed.has(file.name));
    const raws = same.filter(isRaw);
    const target = same.length === 1 ? same[0] : raws.length === 1 ? raws[0] : undefined;
    if (target) {
      claimed.add(target.name);
      paired.set(xmp, target.name);
    }
  }
  return paired;
};
