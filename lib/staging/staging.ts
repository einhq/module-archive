import { isStagedPath, parseStagedPath, stagingRoots } from '@archive/staging/paths';

/**
 * Whether putting `file` in `album` takes it out of a staging area: it is staged, at any depth
 * under `files/`, and the album is outside that staging area. A link would point into a directory
 * only the area's owner may enter, so such a file is filed instead (`fileStagedMany`); the area's
 * own suggested groups link by design.
 */
export const leavesStaging = (file: string, album: string): boolean => {
  if (!isStagedPath(file)) return false;
  const { stagingPath } = stagingRoots(parseStagedPath(file)!.user);
  return !`${album}/`.startsWith(`${stagingPath}/`);
};
