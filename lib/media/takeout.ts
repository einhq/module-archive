/**
 * Google Photos Takeout sidecars: the JSON Google writes beside each photo and video of an
 * export, and the `metadata.json` of an album folder (`@archive/media/takeout`).
 *
 * **Reading** (`parseTakeoutJson`). A photo's JSON holds `photoTakenTime` and `creationTime` (epoch
 * seconds, as strings), `geoData` (where Google shows it) beside `geoDataExif` (where the file's
 * own tags put it), `description`, `people`, `favorited`, `archived`, `trashed`, and the phone
 * folder it was uploaded from (`googlePhotosOrigin.mobileUpload.deviceFolder.localFolderName`). An
 * album's holds its `title`, `description` and `date`, at the top or, in older exports, under
 * `albumData`. A point at 0,0 is no point, and a time of 0 is no time.
 *
 * **Pairing** (`matchTakeout`). Google names a photo's JSON after the photo, in one of two forms
 * and with two habits that make the name differ from the photo's:
 *
 * - `IMG_0001.jpg.json`, or since 2024 `IMG_0001.jpg.supplemental-metadata.json`;
 * - a name over 51 characters is cut at the end before `.json`, so `.supplemental-metadata` is
 *   shortened to `.supplemental-metad`, `.supp` or `.s`, and a long photo name loses its end;
 * - the second photo of one name in a folder is `IMG_0001(1).jpg`, and its JSON
 *   `IMG_0001.jpg(1).json` or `IMG_0001.jpg.supplemental-metadata(1).json`: the number moves to
 *   the end, and the JSON's `title` is the photo's name without it.
 *
 * So a JSON is matched, in order: by its `title` with its number put back; by the name it carries
 * once the number and the supplemental suffix are taken off; by a unique photo whose name starts
 * with that cut name, or whose name the title starts with (Google cut the photo's name too). Then an
 * edited copy (`IMG_0001-edited.jpg`, and the edit suffixes of other languages) shares its
 * original's JSON, and so does a Live Photo's video (`IMG_0001.MP4` beside `IMG_0001.HEIC`). A
 * name is never guessed from its length, and a JSON two photos could claim is left unmatched.
 *
 * Pure: no IO.
 */

import type { SidecarPoint, TakeoutAlbumSidecar, TakeoutSidecar } from '@archive/media/api';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** `{ timestamp: "1559392496" }` as `YYYY-MM-DDTHH:MM:SSZ`; undefined for a missing, zero or invalid one. */
const timeOf = (value: unknown): string | undefined => {
  if (!isObject(value)) return undefined;
  const seconds = Number(value.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d+Z$/, 'Z');
};

/** `{ latitude, longitude }` as a point; undefined for 0,0 and anything out of range. */
const pointOf = (value: unknown): SidecarPoint | undefined => {
  if (!isObject(value)) return undefined;
  const lat = Number(value.latitude);
  const lng = Number(value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
};

/** Two points closer than this, in degrees, are one: Google rounds the two copies differently. */
const SAME_POINT = 1e-5;

const samePoint = (a: SidecarPoint, b: SidecarPoint): boolean => Math.abs(a.lat - b.lat) < SAME_POINT && Math.abs(a.lng - b.lng) < SAME_POINT;

/** A photo's sidecar from its parsed JSON. */
const mediaSidecar = (json: Json): TakeoutSidecar => {
  const shown = pointOf(json.geoData);
  const own = pointOf(json.geoDataExif);
  const where = shown ?? own;
  const people = Array.isArray(json.people) ? json.people.flatMap((person) => isObject(person) && text(person.name) ? [text(person.name)!] : []) : [];
  const origin = isObject(json.googlePhotosOrigin) && isObject(json.googlePhotosOrigin.mobileUpload) ? json.googlePhotosOrigin.mobileUpload : undefined;
  const localFolder = origin && isObject(origin.deviceFolder) ? text(origin.deviceFolder.localFolderName) : undefined;
  const sidecar: TakeoutSidecar = { kind: 'takeout' };
  const title = text(json.title);
  const takenAt = timeOf(json.photoTakenTime);
  const uploadedAt = timeOf(json.creationTime);
  const description = text(json.description);
  if (title) sidecar.title = title;
  if (takenAt) sidecar.takenAt = takenAt;
  if (uploadedAt) sidecar.uploadedAt = uploadedAt;
  if (where) sidecar.where = where;
  if (shown && !(own && samePoint(shown, own))) sidecar.whereEdited = true;
  if (description) sidecar.description = description;
  if (people.length > 0) sidecar.people = people;
  if (json.favorited === true) sidecar.favorited = true;
  if (json.archived === true) sidecar.archived = true;
  if (json.trashed === true) sidecar.trashed = true;
  if (localFolder) sidecar.localFolder = localFolder;
  return sidecar;
};

/**
 * What a Takeout JSON says: a photo's or video's sidecar, an album's metadata, or undefined for
 * JSON that is neither (or no JSON at all).
 */
export const parseTakeoutJson = (body: string): TakeoutSidecar | TakeoutAlbumSidecar | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isObject(json)) return undefined;
  if ('photoTakenTime' in json || ('creationTime' in json && 'url' in json)) return mediaSidecar(json);
  const album = isObject(json.albumData) ? json.albumData : json;
  const title = text(album.title);
  if (title && (album !== json || 'date' in json || 'access' in json)) {
    const description = text(album.description);
    const date = timeOf(album.date);
    return { kind: 'takeout-album', title, ...(description ? { description } : {}), ...(date ? { date } : {}) };
  }
  return undefined;
};

/** `.supplemental-metadata`, which a long name loses from its end. */
const SUPPLEMENTAL = '.supplemental-metadata';

/**
 * What a Takeout JSON's own name says of its photo: the photo's name as far as Google kept it
 * (`base`), and its number when it is the second or later of its name in the folder (`counter`).
 * Undefined for a name that does not end in `.json`.
 */
export const takeoutName = (name: string): { base: string; counter?: number } | undefined => {
  const json = /^(.*)\.json$/i.exec(name);
  if (!json) return undefined;
  let base = json[1];
  let counter: number | undefined;
  const counted = /^(.*)\((\d+)\)$/.exec(base);
  if (counted) {
    base = counted[1];
    counter = Number(counted[2]);
  }
  const dot = base.lastIndexOf('.');
  // Any start of `.supplemental-metadata`, down to `.s`: what a cut at 51 characters leaves.
  if (dot > 0 && base.length - dot >= 2 && SUPPLEMENTAL.startsWith(base.slice(dot))) base = base.slice(0, dot);
  return base === '' ? undefined : { base, ...(counter !== undefined ? { counter } : {}) };
};

/** A name taken apart: what comes before its extension, and the extension with its dot (`''` for none). */
const split = (name: string): { stem: string; ext: string } => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
};

/** `name` as the `counter`th of its name in a folder: `IMG_0001.jpg` → `IMG_0001(1).jpg`. */
const numbered = (name: string, counter: number | undefined): string => {
  if (counter === undefined) return name;
  const { stem, ext } = split(name);
  return `${stem}(${counter})${ext}`;
};

/** A photo's name without its number: `IMG_0001(1).jpg` → `IMG_0001.jpg` and 1. */
const unnumbered = (name: string): { name: string; counter?: number } => {
  const { stem, ext } = split(name);
  const match = /^(.*)\((\d+)\)$/.exec(stem);
  return match ? { name: `${match[1]}${ext}`, counter: Number(match[2]) } : { name };
};

/** The edit suffixes Google gives an edited copy, in the languages a Takeout is written in. */
const EDITED = /^(.+)-(edited|bearbeitet|modifié|editado|editada|modificato|bewerkt|redigerad|redigeret|redigert|muokattu|edytowane|upraveno|szerkesztett)$/iu;

const VIDEO_EXT = /^\.(mp4|mov)$/i;

/** A cut name is believed only this long, so a short one cannot claim a photo by chance. */
const MIN_CUT = 8;

/** A Takeout JSON in a folder: its name, and the `title` its body gives. */
type TakeoutCandidate = { name: string; title?: string };

/**
 * How a folder's Takeout JSONs pair with its media: each paired JSON's photo (`paired`, JSON name
 * → media name), and each media file that shares a paired photo's JSON (`shared`, media name → the
 * JSON's name).
 */
type TakeoutMatch = { paired: Map<string, string>; shared: Map<string, string> };

/** Match the Takeout JSONs `sidecars` of one folder with its media files, by name (`media`). */
export const matchTakeout = (sidecars: TakeoutCandidate[], media: string[]): TakeoutMatch => {
  const present = new Set(media);
  const claimed = new Set<string>();
  const paired = new Map<string, string>();
  const ordered = sidecars.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const keys = new Map(ordered.map((sidecar) => [sidecar.name, takeoutName(sidecar.name)]));
  const claim = (sidecar: string, target: string | undefined): boolean => {
    if (target === undefined || !present.has(target) || claimed.has(target)) return false;
    claimed.add(target);
    paired.set(sidecar, target);
    return true;
  };
  /** The one media file not yet claimed for which `test` holds, or undefined when none or several do. */
  const only = (test: (name: string) => boolean): string | undefined => {
    const found = media.filter((name) => !claimed.has(name) && test(name));
    return found.length === 1 ? found[0] : undefined;
  };
  const pass = (target: (sidecar: TakeoutCandidate, key: { base: string; counter?: number }) => string | undefined) => {
    for (const sidecar of ordered) {
      const key = keys.get(sidecar.name);
      if (key && !paired.has(sidecar.name)) claim(sidecar.name, target(sidecar, key));
    }
  };

  // The title with its number put back.
  pass((sidecar, key) => sidecar.title && numbered(sidecar.title, key.counter));
  // The name the JSON's own name carries.
  pass((_, key) => numbered(key.base, key.counter));
  // The same, in another case: an extension Google wrote as `.JPG` and the title as `.jpg`.
  pass((sidecar, key) => {
    const wanted = [numbered(key.base, key.counter), ...(sidecar.title ? [numbered(sidecar.title, key.counter)] : [])].map((name) => name.toLowerCase());
    return only((name) => wanted.includes(name.toLowerCase()));
  });
  // Cut names: the JSON's name cut short of the photo's, or the photo's own name cut short of the title.
  pass((sidecar, key) =>
    only((name) => {
      const photo = unnumbered(name);
      if (photo.counter !== key.counter) return false;
      if (key.base.length >= MIN_CUT && photo.name.startsWith(key.base) && photo.name !== key.base) return true;
      if (!sidecar.title) return false;
      const own = split(photo.name);
      const titled = split(sidecar.title);
      return own.stem.length >= MIN_CUT && own.ext.toLowerCase() === titled.ext.toLowerCase() && titled.stem.startsWith(own.stem) && own.stem !== titled.stem;
    })
  );

  const sidecarOf = new Map([...paired].map(([sidecar, photo]) => [photo, sidecar]));
  const shared = new Map<string, string>();
  for (const name of media.toSorted()) {
    if (claimed.has(name)) continue;
    const { stem, ext } = split(name);
    const edited = EDITED.exec(stem);
    if (edited) {
      // The original in the same format, or failing that the one photo of that name in any.
      const original = sidecarOf.has(`${edited[1]}${ext}`) ? `${edited[1]}${ext}` : (() => {
        const found = [...sidecarOf.keys()].filter((photo) => split(photo).stem === edited[1]);
        return found.length === 1 ? found[0] : undefined;
      })();
      if (original) shared.set(name, sidecarOf.get(original)!);
      continue;
    }
    if (VIDEO_EXT.test(ext)) {
      const stills = [...sidecarOf.keys()].filter((photo) => split(photo).stem === stem && !VIDEO_EXT.test(split(photo).ext));
      if (stills.length === 1) shared.set(name, sidecarOf.get(stills[0])!);
    }
  }
  return { paired, shared };
};
