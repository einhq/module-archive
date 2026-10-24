/**
 * A suggested group as the pages and `staging accept` read it: the summary of its row
 * (`StagingRowInfo`, on `album list` and `album info`), and the details of `album info`
 * (`StagingGroupDetail`). Its stored matches count only while they are for its members as they
 * are now (`memberKey`); the albums they name are shown as the reader sees them, and an album the
 * reader cannot see is left out.
 */
import type { StagingAlbumRef, StagingGroupDetail, StagingMatches, StagingPartInfo, StagingRowInfo } from '@archive/staging/api';
import { type AutoAlbumMeta, isNameLocked } from '@archive/staging/auto-album';

/** The attrs of a suggested group these read. */
export type GroupRowAttrs = {
  name?: string;
  autoAlbum?: AutoAlbumMeta;
  stagingMatches?: StagingMatches;
  stagingLaterAt?: string;
};

/** The group's matches, when they are for its members as they are now. */
export const currentMatches = (attrs: GroupRowAttrs): StagingMatches | undefined => {
  const matches = attrs.stagingMatches;
  return matches && attrs.autoAlbum && matches.memberKey === attrs.autoAlbum.memberKey ? matches : undefined;
};

/** The library albums the group's current matches name, by id: its candidates and its days'. */
export const matchedAlbumIds = (attrs: GroupRowAttrs): string[] => {
  const matches = currentMatches(attrs);
  return matches ? [...new Set([...matches.candidates.map((candidate) => candidate.albumId), ...(matches.days ?? []).map((day) => day.albumId)])] : [];
};

/**
 * What staging decides a suggested group by, beside its card: its key, kind and summary, and its
 * best match the reader can see (`refs`, by album id). That match is as sure as stored only when it
 * is the first candidate; past an album the reader cannot see, it is unsure.
 */
export const stagingRowOf = (attrs: GroupRowAttrs, refs: ReadonlyMap<string, StagingAlbumRef>): StagingRowInfo | undefined => {
  const auto = attrs.autoAlbum;
  if (!auto?.memberKey) return undefined;
  const matches = currentMatches(attrs);
  const at = matches ? matches.candidates.findIndex((candidate) => refs.has(candidate.albumId)) : -1;
  const top = matches && at >= 0 ? matches.candidates[at] : undefined;
  const parts = (matches?.days ?? []).filter((day) => refs.get(day.albumId)?.writable);
  return {
    memberKey: auto.memberKey,
    ...(auto.kind ? { kind: auto.kind } : {}),
    ...(auto.precision ? { precision: auto.precision } : {}),
    ...(typeof auto.shots === 'number' ? { shots: auto.shots } : {}),
    ...(auto.significance?.reason ? { significance: auto.significance.reason } : {}),
    ...(auto.seed?.label ? { seed: auto.seed.label } : {}),
    ...(typeof attrs.stagingLaterAt === 'string' ? { later: attrs.stagingLaterAt } : {}),
    ...(isNameLocked(attrs) ? { named: true as const } : {}),
    ...(matches
      ? {
        matchedAt: matches.computedAt,
        matchConfidence: at === 0 ? matches.confidence : 'low' as const,
        matchNew: matches.newAlbum,
      }
      : {}),
    ...(top ? { top: { album: refs.get(top.albumId)!, p: top.score } } : {}),
    ...(parts.length > 0 ? { partsMatched: { parts: parts.length, files: parts.reduce((sum, day) => sum + day.files, 0) } } : {}),
  };
};

/**
 * A group's parts and candidates as `album info` gives them: an Everyday lane's days with their
 * matches, or the parts an event or trip was rolled up from; the candidates the reader can see,
 * best first.
 */
export const groupDetailOf = (attrs: GroupRowAttrs, refs: ReadonlyMap<string, StagingAlbumRef>): StagingGroupDetail => {
  const auto = attrs.autoAlbum;
  const matches = currentMatches(attrs);
  const dayMatch = new Map((matches?.days ?? []).flatMap((day) => refs.has(day.albumId) ? [[day.day, { album: refs.get(day.albumId)!, p: day.score }] as const] : []));
  const parts: StagingPartInfo[] = auto?.dayCounts
    ? auto.dayCounts.map(([day, memberCount]) => ({ day, memberCount, ...(dayMatch.has(day) ? { match: dayMatch.get(day)! } : {}) }))
    : (auto?.parts ?? []).map((part) => ({ timeStart: part.timeStart, timeEnd: part.timeEnd, memberCount: part.memberCount }));
  return {
    parts,
    candidates: (matches?.candidates ?? []).flatMap((candidate) => {
      const album = refs.get(candidate.albumId);
      return album ? [{ album, p: candidate.score, margin: candidate.margin, reasons: candidate.reasons, evidence: candidate.evidence }] : [];
    }),
    visual: matches?.visual ?? false,
  };
};
