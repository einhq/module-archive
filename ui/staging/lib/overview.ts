import type { StagingCategoryKind, StagingCategoryStatus, StagingFileCounts } from '@archive/staging/api';
import { CATEGORY_SLUG } from '@archive/staging/paths';
import type { UploadCounts } from '@ein/ui/lib';

/**
 * What the overview and the progress strip say about a category, from its `staging status`
 * counts. Pure, so the numbers the bars draw are tested without a page.
 */

/** What a category holds, as the pages call it; `generic` is any other. */
export const KIND_LABELS: Record<StagingCategoryKind, string> = {
  inbox: 'Inbox',
  'google-photos': 'Google Photos export',
  scans: 'Scans',
  phone: 'Phone',
  camera: 'Camera',
  messaging: 'Messaging',
  screenshots: 'Screenshots',
  generic: 'Other',
};

/** The kinds a new category can be, in the order they are offered: every kind but the inbox's. */
export const NEW_KINDS: StagingCategoryKind[] = ['google-photos', 'scans', 'phone', 'camera', 'messaging', 'screenshots', 'generic'];

export type CategorySegmentKey = 'preparing' | 'ready' | 'undated' | 'other';

/** One part of a category's bar: what it is, what it is called, how many files. */
type CategorySegment = { key: CategorySegmentKey; label: string; value: number };

/**
 * A category's staged originals split into the parts its bar draws, in order: media whose metadata
 * is still being read, media read and ready to sort, media read without a capture time, and files
 * that are not media. Together they are every staged original but an empty media file and a
 * deferred exact copy, which are never read.
 */
export const categorySegments = (counts: StagingFileCounts): CategorySegment[] => [
  { key: 'preparing', label: 'Being prepared', value: counts.indexing },
  { key: 'ready', label: 'To sort', value: Math.max(0, counts.indexed - counts.undated) },
  { key: 'undated', label: 'Needs a date', value: counts.undated },
  { key: 'other', label: 'Other files', value: counts.other },
];

/** Every staged original a category holds, media or not. */
export const heldFiles = (counts: StagingFileCounts): number => counts.files + counts.other;

/**
 * Where a category's newest files are on their way in: `arriving`, the files of the uploads into
 * it under way (`done` of `of`), absent when none are; `preparing`, its media whose metadata is
 * still being read; `grouping`, its media read but not yet in a group, which the organizer's next
 * run puts in one (it puts every read file in exactly one).
 */
export type CategoryStages = { arriving?: { done: number; of: number }; preparing: number; grouping: number };

/** A category's `CategoryStages`, from its status and the uploads into it (`uploadsUnder` its path). */
export const categoryStages = (category: Pick<StagingCategoryStatus, 'counts' | 'organizer'>, uploads: UploadCounts | undefined): CategoryStages => {
  const waiting = uploads ? uploads.queued + uploads.active : 0;
  return {
    ...(uploads && waiting > 0 ? { arriving: { done: uploads.done, of: uploads.done + waiting } } : {}),
    preparing: category.counts.indexing,
    grouping: Math.max(0, category.counts.indexed - (category.organizer?.members ?? 0)),
  };
};

/** Whether anything is on its way in. */
export const stagesUnderWay = (stages: CategoryStages): boolean => stages.arriving !== undefined || stages.preparing > 0 || stages.grouping > 0;

/** How many files were still being prepared at a moment (`at`, in ms). */
export type PreparingSample = { count: number; at: number };

/**
 * The sample the rate of preparing is measured from, given the one held and a new one: the held
 * one while the count only falls, the new one when there was none or the count rose (files
 * arrived, so the run starts again).
 */
export const preparingBaseline = (held: PreparingSample | undefined, next: PreparingSample): PreparingSample =>
  held === undefined || next.count > held.count || next.at < held.at ? next : held;

/**
 * How long, in ms, the files still being prepared take at the rate they went since `baseline`;
 * undefined when nothing is left, or nothing has gone yet to measure a rate by.
 */
export const preparingEta = (baseline: PreparingSample | undefined, now: PreparingSample): number | undefined => {
  if (!baseline || now.count <= 0) return undefined;
  const done = baseline.count - now.count;
  const elapsed = now.at - baseline.at;
  if (done <= 0 || elapsed <= 0) return undefined;
  return now.count * (elapsed / done);
};

/** Letters that do not take their accent off by decomposition, as plain ones. */
const FOLDED: Record<string, string> = { 'æ': 'ae', 'ø': 'o', 'ß': 'ss', 'đ': 'd', 'ł': 'l', 'þ': 'th', 'œ': 'oe' };

/**
 * A category's name made from what it is called: lowercase letters and digits, everything else one
 * dash, accents dropped, at most 48 characters (`CATEGORY_SLUG`). Empty for a label with no letter
 * or digit in it.
 */
export const categorySlug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[æøßđłþœ]/g, (letter) => FOLDED[letter])
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48)
    .replace(/-+$/, '');

/** `slug`, or `slug-2`, `slug-3`, … — the first not in `taken`, cut so it stays a valid name; empty for an empty slug. */
export const freeSlug = (slug: string, taken: Iterable<string>): string => {
  if (!CATEGORY_SLUG.test(slug)) return '';
  const used = new Set(taken);
  if (!used.has(slug)) return slug;
  for (let n = 2;; n++) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, 48 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
};
