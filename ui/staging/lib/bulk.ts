/**
 * What a run of calls over many groups keeps and says (`hooks/useBulkRun.ts`): the journal entries
 * its answers name, which Undo all takes back; the groups an answer gives back unfiled; how far it
 * has come; and, for accepting proposals, the plan read first, by where each group would go. Pure,
 * so it is tested without a page.
 */
import type { MatchConfidence, StagingAcceptResult } from '@archive/staging/api';

/** The journal entries an answer names: one (`staging promote`, `discard`, the edits), several (`staging accept`, `album add`) or none. */
export function journalOf(answer: unknown): string[] {
  const journal = (answer as { journal?: unknown } | null)?.journal;
  if (typeof journal === 'string') return [journal];
  return Array.isArray(journal) ? journal.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * The groups an answer left where they were, by path: those that changed under the reader
 * (`changed`), and those `staging accept` skipped, for whatever reason.
 */
export function leftOf(answer: unknown): string[] {
  const value = answer as { changed?: unknown; skipped?: unknown } | null;
  const changed = Array.isArray(value?.changed) ? value.changed.filter((path): path is string => typeof path === 'string') : [];
  const skipped = Array.isArray(value?.skipped)
    ? value.skipped.map((each: { group?: unknown }) => each?.group).filter((path): path is string => typeof path === 'string')
    : [];
  return [...new Set([...changed, ...skipped])];
}

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en')} ${value === 1 ? one : many}`;

/** How far a run has come: "Filing 1,840 of 9,830 photos · 37 of 214 groups". */
export function progressLine(verb: string, done: { groups: number; files: number }, total: { groups: number; files: number }): string {
  const parts = [];
  if (total.files > 0) parts.push(`${done.files.toLocaleString('en')} of ${count(total.files, 'photo', 'photos')}`);
  if (total.groups > 0) parts.push(`${done.groups.toLocaleString('en')} of ${count(total.groups, 'group', 'groups')}`);
  return `${verb} ${parts.join(' · ')}`;
}

/** Each confidence a floor lets through. */
const RANK: Record<MatchConfidence, number> = { low: 0, medium: 1, high: 2 };

/** What accepting the proposals would do, by destination. */
type AcceptSummary = {
  /** Existing albums, each with the groups and pictures it would get, most groups first. */
  existing: { path: string; title: string; groups: number; files: number }[];
  /** Groups that would become new albums under their own names. */
  newAlbums: { groups: number; files: number };
  /** Everyday lanes whose matched days would go into their albums, and those days' pictures. */
  matchedDays: { groups: number; files: number };
  /** Groups left as they are, by why. */
  skipped: { changed: number; unsure: number; none: number };
  /** The groups that would be filed, by path. */
  filed: string[];
};

/**
 * The plan `staging accept --dry-run` read (every confidence), summed by destination for the
 * proposals at least as sure as `floor`; the others are skipped as unsure, those without a
 * proposal (or proposed to be discarded, which accepting never does) as none, and those that
 * changed under the reader as changed.
 */
export function acceptSummary(plan: StagingAcceptResult['plan'], changed: readonly string[], floor: MatchConfidence): AcceptSummary {
  const existing = new Map<string, AcceptSummary['existing'][number]>();
  const summary: AcceptSummary = {
    existing: [],
    newAlbums: { groups: 0, files: 0 },
    matchedDays: { groups: 0, files: 0 },
    skipped: { changed: changed.length, unsure: 0, none: 0 },
    filed: [],
  };
  for (const { group, proposal, files } of plan) {
    if (proposal.action === 'none' || proposal.action === 'discard' || proposal.action === 'dedupe') {
      summary.skipped.none++;
      continue;
    }
    if (RANK[proposal.confidence] < RANK[floor]) {
      summary.skipped.unsure++;
      continue;
    }
    summary.filed.push(group);
    if (proposal.action === 'new') {
      summary.newAlbums.groups++;
      summary.newAlbums.files += files;
      continue;
    }
    if (proposal.action === 'parts') {
      summary.matchedDays.groups++;
      summary.matchedDays.files += files;
      continue;
    }
    const album = existing.get(proposal.album.path) ?? { path: proposal.album.path, title: proposal.album.title, groups: 0, files: 0 };
    album.groups++;
    album.files += files;
    existing.set(album.path, album);
  }
  summary.existing = [...existing.values()].sort((a, b) => b.groups - a.groups || a.title.localeCompare(b.title));
  return summary;
}
