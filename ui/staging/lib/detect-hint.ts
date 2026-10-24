import type { StagingCategoryKind, StagingCategoryStatus, StagingDetection } from '@archive/staging/api';
import { stagedPlace } from '@archive/staging/paths';
import { KIND_LABELS } from './overview.ts';

/**
 * The hints `staging detect` gives a newly arrived folder of the default category: "Looks like
 * Google Photos", with a way to its category. Pure, so which folders get one, and which way, is
 * tested without a page.
 */

/** What a hint says a folder of each kind looks like. */
const SOURCE_NAMES: Record<StagingCategoryKind, string> = {
  inbox: '',
  generic: '',
  'google-photos': 'Google Photos',
  scans: 'scans',
  phone: "a phone's pictures",
  camera: "a camera's pictures",
  messaging: 'pictures from a messenger',
  screenshots: 'screenshots',
};

/**
 * One folder's hint: what it looks like (`source`, `text`), the evidence, and what to do about it:
 * move it to the reader's category of that kind (by `staging move`, in the Move dialog), or make
 * one and move it there (`route`, the New category dialog).
 */
export type DetectHint = {
  path: string;
  /** The folder's name. */
  name: string;
  kind: StagingCategoryKind;
  source: string;
  /** "Looks like Google Photos". */
  text: string;
  evidence: string[];
  action:
    | { type: 'move'; category: string; label: string }
    | { type: 'create'; kind: StagingCategoryKind; label: string; route: string };
};

/** The route of the New category dialog for `kind`, which moves the folder at `path` into the category once it is made. */
export const newCategoryRoute = (kind: StagingCategoryKind, path: string): string =>
  `/staging/categories/new?kind=${encodeURIComponent(kind)}&move=${encodeURIComponent(path)}`;

/**
 * The hint `detection` gives, or undefined for none: a folder in the default category, not
 * dismissed, that looks like one source, surely (`high`) or likely (`medium`). Its way is to the category the detection
 * names when that is among `categories`, or else a new one of the kind.
 */
export const detectHint = (detection: StagingDetection, categories: StagingCategoryStatus[], defaultCategory: string): DetectHint | undefined => {
  const { kind, path } = detection;
  if (kind === 'generic' || kind === 'inbox' || detection.confidence === 'low' || detection.dismissed) return undefined;
  if (stagedPlace(path)?.category !== defaultCategory) return undefined;
  const target = detection.category ? categories.find((each) => each.name === detection.category?.name && each.kind === kind) : undefined;
  const source = SOURCE_NAMES[kind];
  return {
    path,
    name: path.split('/').pop() ?? path,
    kind,
    source,
    text: `Looks like ${source}`,
    evidence: detection.evidence,
    action: target
      ? { type: 'move', category: target.name, label: `Move to ${target.label}…` }
      : { type: 'create', kind, label: `Make a ${KIND_LABELS[kind]} category…`, route: newCategoryRoute(kind, path) },
  };
};

/** The hints of `detections`, in their order, leaving out those that give none. */
export const detectHints = (detections: StagingDetection[], categories: StagingCategoryStatus[], defaultCategory: string): DetectHint[] =>
  detections.flatMap((detection) => detectHint(detection, categories, defaultCategory) ?? []);
