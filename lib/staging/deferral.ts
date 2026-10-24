/**
 * The deferral gate. A staged exact copy of a file its owner can read is not indexed while it is
 * one: `exif-extract` records it `deferred` (`DuplicateFinding` in `@archive/media/api`) and reads
 * nothing from it, and media discovery asks `deferredCopy` before announcing a file that is not
 * indexed, so nothing downstream starts for it. The write that takes `deferred` off, when the copy
 * stops being one, is an update of the file that discovery then announces, as it does new bytes and
 * a copy outside every inbox. Apart from the staging rules (`@archive/staging/facts`) because the
 * media rules ask it, and those rules import the media rules.
 */
import { parseStagedPath } from '@archive/staging/paths';

/**
 * Whether the file at `path`, with `attrs`, is a staged exact copy left unindexed on purpose:
 * deferred for the bytes it has now, in an inbox.
 */
export const deferredCopy = (path: string, attrs: Record<string, unknown>): boolean => {
  const finding = attrs.duplicate as { deferred?: unknown; sha256?: unknown } | undefined;
  if (finding?.deferred !== true || finding.sha256 !== attrs.sha256) return false;
  const parsed = parseStagedPath(path);
  return parsed?.area === 'files' && parsed.category !== undefined;
};
