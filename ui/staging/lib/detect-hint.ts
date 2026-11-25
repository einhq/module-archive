import type { StagingDetection, StagingSource } from '@archive/staging/api';
import { stagedPlace } from '@archive/staging/paths';

/**
 * The hints `staging detect` gives a newly arrived folder of the default category: "Looks like
 * Google Photos", with two ways on: move it into a category the reader picks, or make a new
 * category for it. Pure, so which folders get one is tested without a page.
 */

/** What a hint says a folder from each source looks like. */
const SOURCE_NAMES: Record<StagingSource, string> = {
  generic: '',
  'google-photos': 'Google Photos',
  scans: 'scans',
  phone: "a phone's pictures",
  camera: "a camera's pictures",
  messaging: 'pictures from a messenger',
  screenshots: 'screenshots',
};

/** What a category made for a folder from each source is called to begin with. */
const SOURCE_LABELS: Record<StagingSource, string> = {
  generic: '',
  'google-photos': 'Google Photos',
  scans: 'Scans',
  phone: 'Phone',
  camera: 'Camera',
  messaging: 'Messaging',
  screenshots: 'Screenshots',
};

/**
 * One folder's hint: what it looks like (`source`, `text`), the evidence, and the route of the New
 * category dialog that makes a category for it and moves it there (`route`).
 */
export type DetectHint = {
  path: string;
  /** The folder's name. */
  name: string;
  source: string;
  /** "Looks like Google Photos". */
  text: string;
  evidence: string[];
  route: string;
};

/** The route of the New category dialog, called `label` to begin with, which moves the folder at `path` into the category once it is made. */
export const newCategoryRoute = (label: string, path: string): string => `/staging/categories/new?move=${encodeURIComponent(path)}&label=${encodeURIComponent(label)}`;

/**
 * The hint `detection` gives, or undefined for none: a folder in the default category, not
 * dismissed, that looks like one source, surely (`high`) or likely (`medium`).
 */
export const detectHint = (detection: StagingDetection, defaultCategory: string): DetectHint | undefined => {
  const { source, path } = detection;
  if (source === 'generic' || detection.confidence === 'low' || detection.dismissed) return undefined;
  if (stagedPlace(path)?.category !== defaultCategory) return undefined;
  return {
    path,
    name: path.split('/').pop() ?? path,
    source: SOURCE_NAMES[source],
    text: `Looks like ${SOURCE_NAMES[source]}`,
    evidence: detection.evidence,
    route: newCategoryRoute(SOURCE_LABELS[source], path),
  };
};

/** The hints of `detections`, in their order, leaving out those that give none. */
export const detectHints = (detections: StagingDetection[], defaultCategory: string): DetectHint[] =>
  detections.flatMap((detection) => detectHint(detection, defaultCategory) ?? []);
