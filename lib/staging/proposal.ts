/**
 * Where a suggested group is proposed to go: one pure rule, shared by the Sort page (what Enter
 * does, and what the destination column leads with) and `staging accept` (what it files), so what
 * a person sees proposed is what is filed (`@archive/staging/proposal`). Import-free but for
 * types.
 */
import type { GroupKind, MatchConfidence, SignificanceReason, StagingAlbumRef, StagingRowInfo } from '@archive/staging/api';

/** What the rule reads of a group. */
type ProposalInput = {
  kind?: GroupKind;
  title: string;
  /** Why an event or trip is a group of its own. */
  significance?: SignificanceReason;
  /** It has matches for its members as they are now. */
  matched?: boolean;
  /** The best library album it was matched to that the reader can see. */
  top?: { album: StagingAlbumRef; p: number };
  /** How sure its matches are, and how likely it is that none of them is right. */
  matchConfidence?: MatchConfidence;
  matchNew?: number;
  /** An Everyday lane: its days matched to an album the reader may file into, and their photos. */
  partsMatched?: { parts: number; files: number };
  /** The category's destination (`staging category --destination`), as the reader sees it. */
  categoryTarget?: StagingAlbumRef | null;
  /** How many photos it has, and how many of them are copies of library photos that resolve unasked; known for an open group. */
  members?: number;
  libraryDuplicates?: number;
};

/**
 * File into an existing album (`reason`: the group's match, or the category's destination); make
 * a new album titled `title` (`compared`: after the group was compared with the library); file
 * an Everyday lane's matched days into their albums (`parts`); keep the library's copies of a
 * group that is mostly copies of library photos, dropping its `files` (`dedupe`); discard clutter;
 * or no proposal, which leaves the decision to the person.
 */
export type Proposal =
  | { action: 'existing'; album: StagingAlbumRef; confidence: MatchConfidence; reason: 'match' | 'category' }
  | { action: 'new'; title: string; confidence: MatchConfidence; compared: boolean }
  | { action: 'parts'; parts: number; files: number; confidence: MatchConfidence }
  | { action: 'dedupe'; files: number; confidence: MatchConfidence }
  | { action: 'discard'; confidence: MatchConfidence }
  | { action: 'none' };

/** Why a group is a happening worth an album of its own, when no library album fits it. */
const OWN_ALBUM: readonly SignificanceReason[] = ['trip', 'away', 'occasion', 'guests', 'place', 'merged'];

/** The share of a group's photos that are copies of library photos from which keeping the library's is proposed. */
const MOSTLY_COPIES = 0.8;

/** A new album sure from this likelihood that no library album fits, and likely from this one. */
const NEW_SURE = 0.85;
const NEW_LIKELY = 0.5;

/**
 * The proposal for one group, the first rule that applies:
 *
 * 0. a group mostly (`MOSTLY_COPIES`) of copies of library photos keeps the library's, sure: they
 *    are filed already;
 * 1. clutter (screenshots, saved images) is discarded, likely;
 * 2. an Everyday lane files its matched days when it has any (likely), else goes to the category's
 *    destination when the reader may file into it (likely), else has none; an undated lane goes to
 *    the destination or has none;
 * 3. a scan run goes to a sure match, else to the destination, else to a new album, unsure;
 * 4. a seed (a folder a person named) goes to a sure match, else to a new album under its name, sure;
 * 5. an event or a trip goes to a sure or likely match the reader may file into; else to the
 *    destination, likely; else to a new album under its title — sure when it was compared with the
 *    library, no album is likely and it is a happening of its own; likely when it was compared and
 *    no album is likely; unsure otherwise.
 *
 * A match the reader may not file into is passed over, as is a destination.
 */
export function proposeDestination(input: ProposalInput): Proposal {
  const target = input.categoryTarget?.writable ? input.categoryTarget : undefined;
  const toTarget = (album: StagingAlbumRef): Proposal => ({ action: 'existing', album, confidence: 'medium', reason: 'category' });
  const compared = input.matched === true;
  const top = input.top?.album.writable ? input.top.album : undefined;
  const confidence = input.matchConfidence;

  const copies = input.libraryDuplicates ?? 0;
  if (copies > 0 && input.members !== undefined && copies >= MOSTLY_COPIES * input.members) return { action: 'dedupe', files: copies, confidence: 'high' };
  if (input.kind === 'clutter') return { action: 'discard', confidence: 'medium' };
  if (input.kind === 'loose' || input.kind === 'undated') {
    if (input.kind === 'loose' && input.partsMatched && input.partsMatched.parts > 0) {
      return { action: 'parts', parts: input.partsMatched.parts, files: input.partsMatched.files, confidence: 'medium' };
    }
    return target ? toTarget(target) : { action: 'none' };
  }
  if (input.kind === 'folder') {
    if (top && confidence === 'high') return { action: 'existing', album: top, confidence, reason: 'match' };
    return target ? toTarget(target) : { action: 'new', title: input.title, confidence: 'low', compared };
  }
  if (input.kind === 'seed') {
    if (top && confidence === 'high') return { action: 'existing', album: top, confidence, reason: 'match' };
    return { action: 'new', title: input.title, confidence: 'high', compared };
  }
  if (top && (confidence === 'high' || confidence === 'medium')) return { action: 'existing', album: top, confidence, reason: 'match' };
  if (target) return toTarget(target);
  const none = input.matchNew ?? 0;
  if (compared && none >= NEW_SURE && input.significance && OWN_ALBUM.includes(input.significance)) {
    return { action: 'new', title: input.title, confidence: 'high', compared };
  }
  return { action: 'new', title: input.title, confidence: compared && none >= NEW_LIKELY ? 'medium' : 'low', compared };
}

/**
 * The rule's input for a group as its row says it is: a seed under its label, the rest under
 * `title`; with `duplicates`, for an open group, how many photos it has and how many are copies of
 * library photos.
 */
export const proposalInputOf = (
  title: string,
  staging: StagingRowInfo,
  categoryTarget?: StagingAlbumRef | null,
  duplicates?: { members: number; libraryDuplicates: number },
): ProposalInput => ({
  ...(staging.kind ? { kind: staging.kind } : {}),
  title: staging.kind === 'seed' && staging.seed ? staging.seed : title,
  ...(staging.significance ? { significance: staging.significance } : {}),
  matched: staging.matchedAt !== undefined,
  ...(staging.top ? { top: staging.top } : {}),
  ...(staging.matchConfidence ? { matchConfidence: staging.matchConfidence } : {}),
  ...(staging.matchNew !== undefined ? { matchNew: staging.matchNew } : {}),
  ...(staging.partsMatched ? { partsMatched: staging.partsMatched } : {}),
  ...(categoryTarget !== undefined ? { categoryTarget } : {}),
  ...(duplicates ?? {}),
});

/** Whether a proposal is at least as sure as `floor`; `none` never is. */
export const atLeast = (proposal: Proposal, floor: MatchConfidence): boolean => {
  if (proposal.action === 'none') return false;
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[proposal.confidence] >= rank[floor];
};
