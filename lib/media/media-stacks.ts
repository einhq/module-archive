/** Versioned album-local photo-stack metadata stored in `attrs.mediaStacks`. */

export const MEDIA_STACKS_ATTR = 'mediaStacks';
export const MEDIA_STACKS_VERSION = 1 as const;

export type MediaStackGroup = {
  /** Stable file-node id selected as the album tile and lightbox entry. */
  frontId: string;
  /** Every file id in chronological order, including `frontId`. */
  memberIds: string[];
  /**
   * Chosen by hand rather than found by similarity. A refresh keeps it as it is
   * (minus members that left the album) instead of re-deriving it.
   */
  manual?: true;
};

export type AlbumMediaStacks = {
  version: typeof MEDIA_STACKS_VERSION;
  threshold: number;
  maxGapSeconds: number;
  sourceSignature: string;
  computedAt: string;
  /** File ids that must remain separate in this album. */
  excludedIds: string[];
  groups: MediaStackGroup[];
};

const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : undefined;

/** Parse untrusted node attrs without letting a malformed manifest affect album reads. */
export function parseAlbumMediaStacks(value: unknown): AlbumMediaStacks | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== MEDIA_STACKS_VERSION) return undefined;
  if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1) return undefined;
  if (typeof raw.maxGapSeconds !== 'number' || !Number.isFinite(raw.maxGapSeconds) || raw.maxGapSeconds < 0) return undefined;
  if (typeof raw.sourceSignature !== 'string' || typeof raw.computedAt !== 'string') return undefined;
  const excludedIds = strings(raw.excludedIds);
  if (!excludedIds || !Array.isArray(raw.groups)) return undefined;
  const excluded = new Set(excludedIds);
  if (excluded.size !== excludedIds.length) return undefined;

  const groups: MediaStackGroup[] = [];
  const seen = new Set<string>();
  for (const entry of raw.groups) {
    if (!entry || typeof entry !== 'object') return undefined;
    const group = entry as Record<string, unknown>;
    const memberIds = strings(group.memberIds);
    if (
      typeof group.frontId !== 'string' || !memberIds || memberIds.length < 2 || !memberIds.includes(group.frontId) ||
      new Set(memberIds).size !== memberIds.length || memberIds.some((id) => seen.has(id) || excluded.has(id))
    ) {
      return undefined;
    }
    for (const id of memberIds) seen.add(id);
    groups.push({ frontId: group.frontId, memberIds, ...(group.manual === true ? { manual: true as const } : {}) });
  }

  return {
    version: MEDIA_STACKS_VERSION,
    threshold: raw.threshold,
    maxGapSeconds: raw.maxGapSeconds,
    sourceSignature: raw.sourceSignature,
    computedAt: raw.computedAt,
    excludedIds,
    groups,
  };
}

type MediaStackIndex = {
  frontByMemberId: ReadonlyMap<string, string>;
  countByFrontId: ReadonlyMap<string, number>;
};

/** Fast lookup used by album search to collapse members onto their selected front. */
export function indexAlbumMediaStacks(stacks: AlbumMediaStacks | undefined): MediaStackIndex {
  const frontByMemberId = new Map<string, string>();
  const countByFrontId = new Map<string, number>();
  for (const group of stacks?.groups ?? []) {
    countByFrontId.set(group.frontId, group.memberIds.length);
    for (const id of group.memberIds) frontByMemberId.set(id, group.frontId);
  }
  return { frontByMemberId, countByFrontId };
}
