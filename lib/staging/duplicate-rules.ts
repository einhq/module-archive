/**
 * The rules a staging inbox's duplicate sets are resolved by, decided when a set is read: which
 * file is kept and why, which copies go, what the kept file would gain from them, and whether
 * `staging dedupe --apply` may resolve the set unasked. Pure: the reader hands in what it read
 * (`@archive/staging/duplicate-read`).
 *
 * An exact set is an original and its byte-identical staged copies. The original is kept: a
 * library file always, as nothing in staging drops or rewrites one, and otherwise the staged file
 * that arrived first — the one every copy's finding names — unless a person chose another of the
 * staged ones. Only copies in the folder read are dropped; the others are left for a read of
 * their own folder.
 *
 * A near set is a staged picture or video (its anchor) and the files it looks like. A library file
 * is kept when there is one; between staged files the better picture is (`decideNearSet`). As
 * look-alikes may be two shots of a burst rather than one picture twice, `--apply` drops only
 * smaller versions of a library picture, and leaves everything else to a person.
 */
import type { DuplicateBlock, DuplicateFlag, DuplicateKeepRule, DuplicateReason, DuplicateWhere, MergeField } from '@archive/media/api';
import { NEAR } from '@archive/media/near-duplicates';

/** What the rules know of one file of a set. */
export type RuleFile = {
  id: string;
  place: DuplicateWhere;
  /** A staged file in the folder read; a library file never is. */
  inScope: boolean;
  size?: number;
  description?: string;
  whenManual?: string;
  positionManual?: boolean;
  /** It has a `position` child: a place read from the file. */
  hasPosition: boolean;
  labels: string[];
  /** The reader has starred it. */
  starred: boolean;
  /** It has `comments/`, and `people/` tags. */
  hasComments: boolean;
  hasPeople: boolean;
  /** It has a paired sidecar, `<file>/sidecar`. */
  hasSidecar: boolean;
};

/** An exact set as read: its original (undefined when the reader cannot find it with the copies' bytes), and its staged copies. */
export type ExactSetInput = {
  original: RuleFile | undefined;
  /** The original's id, as the copies name it. */
  originalId: string;
  copies: RuleFile[];
  /** Whether the reader may write the kept file, when the merge would fill it in. */
  keepWritable: (id: string) => boolean;
  /** A staged file of the set a person chose to keep. */
  chosen?: string;
};

/** What the rules decide about an exact set. */
type ExactSetRules = {
  keep: string;
  discard: string[];
  reasons: DuplicateReason[];
  /** Per dropped file, what it would fill into the kept one. */
  carries: Map<string, MergeField[]>;
  /** What the kept file would gain from all of them. */
  gains: MergeField[];
  reclaimableBytes: number;
  flags: DuplicateFlag[];
  bulk: boolean;
  blocked?: DuplicateBlock;
};

/** The order `MergeField`s are listed in. */
const FIELD_ORDER: MergeField[] = ['description', 'time', 'place', 'labels', 'star', 'sidecar', 'faces', 'people', 'comments', 'albums'];

/**
 * What merging `drop` into `keep` would fill in, as `merge-duplicates` does it, never overwriting:
 * a description, a hand-typed time or a place the kept file lacks, labels it lacks, the reader's
 * star, a sidecar it lacks, the drop's comments and `people/` tags. People named in face boxes are not foreseen here:
 * telling a person's naming from a machine's guess takes each box's read.
 */
export const carriesOf = (keep: RuleFile, drop: RuleFile): MergeField[] => {
  const fields: MergeField[] = [];
  if (!keep.description && drop.description) fields.push('description');
  if (!keep.whenManual && drop.whenManual) fields.push('time');
  if (!keep.positionManual && !keep.hasPosition && (drop.positionManual || drop.hasPosition)) fields.push('place');
  if (drop.labels.some((label) => !keep.labels.includes(label))) fields.push('labels');
  if (drop.starred && !keep.starred) fields.push('star');
  if (drop.hasSidecar && !keep.hasSidecar) fields.push('sidecar');
  if (drop.hasPeople) fields.push('people');
  if (drop.hasComments) fields.push('comments');
  return fields;
};

/** The fields of `lists` together, in `MergeField` order. */
export const unionFields = (lists: Iterable<MergeField[]>): MergeField[] => {
  const all = new Set([...lists].flat());
  return FIELD_ORDER.filter((field) => all.has(field));
};

/** Why the kept file is kept: a person's choice, the library, or arriving first. */
const keepRule = (input: ExactSetInput, keep: string): DuplicateKeepRule =>
  input.chosen !== undefined && keep === input.chosen && keep !== input.originalId ? 'chosen' : input.original?.place === 'library' ? 'library' : 'earliest';

/**
 * Decide an exact set. Kept: the chosen staged file when there is one, else the original. Dropped:
 * every other staged file of the set in the folder read. Blocked when the original is not found
 * (`keep-gone`: gone, unreadable, or other bytes now), and when the merge would fill in a kept file
 * the reader cannot write (`keep-not-writable`; a star needs no write). `outside-scope` when a copy
 * lies outside the folder read.
 */
export const decideExactSet = (input: ExactSetInput): ExactSetRules => {
  const staged = [...(input.original?.place === 'inbox' ? [input.original] : []), ...input.copies];
  const chosen = input.chosen !== undefined ? staged.find((file) => file.id === input.chosen) : undefined;
  const keepFile = chosen ?? input.original;
  const keep = keepFile?.id ?? input.originalId;
  const dropped = staged.filter((file) => file.id !== keep && file.inScope);
  const carries = new Map(dropped.map((drop) => [drop.id, keepFile ? carriesOf(keepFile, drop) : []]));
  const gains = unionFields(carries.values());
  const rule = keepRule(input, keep);
  const blocked: DuplicateBlock | undefined = input.original === undefined
    ? 'keep-gone'
    : gains.some((field) => field !== 'star') && !input.keepWritable(keep)
    ? 'keep-not-writable'
    : undefined;
  return {
    keep,
    discard: dropped.map((file) => file.id),
    reasons: dropped.map((file) => ({ rule, keep, over: file.id })),
    carries,
    gains,
    reclaimableBytes: dropped.reduce((sum, file) => sum + (file.size ?? 0), 0),
    flags: staged.some((file) => file.id !== keep && !file.inScope) ? ['outside-scope'] : [],
    bulk: blocked === undefined && dropped.length > 0,
    ...(blocked ? { blocked } : {}),
  };
};

/** What the rules know of one file of a near set, beside what a merge would carry. */
export type NearRuleFile = RuleFile & {
  name: string;
  mimetype?: string;
  /** Its size as shown. */
  width?: number;
  height?: number;
  takenAtUtc?: string;
  takenAtSource?: string;
  device?: string;
  /** The files of the set it is alike to, by its own finding (none for a library file). */
  alike: string[];
};

/** A near set as read: its anchor, a staged file, and the files it looks like, with how alike each is to it. */
type NearSetInput = {
  anchor: NearRuleFile;
  peers: { file: NearRuleFile; score: number }[];
  keepWritable: (id: string) => boolean;
  chosen?: string;
};

/** A format's rank when two staged look-alikes are compared: RAW above HEIC above TIFF and PNG above JPEG above WebP above GIF. */
const formatRank = (mimetype: string | undefined): number => {
  const type = (mimetype ?? '').toLowerCase();
  if (/dng|raw|x-(canon|nikon|sony|fuji|olympus|panasonic|pentax)/.test(type)) return 5;
  if (/hei[cf]/.test(type)) return 4;
  if (/tiff|png/.test(type)) return 3;
  if (/webp/.test(type)) return 1;
  if (/gif/.test(type)) return 0;
  return 2;
};

/** A capture time's source's rank: typed by a person, GPS, the camera, a sidecar, the file's name, none. */
const CAPTURE_RANK: Record<string, number> = { manual: 5, gps: 4, device: 3, sidecar: 2, name: 1 };

/** A name a copy is given: `(2)`, a trailing `-1`, or `copy`. */
const COPY_NAME = /\(\d+\)|[-_ ]\d$|\bcopy\b|kopia/i;

const pixelsOf = (file: NearRuleFile): number | undefined => file.width !== undefined && file.height !== undefined ? file.width * file.height : undefined;

/**
 * The first rule that tells two staged look-alikes apart, and which one it keeps: more pixels (by
 * more than a hundredth), a better format, a better capture time, more bytes, a name without a
 * copy's suffix, and else the one that arrived first (the smaller id).
 */
const preferred = (a: NearRuleFile, b: NearRuleFile): { keep: NearRuleFile; rule: DuplicateKeepRule; detail?: string } => {
  const pa = pixelsOf(a) ?? 0;
  const pb = pixelsOf(b) ?? 0;
  const size = (file: NearRuleFile) => `${file.width ?? '?'}×${file.height ?? '?'}`;
  if (pa > pb * 1.01) return { keep: a, rule: 'pixels', detail: `${size(a)} over ${size(b)}` };
  if (pb > pa * 1.01) return { keep: b, rule: 'pixels', detail: `${size(b)} over ${size(a)}` };
  const fa = formatRank(a.mimetype);
  const fb = formatRank(b.mimetype);
  if (fa !== fb) {
    return fa > fb ? { keep: a, rule: 'format', detail: `${a.mimetype} over ${b.mimetype}` } : { keep: b, rule: 'format', detail: `${b.mimetype} over ${a.mimetype}` };
  }
  const ca = CAPTURE_RANK[a.takenAtSource ?? ''] ?? 0;
  const cb = CAPTURE_RANK[b.takenAtSource ?? ''] ?? 0;
  if (ca !== cb) return ca > cb ? { keep: a, rule: 'capture' } : { keep: b, rule: 'capture' };
  if ((a.size ?? 0) !== (b.size ?? 0)) return (a.size ?? 0) > (b.size ?? 0) ? { keep: a, rule: 'bytes' } : { keep: b, rule: 'bytes' };
  const na = COPY_NAME.test(a.name.replace(/\.[^.]*$/, ''));
  const nb = COPY_NAME.test(b.name.replace(/\.[^.]*$/, ''));
  if (na !== nb) return na ? { keep: b, rule: 'name' } : { keep: a, rule: 'name' };
  return a.id < b.id ? { keep: a, rule: 'earliest' } : { keep: b, rule: 'earliest' };
};

/** Whether two files could be two frames of a burst: one size, one camera, the same second. */
const burstPair = (a: NearRuleFile, b: NearRuleFile): boolean =>
  a.width !== undefined && a.width === b.width && a.height === b.height && a.device !== undefined && a.device === b.device &&
  a.takenAtUtc !== undefined && a.takenAtUtc.slice(0, 19) === b.takenAtUtc?.slice(0, 19);

/** What the rules decide about a near set. */
type NearSetRules = ExactSetRules & { score?: number };

/**
 * Decide a near set. Kept: the library file most alike to the anchor when there is one — nothing
 * in staging drops a library file, so a staged file chosen beside one keeps both — and among
 * staged files the chosen one, or the best by `preferred`. Dropped: the staged files in the folder
 * read that are alike to the kept one (the anchor is alike to all; the others to those their own
 * findings name). `--apply` resolves only a set against the library whose every dropped file has
 * fewer pixels than the kept one, and that is no possible burst; every other set is for a person
 * to look at (`needs-review`).
 */
export const decideNearSet = (input: NearSetInput): NearSetRules => {
  const all = [input.anchor, ...input.peers.map((peer) => peer.file)];
  const scoreOf = new Map(input.peers.map((peer) => [peer.file.id, peer.score]));
  const library = input.peers.filter((peer) => peer.file.place === 'library').sort((a, b) => b.score - a.score || (a.file.id < b.file.id ? -1 : 1));
  const staged = all.filter((file) => file.place === 'inbox');
  const chosen = input.chosen !== undefined ? staged.find((file) => file.id === input.chosen) : undefined;
  let keepFile: NearRuleFile;
  let rule: DuplicateKeepRule | undefined;
  if (chosen) {
    keepFile = chosen;
    rule = 'chosen';
  } else if (library.length > 0) {
    keepFile = library[0].file;
    rule = 'library';
  } else keepFile = staged.reduce((best, file) => preferred(best, file).keep);
  const keep = keepFile.id;
  const alike = (file: NearRuleFile) => keep === input.anchor.id || file.id === input.anchor.id || file.alike.includes(keep) || keepFile.alike.includes(file.id);
  const candidates = staged.filter((file) => file.id !== keep && alike(file));
  const dropped = candidates.filter((file) => file.inScope);
  const reasons: DuplicateReason[] = dropped.map((file) => {
    if (rule) return { rule, keep, over: file.id };
    const why = preferred(keepFile, file);
    return { rule: why.rule, keep, over: file.id, ...(why.detail ? { detail: why.detail } : {}) };
  });
  const carries = new Map(dropped.map((drop) => [drop.id, carriesOf(keepFile, drop)]));
  const gains = unionFields(carries.values());
  const keepPixels = pixelsOf(keepFile);
  const flags: DuplicateFlag[] = [];
  if (candidates.some((file) => !file.inScope)) flags.push('outside-scope');
  if (library.length > 0 && keepFile.place === 'library' && staged.some((file) => (pixelsOf(file) ?? 0) > (keepPixels ?? Infinity))) flags.push('staged-larger');
  if (all.some((a, i) => all.slice(i + 1).some((b) => burstPair(a, b)))) flags.push('possible-burst');
  const smaller = dropped.every((file) => keepPixels !== undefined && pixelsOf(file) !== undefined && pixelsOf(file)! < keepPixels);
  const unwritable = gains.some((field) => field !== 'star') && !input.keepWritable(keep);
  const closeEnough = scoreOf.size > 0 && Math.min(...scoreOf.values()) >= NEAR.bulkScore;
  const bulk = !unwritable && dropped.length > 0 && rule === 'library' && smaller && closeEnough && flags.every((flag) => flag === 'outside-scope');
  const blocked: DuplicateBlock | undefined = unwritable ? 'keep-not-writable' : !bulk ? 'needs-review' : undefined;
  const best = Math.max(0, ...scoreOf.values());
  return {
    keep,
    discard: dropped.map((file) => file.id),
    reasons,
    carries,
    gains,
    reclaimableBytes: dropped.reduce((sum, file) => sum + (file.size ?? 0), 0),
    flags,
    bulk,
    ...(blocked ? { blocked } : {}),
    ...(scoreOf.size > 0 ? { score: best } : {}),
  };
};
