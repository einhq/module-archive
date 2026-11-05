/**
 * The marker a file's renditions carry: which rendition table they were made by.
 *
 * `generate-derivatives` writes it on the file node once every rendition the table names for the
 * file is there, or recorded as one this box refused (`TRANSCODE_REFUSED_ATTR`): `renditionsFor`, a
 * signature of the table's entries for the file's kind, and `renditionsAt`, when. The bridge
 * announces that write as `media.renditions.made`, and `renditions-scan` finds the files whose
 * marker is missing or names another table by a query, in every tree, rather than by listing each
 * file's `thumbnails/`. A changed table changes the signature of the kinds it changed, so it reopens
 * those files and no others.
 */

import type { RenditionKind, RenditionTable } from '@ein/api';

/** File-node attr: the signature of the table the file's renditions were made by. */
export const RENDITIONS_FOR_ATTR = 'renditionsFor';

/** File-node attr: when the file's renditions were complete under that table, ISO 8601. */
export const RENDITIONS_AT_ATTR = 'renditionsAt';

/** The same value with every object's keys in order, so equal tables always write the same text. */
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, ordered(item)]));
};

/**
 * The signature of what the table makes of a file of `kind`: its picture roles made of that kind,
 * and a video's or a recording's roles, with the storyboard a video's playback is tiled into. The
 * first 16 hex digits of the SHA-256 of that part, so a change to the audio roles leaves every
 * photo's marker current.
 */
export const renditionSignature = async (table: RenditionTable, kind: RenditionKind): Promise<string> => {
  const part = {
    image: Object.fromEntries(Object.entries(table.image).filter(([, rendition]) => rendition.kinds.includes(kind))),
    ...(kind === 'video' ? { video: table.video, storyboard: table.video.playback ? table.storyboard ?? null : null } : {}),
    ...(kind === 'audio' ? { audio: table.audio } : {}),
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ordered(part))));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * File-node attr recording renditions EMS *refused* on its CPU-decode budget, as distinct from
 * ones it failed at or never reached.
 *
 * Written by `generate-derivatives` (and cleared per rendition the moment one is made). A refused
 * rendition counts as accounted for when the marker is written, and `renditions-scan` reopens the
 * file once the budget it was refused under is no longer the one EMS runs. The same shape as
 * `undecodable` and for the same reason — a gap no re-announcement can close has to be recorded on
 * the file node — but keyed per rendition rather than per file: a source can be over budget for
 * the full 1080p rendition and comfortably inside it for the 20-second hover clip, and that is the
 * common case, not the corner one.
 */
export const TRANSCODE_REFUSED_ATTR = 'transcodeRefused';

/** One refusal, keyed in `TRANSCODE_REFUSED_ATTR` by the rendition's file name (`1920x1080.mp4`). */
export type TranscodeRefusal = {
  /** The message EMS refused with, for a human reading `attrs`. */
  reason: string;
  /**
   * The signature of the CPU-decode budget the refusal was computed against —
   * `capabilities.encode.cpu_budget` as EMS reported it at the time (its
   * `<max MB>/<MB per 1k frames>/<max windows>`), read through `generations()`.
   *
   * This is what makes the record clearable without anyone having to remember to clear it. The
   * refusal is a function of EMS's memory budget and not of the source, so raising the budget
   * must reopen the file — and it does, because the signature stored here no longer matches the
   * one the scan reads from EMS. The whole signature, not just the megabytes: a source can be
   * refused for needing too many windows at an unchanged budget. Opaque here on purpose: both the
   * writer and the reader take it from EMS, so they cannot derive it differently.
   */
  budget: string;
  /** When the refusal was recorded, epoch ms. */
  at: number;
};

/** The refusals recorded in a file node's attrs, tolerant of an attr written by an older shape. */
export const refusalsOf = (attrs: Record<string, unknown>): Record<string, TranscodeRefusal> => {
  const raw = attrs[TRANSCODE_REFUSED_ATTR];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, TranscodeRefusal>;
};
