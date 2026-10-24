/**
 * Which of several selected clusters survives a bulk merge. Free of the shell client, so it is
 * testable without a browser runtime.
 */

/** The fields the choice actually depends on — anything with these can be ranked. */
type MergeCandidate = { path: string; faceCount: number; createdAt?: string };

/**
 * The cluster with the most faces wins, ties going to the older one.
 *
 * Biggest-wins is what makes bulk merge one click instead of a destination picker: it is
 * almost always the cluster that already carries the good crops, and picking the survivor
 * by hand is what the single-cluster popup is for. The tie-break on age keeps the result
 * stable — without it two equal clusters would swap locations between refetches.
 */
export function mergeDestination<T extends MergeCandidate>(people: T[]): T | undefined {
  return [...people].sort((a, b) => b.faceCount - a.faceCount || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0];
}
