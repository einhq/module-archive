/**
 * What a picture's maker notes say about the camera that took it: how many pictures the camera had
 * taken by then, the firmware it ran, and the lens on it. Read from the `raw` exiftool dump on the
 * file's `metadata/exif` node (`exiftool -n`, so values are unprinted: a lens may be a number, a
 * version a row of numbers), one tag at a time, which is how `camera-usage` projects them.
 *
 * Pure, so the rules can be tested without an archive.
 */

import type { CameraSighting, CameraUsage } from '@archive/camera/api';

/** Where each fact is read from, first readable tag first. */
const SHUTTER_TAGS = ['ShutterCount', 'ImageCount'] as const;
const FIRMWARE_TAGS = ['CanonFirmwareVersion', 'FirmwareVersion', 'Firmware', 'Software'] as const;
const LENS_TAGS = ['LensModel', 'Lens', 'LensID', 'LensInfo'] as const;
/** The lens tags that may describe it by focal lengths and apertures instead; a `LensID` of numbers is a type. */
const LENS_SPEC_TAGS = ['LensInfo', 'Lens'] as const;

/** Every tag `readMakerNotes` reads. */
export const MAKER_NOTE_TAGS: readonly string[] = [...new Set([...SHUTTER_TAGS, ...FIRMWARE_TAGS, ...LENS_TAGS])];

/** One picture's facts about its camera; each only where its tags carry it. */
type MakerNotes = { shutterCount?: number; firmware?: string; lens?: string };

/** A version written as a row of numbers (`0 1 1 3`), as `-n` leaves some, in dots. */
const dotted = (value: string): string => /^\d+( \d+)+$/.test(value) ? value.split(' ').join('.') : value;

/**
 * The version in a `Software` tag, when a camera wrote it: `K-7 Ver 1.12`, `Ver.1.00`, `Z3 v1.02`,
 * or a bare version (`1.0.6`, `A1.00 B1.00`). Anything else there is the program that last saved the
 * picture, which says nothing about the camera.
 */
const softwareVersion = (value: string): string | undefined => {
  const named = /\bver(?:sion)?\.?\s*(\d[\w.]*)$/i.exec(value) ?? /(?:^|\s)v(\d+(?:\.\d+)+)$/i.exec(value);
  if (named) return named[1];
  return /^[A-Z]?\d+(?:\.\d+)+(?:\s+[A-Z]?\d+(?:\.\d+)+)*$/.test(value) ? value : undefined;
};

/** The firmware a tag names, in the form its maker shows it. */
const firmwareOf = (tag: string, value: string): string | undefined => {
  if (tag === 'Software') return softwareVersion(value);
  const version = dotted(value.replace(/^firmware\s+(?:version\s+)?/i, '').trim());
  return /\d/.test(version) ? version : undefined;
};

/**
 * A lens's name, when the tag holds one: words, not numbers (`-n` leaves Canon's and Pentax's lens
 * types as numbers, and an unknown aperture as `undef`) nor a row of hex bytes (Nikon's).
 */
const lensName = (value: string): string | undefined =>
  value.split(' ').some((word) => !/^(\d+(\.\d+)?|undef)$/.test(word)) && !/^[0-9A-F]{2}( [0-9A-F]{2})+$/.test(value) ? value : undefined;

const decimal = (value: number): string => String(Number(value.toFixed(1)));

/**
 * A lens described by its focal lengths and apertures (`LensInfo`, Nikon's and Canon's `Lens`):
 * `16 55 2.8 2.8` is `16–55mm f/2.8`. An aperture of 0 or `undef` is unknown.
 */
const lensSpec = (value: string): string | undefined => {
  const parts = value.split(' ');
  if (parts.length < 2 || parts.length > 4) return undefined;
  const [short, long, wide, narrow] = parts.map((part) => (/^\d+(\.\d+)?$/.test(part) ? Number(part) : 0));
  if (!(short > 0 && long >= short)) return undefined;
  const focal = short === long ? `${decimal(short)}mm` : `${decimal(short)}–${decimal(long)}mm`;
  if (!(wide > 0)) return focal;
  return narrow > 0 && decimal(narrow) !== decimal(wide) ? `${focal} f/${decimal(wide)}–${decimal(narrow)}` : `${focal} f/${decimal(wide)}`;
};

/**
 * A lens name that says no more than its focal lengths and apertures, as a program writes one
 * (`17.0-70.0 mm f/2.8-4.0`), in the form `lensSpec` gives the same lens from numbers.
 */
const asSpec = (name: string): string => {
  const match = /^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*mm(?:\s*f\/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?)?$/i.exec(name);
  if (!match) return name;
  const [, short, long = short, wide = '0', narrow = wide] = match;
  return lensSpec(`${short} ${long} ${wide} ${narrow}`) ?? name;
};

/** One picture's maker notes, from its tags as text (`tags.LensModel`, …). */
export const readMakerNotes = (tags: Record<string, string>): MakerNotes => {
  const notes: MakerNotes = {};

  for (const tag of SHUTTER_TAGS) {
    const value = tags[tag]?.trim();
    if (value && /^\d+$/.test(value) && Number(value) > 0) {
      notes.shutterCount = Number(value);
      break;
    }
  }

  for (const tag of FIRMWARE_TAGS) {
    const value = tags[tag]?.trim();
    const firmware = value ? firmwareOf(tag, value) : undefined;
    if (firmware) {
      notes.firmware = firmware;
      break;
    }
  }

  // A name wherever one is written, before a description from numbers.
  const text = (tag: string) => tags[tag]?.trim() || undefined;
  const named = LENS_TAGS.map((tag) => text(tag) && lensName(text(tag)!)).find(Boolean);
  const lens = (named && asSpec(named)) ??
    LENS_SPEC_TAGS.map((tag) => text(tag) && lensSpec(text(tag)!)).find(Boolean);
  if (lens) notes.lens = lens;

  return notes;
};

/** One picture: when it was taken (`YYYY-MM-DD…`, absent when undated), and what its maker notes say. */
export type NotedPicture = { date?: string } & MakerNotes;

const widen = (span: CameraSighting, date: string | undefined): void => {
  span.files++;
  if (!date) return;
  if (!span.first || date < span.first) span.first = date;
  if (!span.last || date > span.last) span.last = date;
};

/**
 * What a camera's pictures say about it, together: its shutter count as the highest a day's
 * pictures carry, oldest day first; each firmware with the days it was first and last seen, in the
 * order it was first seen; each lens with how many pictures, most used first.
 */
export const summariseUsage = (camera: string, files: number, pictures: NotedPicture[]): CameraUsage => {
  const shutter = new Map<string, number>();
  const firmware = new Map<string, CameraSighting>();
  const lenses = new Map<string, CameraSighting>();

  for (const picture of pictures) {
    const day = picture.date?.slice(0, 10);
    if (picture.shutterCount !== undefined && day) shutter.set(day, Math.max(shutter.get(day) ?? 0, picture.shutterCount));
    if (picture.firmware) {
      if (!firmware.has(picture.firmware)) firmware.set(picture.firmware, { files: 0 });
      widen(firmware.get(picture.firmware)!, day);
    }
    if (picture.lens) {
      if (!lenses.has(picture.lens)) lenses.set(picture.lens, { files: 0 });
      widen(lenses.get(picture.lens)!, day);
    }
  }

  // Undated sightings sort last.
  const byFirst = (a: CameraSighting, b: CameraSighting) => a.first === b.first ? 0 : !a.first ? 1 : !b.first ? -1 : a.first.localeCompare(b.first);

  return {
    camera,
    files,
    shutter: [...shutter].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    firmware: [...firmware]
      .sort(([, a], [, b]) => byFirst(a, b))
      .map(([version, span]) => ({ version, ...span })),
    lenses: [...lenses]
      .sort(([nameA, a], [nameB, b]) => b.files - a.files || nameA.localeCompare(nameB))
      .map(([lens, span]) => ({ lens, ...span })),
  };
};
