/**
 * What the camera area's commands answer with under `JSON_OUTPUT=1`, as types (`@archive/camera/api`).
 *
 * The UI and other modules import these instead of restating the shapes, and each command checks
 * its answer against them. Imports only other type-only files, so a browser can import it
 * without type-checking the module.
 */

import type { NodeOwnership } from '@ein/api';
import type { TimelineEntry } from '@archive/timeline/api';

/** `camera-timeline`: what happened with one camera, in the corpus-wide feed's entries. */
export type CameraTimeline = {
  /** The camera's path. */
  camera: string;
  name: string;
  entries: TimelineEntry[];
};

/** What one camera's relink pass changed. `camera` is its path, so a sweep's rows identify themselves. */
export type RelinkResult = { camera: string; scanned: number; linked: number; retimed: number; skipped: number };

/** A camera the archive has seen in exif but nobody has registered. */
export type CameraProposal = {
  serialNumber?: string;
  make?: string;
  model?: string;
  /** Indexed files carrying this fingerprint. */
  files: number;
  /** What to call it, offered as the name when registering. */
  suggestedName: string;
  /**
   * A camera that is already registered under this name but carries none of
   * this fingerprint — the common case on an imported archive, where cameras
   * came across with a name and nothing to match on. Adopting beats registering
   * a second copy of the same camera.
   */
  existingPath?: string;
  existingName?: string;
  /** Who may change that camera, which is what giving it the fingerprint does. */
  existingOwnership?: NodeOwnership;
};

export type ScanResult = {
  registered: number;
  proposals: CameraProposal[];
  matched: number;
  truncated: boolean;
};

/** One camera `camera-cover` linked a picture for; `replaced` is the target of the link it replaced. */
export type CameraCoverResult = { path: string; cover: string; replaced?: string };

/** `camera-cover`: how many cameras it looked at, and the ones whose cover it wrote. */
export type CameraCoverSweep = { scanned: number; updated: number; cameras: CameraCoverResult[] };
