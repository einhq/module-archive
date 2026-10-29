/**
 * What the staging area's commands answer with under `JSON_OUTPUT=1`, as types (`@archive/staging/api`).
 *
 * The UI and other modules import these instead of restating the shapes, and each command checks
 * its answer against them. Imports only other type-only files, so a browser can import it
 * without type-checking the module.
 */

import type { DuplicateWhere } from '@archive/media/api';
import type { Proposal } from '@archive/staging/proposal';
import type { NodeOwnership } from '@ein/api';

/** Where home was in one year of a category, and which rule said so. */
export type AutoAlbumHome = {
  lat: number;
  lng: number;
  /** `--home`; the owner's residence; the category's densest cell that year; the year before's. */
  source: 'flag' | 'residence' | 'inbox' | 'previous';
  /** The residence's location, when that is where it came from. */
  location?: string;
};

/**
 * The kinds of grouping a suggested group is (`autoAlbum.kind`), which a page sorts it into a lane
 * by: an `event`; a `trip`, a run of days away rolled up from its day-parts; a `seed`, a folder a
 * person named; a `folder` run of scans; a `loose` lane of everyday pictures (or, with
 * `precision`, of pictures dated only to a year or month); `clutter`, screenshots and saved
 * images; and `undated`, pictures with no capture time. A group with no kind is an event.
 */
export type GroupKind = 'event' | 'trip' | 'seed' | 'folder' | 'loose' | 'clutter' | 'undated';

/** How a category's files are grouped: by time and place, by folder and file-name run, or into monthly lanes only. */
export type GroupStrategy = 'events' | 'folders' | 'none';

/** How readily a happening becomes a group of its own rather than part of an Everyday lane. */
export type SignificancePreset = 'fewer' | 'normal' | 'more';

/**
 * Why a planned event or trip is a group of its own rather than part of its year's Everyday lane:
 * away for days (`trip`) or at all (`away`); more shots than the category's usual day (`size`);
 * days at home joined by what they share (`merged`); a named place (`place`); a holiday or a
 * birthday (`occasion`); people seen rarely (`guests`); a person's edit (`edited`); a folder a
 * person named (`seed`).
 */
export type SignificanceReason = 'trip' | 'away' | 'size' | 'merged' | 'place' | 'occasion' | 'guests' | 'edited' | 'seed';

/**
 * A person's edit of a category's grouping, kept on its journal entry (`attrs.stagingEdit`) and
 * applied by the organizer on every run until the entry is undone. Files are named by node id:
 * `cut`, a boundary after the file `after`; `join`, no boundary from `first` to `last` (and with
 * `bounded`, one before `first` and one after `last`); `assign`, `items` go to the group holding
 * `with`; `dismiss`, a group of at least 80% of `members` is not one.
 */
export type StagingEdit =
  | { category: string; op: 'cut'; after: string }
  | { category: string; op: 'join'; first: string; last: string; bounded?: boolean }
  | { category: string; op: 'assign'; items: string[]; with: string }
  | { category: string; op: 'dismiss'; members: string[] };

/**
 * What a grouping verb (`staging split`, `regroup`, `merge`, `delete`, `rename`, `pin`) did: its
 * journal entry, the groups it made, changed and removed, and the groups refused because their
 * members changed since they were read (`--expect`).
 */
export type StagingEditResult = {
  ok: true;
  journal: string | null;
  groupsCreated: string[];
  groupsChanged: string[];
  groupsRemoved: string[];
  changed: string[];
};

/**
 * One group as the organizer planned it, and what the run did with it: made it, rewrote it, found
 * it as planned, left it alone because a person pinned it, removed it as no plan claimed it, or
 * (in an analysis) only proposes it. `members` are its files; `memberPaths` with `--members`.
 */
export type ClusterGroupReport = {
  path?: string;
  action: 'create' | 'update' | 'unchanged' | 'pinned' | 'removed' | 'proposed';
  kind: GroupKind;
  name: string;
  members: number;
  shots?: number;
  timeStart?: string;
  timeEnd?: string;
  provisional?: boolean;
  days?: number;
  parts?: number;
  significance?: SignificanceReason;
  memberPaths?: string[];
};

/**
 * `auto-album-cluster <path>…`: how the organizer would group the media at and under the paths
 * (directories, albums or files), read only. `undated` counts the media with no capture time;
 * `home` is the home of each year.
 */
export type AutoAlbumClusterReport = {
  scopes: string[];
  items: number;
  undated: number;
  geotagged: number;
  withPeople: number;
  home: Record<string, AutoAlbumHome>;
  byKind: Partial<Record<GroupKind, number>>;
  groups: ClusterGroupReport[];
};

/**
 * Why an organizer run planned a whole category: its first run (or one whose checkpoint is of an
 * older shape), its grouping settings changed, a person asked (`--full`), a week since the last,
 * more than a fifth of it changed, its groups not as the last run left them, or the caller may not
 * read the audit trail an incremental run follows.
 */
export type OrganizeFullReason = 'first' | 'settings' | 'asked' | 'week' | 'many' | 'drift' | 'trail';

/**
 * One organizer run over one user's category (`staging organize`): planned whole (`full`, and
 * `why`) or only what changed (`incremental`). `items` counts the indexed media it planned (all
 * of the category's in a full build); `pending` those of the category still waiting to be
 * indexed; `covered` how many of the planned items are in a group once it is done (all of them
 * unless it failed); then what happened to each group planned, the category's groups by kind once
 * done, and how many of the groups planned are named by their dates alone (`bareDates`). An
 * incremental run also says how many records of the audit trail it applied, how many spans of the
 * timeline it planned again (`windows`), and where the next one reads the trail from
 * (`watermark`). `matched`: the groups matched against the library after the run, those it wrote
 * and those around the days of library albums changed since. `skipped: 'deferred'`: more than
 * 2,000 files changed within ten minutes of the last run and nobody asked for one, so nothing was
 * planned and the changes wait for the next. `error` is set, and nothing else counts, when the run
 * failed.
 */
export type OrganizeResult = {
  user: string;
  category: string;
  mode: 'full' | 'incremental';
  why?: OrganizeFullReason;
  dryRun: boolean;
  skipped?: 'deferred';
  error?: string;
  records: number;
  windows: number;
  items: number;
  pending: number;
  covered: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  pinned: number;
  byKind: Partial<Record<GroupKind, number>>;
  bareDates: number;
  watermark: string | null;
  matched: number;
  durationMs: number;
  groups: ClusterGroupReport[];
};

/** `staging organize [--user u | --all] [<category>] [--full] [--dry-run]`: one result per user and category. */
export type StagingOrganizeReport = { results: OrganizeResult[] };

/**
 * One category `staging organize --queue` asked a run of: when (`requestedAt`), or with
 * `--if-pending`, that nothing waits for one (`queued: false`). `why` says what waits: changes in
 * the audit trail since the last run (`changes`), edits made or undone (`edits`), a category never
 * organized or whose settings changed (`first`), or a week since the last full build (`week`).
 */
export type StagingQueued = { user: string; category: string; queued: boolean; requestedAt?: string; why?: 'changes' | 'edits' | 'first' | 'week' };

/** `staging organize --queue [--if-pending]`: one answer per user and category. */
export type StagingQueueReport = { results: StagingQueued[] };

/**
 * A category's organizer as its checkpoint (`albums/<category>/.organizer`) says: when it last ran
 * and last ran in full, whether its last run was full or incremental, the groups and their
 * members, the media waiting to be indexed, the groups by kind, and why the last run failed.
 */
export type OrganizerSummary = {
  lastRunAt: string;
  lastFullAt: string;
  mode: 'full' | 'incremental';
  groups: number;
  members: number;
  pending: number;
  byKind: Partial<Record<GroupKind, number>>;
  error?: string;
};

/**
 * The evidence a library album was weighed by against a group, each in [0, 1] and absent where
 * either side lacks what it needs: `time`, how near the group's photos are to the album's;
 * `place`, the share of the group's located photos taken where the album's were; `people`, the
 * share of the group's people (weighted by rarity) the album has; `visual`, how alike the pictures
 * look; `duplicate`, the share of the group's photos with a copy in the album; `text`, how well a
 * label matches its name.
 * Two say what the album itself is, whatever the group: `breadth`, how many years its days span
 * (0 for a day, 1 for ten years or more); `unsorted`, 1 when its name says it holds whatever was
 * left over.
 */
export type MatchEvidence = {
  time?: number;
  place?: number;
  people?: number;
  visual?: number;
  duplicate?: number;
  text?: number;
  breadth?: number;
  unsorted?: number;
};

/** How sure a match is: sure, likely or unsure. */
export type MatchConfidence = 'high' | 'medium' | 'low';

/**
 * One library album a group may go into, by node id: its probability (`score`), how far it is
 * ahead of the next (`margin`), why in words that name nobody (`reasons`), the evidence it was
 * weighed by, and whether the group's owner may file into it.
 */
export type StagingMatchCandidate = { albumId: string; score: number; margin: number; reasons: string[]; evidence: MatchEvidence; writable: boolean };

/**
 * One day of an Everyday lane and the album its photos would go into: the day, the album by id,
 * how likely, and how many of the lane's photos were taken that day.
 */
export type StagingDayMatch = { day: string; albumId: string; score: number; files: number };

/**
 * Where a group may go, as the matcher found it (`attrs.stagingMatches` on the group, written by
 * nothing else): when, for the members keyed `memberKey` (a group whose key has changed since is
 * as unmatched), by which `model`; whether an existing album or a new one is proposed, how sure,
 * how likely none of the candidates is right (`newAlbum`), whether pictures were compared
 * (`visual`), and the best candidates first, at most three. An Everyday lane has no candidates of
 * its own but its days' matches (`days`), only those likely.
 */
export type StagingMatches = {
  computedAt: string;
  memberKey: string;
  model: string;
  proposal: 'existing' | 'new';
  confidence: MatchConfidence;
  newAlbum: number;
  visual: boolean;
  candidates: StagingMatchCandidate[];
  days?: StagingDayMatch[];
};

/**
 * `staging match [<group>…]`: how many groups were matched and written, and those left alone, with
 * why (a group that is not one, a lane that is not matched, a group still being indexed).
 */
export type StagingMatchResult = { ok: true; matched: number; skipped: { path: string; reason: string }[]; durationMs: number };

/**
 * "Not this album": a person's rejection of a library album for a group, kept on its journal entry
 * (`attrs.stagingReject`) by the group's members' node ids. The album is not offered to any group
 * of the category at least half of whose members are among them, until the entry is undone.
 */
export type StagingReject = { category: string; members: string[]; album: string };

/**
 * On the journal entry of a promote: the matches the group had when a person chose, and what they
 * chose (an album's id, or `new`), each candidate with its rank and evidence. Kept for calibration.
 */
export type StagingMatchDecision = {
  computedAt: string;
  model: string;
  chosen: string;
  candidates: { albumId: string; score: number; rank: number; evidence: MatchEvidence }[];
};

/** One library album `auto-album-assign` offers a subject, with why. */
type AlbumMatchCandidate = {
  album: { id: string; path: string; title: string; mediaCount?: number };
  score: number;
  evidence?: MatchEvidence;
  reasons: string[];
  writable: boolean;
};

/**
 * One subject `auto-album-assign` matched: a suggested group or a directory (`group`), a file
 * (`file`), or everything given at once (`set`); its media and how many are dated, the candidates
 * best first, how likely a new album is, the first candidate's margin, and how sure it is.
 */
export type AlbumMatchSubject = {
  path: string;
  kind: 'group' | 'file' | 'set';
  items: number;
  dated: number;
  candidates: AlbumMatchCandidate[];
  newAlbum: number;
  margin: number;
  confidence: MatchConfidence;
};

/** `auto-album-assign <path>… [--per group|file|set]`: each subject's matches, and the model that made them. */
export type AlbumMatchReport = { subjects: AlbumMatchSubject[]; model: string };

/** On an `album list` row or an `album info` answer that is a suggested album: what deciding it needs beside the card. */
export type StagingRowInfo = {
  /**
   * The member key the album was written with (`autoAlbum.memberKey`). When it changes, the
   * album's members did, and what a page holds of them is stale.
   */
  memberKey: string;
  kind?: GroupKind;
  /** A lane of pictures dated only to a year or a month: how far they are dated. */
  precision?: 'year' | 'month';
  /** Distinct shots: members a few seconds apart from one camera count once. */
  shots?: number;
  /** Why an event or trip is a group of its own. */
  significance?: SignificanceReason;
  /** When the owner put it aside for later (`staging later`), ISO. */
  later?: string;
  /** Its name is a person's: they gave it (`rename`, an edit's `--name`), so the organizer keeps it. */
  named?: true;
  /** A seed's label: the folder's name, or the imported album's title. */
  seed?: string;
  /** When its matches were found; absent while it has none for its members as they are now. */
  matchedAt?: string;
  /** How sure its matches are, and how likely it is that none of them is right. */
  matchConfidence?: MatchConfidence;
  matchNew?: number;
  /** The best album it was matched to that the reader can see, with how likely. */
  top?: { album: StagingAlbumRef; p: number };
  /** An Everyday lane: its days matched to an album the reader may file into, and their photos. */
  partsMatched?: { parts: number; files: number };
};

/** One album a group may go into, as the reader sees it: how likely, why, ahead of the next by how much, and on what evidence. */
export type StagingCandidate = { album: StagingAlbumRef; p: number; margin: number; reasons: string[]; evidence: MatchEvidence };

/**
 * One part of a group: a day of an Everyday lane, or a part an event or trip was rolled up from;
 * when it was, its members, and for a lane's day the album it was matched to.
 */
export type StagingPartInfo = { timeStart?: string; timeEnd?: string; day?: string; memberCount: number; match?: { album: StagingAlbumRef; p: number } };

/** What deciding one group needs beside its row (`album info`): its parts, and its candidates best first. */
export type StagingGroupDetail = { parts: StagingPartInfo[]; candidates: StagingCandidate[]; visual: boolean };

/** What a category holds, which sets the defaults of its settings (`staging category --kind`). */
export type StagingCategoryKind = 'inbox' | 'google-photos' | 'scans' | 'phone' | 'camera' | 'messaging' | 'screenshots' | 'generic';

/**
 * Which clocks a category's files are dated by. `digitized`: its files are copies made long after
 * the picture (scans), so every clock recorded while digitizing them (the device's, the GPS
 * receiver's, the file name's) is not a capture time. `filenameDates`: a date its files' names
 * spell is a capture time when nothing better is known.
 */
export type StagingTimeRules = { digitized: boolean; filenameDates: boolean };

/**
 * Which lane the work on a category's files runs in. `bulk`: below everything of the `normal`
 * lane, so a large import goes on in the background while what is uploaded to another category is
 * processed first.
 */
export type StagingLane = 'normal' | 'bulk';

/**
 * Whether the sidecars that arrive in a category (Google Photos Takeout JSON, XMP) are paired with
 * their files as they land (`pair`, by `media-sidecars`), or left as they are (`ignore`).
 */
export type StagingSidecars = 'pair' | 'ignore';

/** A category's settings, `attrs.stagingCategory` on its directory under `files/`. */
export type StagingCategorySettings = {
  kind: StagingCategoryKind;
  /** What a page calls it; the directory's name is its key and never changes. */
  label: string;
  /** The library album (or directory of albums) its files are filed into by default, by node id. */
  destinationId?: string;
  /** How its files are grouped, and how readily a happening becomes a group of its own. */
  group: { strategy: GroupStrategy; significance: SignificancePreset };
  /** Which clocks its files are dated by. */
  time: StagingTimeRules;
  /** The lane the work on its files runs in. */
  lane: StagingLane;
  /** Whether sidecars arriving there are paired with their files. */
  sidecars: StagingSidecars;
};

/** A library album as staging names it: a category's destination. */
export type StagingAlbumRef = {
  id: string;
  path: string;
  title: string;
  timeStart?: string;
  timeEnd?: string;
  /** Its media, as `album-span` counted them. */
  count?: number;
  ownership: NodeOwnership;
  /** Whether the asker may file into it. */
  writable: boolean;
};

/**
 * A category's staged originals, from one aggregate: `files` are the pictures, videos and
 * recordings and `other` every other file; `indexing` the media whose metadata has not been read
 * yet (`indexedAt`), a deferred exact copy being none of them, `indexed` those whose metadata has
 * been read, which the organizer groups, and `undated` those read without a capture time; `bytes`
 * all of them; `copies` the media that are exact copies, by where their originals lie, and `near`
 * those that look like other pictures or videos, by where those lie.
 */
export type StagingFileCounts = {
  files: number;
  other: number;
  indexing: number;
  indexed: number;
  undated: number;
  bytes: number;
  copies: Record<DuplicateWhere, number>;
  near: Record<DuplicateWhere, number>;
};

/** One category of a staging area, as `staging status` and `staging category` give it. */
export type StagingCategoryStatus = {
  /** The directory's name: the category's key. */
  name: string;
  id: string;
  /** Its directory under `files/`. */
  path: string;
  /** Its suggested groups' directory under `albums/`. */
  albumsPath: string;
  /** Where a browser upload lands today, in the archive's time zone. */
  uploadPath: string;
  label: string;
  kind: StagingCategoryKind;
  settings: StagingCategorySettings;
  destination: StagingAlbumRef | null;
  counts: StagingFileCounts;
  /** The organizer's summary of the category's groups; null until the organizer first runs. */
  organizer: OrganizerSummary | null;
  /** Files filed into the library and discarded from it, by the journal's decisions not undone. */
  decided: StagingDecidedTotals;
};

/**
 * `staging status [--user u]`: one user's staging area, read without changing anything.
 * `initialized` is false until `staging init` has made the layout and the default category.
 * `routesWaiting` counts the GPX files in `routes/`.
 */
export type StagingStatus = {
  user: string;
  initialized: boolean;
  stagingPath: string;
  defaultCategory: string;
  categories: StagingCategoryStatus[];
  routesWaiting: number;
};

/**
 * What `staging init` did, or would do with `--dry-run`, to one user's staging area: directories
 * `created`, and `repaired` to the home's owner and 0700 or to a category's settings; directories
 * under `files/` `adopted` as categories; `moved` loose entries of `files/` into `movedTo`, the
 * default category's loose batch; `groups` loose groups of `albums/` into the default category's;
 * `routes` GPX files waiting for a device into `routes/`; the links that followed; the moves that
 * failed.
 */
export type StagingInitUser = {
  user: string;
  created: string[];
  repaired: string[];
  adopted: string[];
  moved: number;
  movedTo: string | null;
  /** Loose files of `files/` left where they are, changed within `--idle-minutes`. */
  recent: number;
  groups: number;
  routes: number;
  relinked: number;
  failed: { path: string; error: string }[];
};

/** `staging init [--user u | --all] [--loose-batch name] [--layout-only] [--idle-minutes n] [--dry-run]`: each user's staging area made whole. */
export type StagingInitAnswer = { ok: boolean; dryRun: boolean; users: StagingInitUser[] };

/**
 * One way a staging area breaks its rules: a directory `missing`, `not-directory`, or with the
 * wrong `mode` or `owner`; `staging/` `not-unlisted`, so the library's views list what it holds; a
 * `loose-entry` in `files/` or `albums/`, which hold categories only;
 * `no-inbox`, the default category missing or of another kind; `orphan-albums`, a directory of
 * groups with no category; `cross-category`, a group's link to a file outside its category;
 * `dangling-link`, one to nothing; `waiting-route`, a GPX file waiting for a device outside
 * `routes/`.
 */
export type StagingCheckProblem = {
  code: 'missing' | 'not-directory' | 'mode' | 'owner' | 'not-unlisted' | 'loose-entry' | 'no-inbox' | 'orphan-albums' | 'cross-category' | 'dangling-link' | 'waiting-route';
  path: string;
  detail: string;
};

/**
 * `staging check [--user u]`: one user's staging area against its rules, read only. `checkedLinks`
 * counts the group links looked at, at most 20,000; `truncated` says there were more.
 */
export type StagingCheckAnswer = { user: string; ok: boolean; checkedLinks: number; truncated: boolean; problems: StagingCheckProblem[] };

/**
 * `staging retime [<path>]`: the staged media originals under `path` (a category, a folder or a
 * file; every category without one) dated again by their category's time rules. `scanned` counts
 * the media originals read; `policyChanged` those whose `digitized` or `whenName` changed;
 * `retimed` those whose capture time changed, `bySource` by the source that now dates them and
 * `cleared` those left with none; `failed` the files that could not be written.
 */
export type StagingRetimeAnswer = {
  ok: boolean;
  dryRun: boolean;
  user: string;
  path: string;
  scanned: number;
  policyChanged: number;
  retimed: number;
  cleared: number;
  bySource: Record<string, number>;
  failed: { path: string; error: string }[];
};

/**
 * `staging category <name> [--create | --remove | --kind | --label | --destination | --no-destination | --digitized | --filename-dates | --lane]`:
 * the category as it now is (null once removed), and what the call changed: the settings' fields
 * by name. `retime` is how its files were dated again when the change touched its time rules.
 */
export type StagingCategoryAnswer = {
  ok: true;
  created: boolean;
  removed: boolean;
  changed: string[];
  retime: StagingRetimeAnswer | null;
  category: StagingCategoryStatus | null;
};

/** Files decided in a category: filed into the library, and discarded (copies too), by decisions not undone. */
export type StagingDecidedTotals = { filed: number; discarded: number };

/**
 * What a journal entry records: `promote` files suggested groups into a library album
 * (`staging promote`, `staging accept`), `file` files staged files into one (`album add`),
 * `discard` puts staged files in the trash (`staging discard`), `dedupe` puts staged copies
 * there once their kept files are filled in from them (`staging dedupe`), `edit` changes the
 * suggested groups (`staging split`, `regroup`, `merge`, `delete`, `rename`, `pin`), and `reject`
 * says a library album is not where a group goes (`staging reject`).
 */
export type StagingJournalAction = 'promote' | 'file' | 'discard' | 'dedupe' | 'edit' | 'reject';

/**
 * `attrs.stagingJournal` of an entry under `staging/journal/`: whose staging area it is (`inbox`,
 * a username), which category, when, and what was decided. `files` counts the staged originals it
 * moved; `albums` are the library albums filed into and `created` those the decision made, by node
 * id; `groups` the suggested groups it decided. `state` is `planned` from before the first change
 * until the decision ends, then `done`, or `partial` when some of it failed. `undoneAt` is set by
 * `staging undo`, and an entry is never deleted.
 */
export type StagingJournalAttrs = {
  inbox: string;
  category: string;
  at: string;
  action: StagingJournalAction;
  files: number;
  summary: string;
  albums?: string[];
  created?: string[];
  share?: 'private';
  groups?: { slug: string; name: string }[];
  batches?: string[];
  state: 'planned' | 'done' | 'partial';
  undoneAt?: string;
};

/**
 * A suggested group as a decision found it, so `staging undo` can give back what the decision took
 * from it: the member links that left (each with its target's node id), and the cover when it
 * showed one of them. `emptied` says the decision left it with no member, so it was deleted; undo
 * then makes it again from `attrs` and `props`.
 */
export type GroupSnapshot = {
  path: string;
  id: string;
  attrs: Record<string, unknown>;
  props: { uid: number; gid: number; mode: number };
  links: { name: string; target: string; id: string }[];
  cover?: string;
  emptied: boolean;
};

/** A staged file's own sharing before it was filed, which undo gives it back. */
export type StagedAccess = { mode: number; gid: number; acl?: { mode: number; uid?: number; gid?: number }[] };

/**
 * The body of a journal entry: what undoing it takes, written before the decision changes
 * anything. `filed`: each file's move by node id, from its staged path to where it was filed, with
 * its sharing before; the groups it left; for a promote that made the group itself the album
 * (`group`), that node's path as a group, its path as an album, and its attrs, props and member
 * links as a group.
 * `trashed`: the trash batches its files went into, in whose trash (`home`), and the groups they
 * left. `groups`: the suggested groups of the directory `albums` an edit changed, each as it was
 * with every member link it had (an edit that only renamed or pinned one keeps no links).
 * `matches`: the matches of the groups (by node id) a rejection changed, as they were.
 */
export type StagingUndoPlan =
  | {
    kind: 'filed';
    moves: ({ id: string; from: string; to: string } & StagedAccess)[];
    groups: GroupSnapshot[];
    group?: {
      id: string;
      from: string;
      to: string;
      attrs: Record<string, unknown>;
      props: { uid: number; gid: number; mode: number };
      links: { name: string; target: string; id: string }[];
    };
  }
  | { kind: 'trashed'; home: string; batches: string[]; groups: GroupSnapshot[] }
  | { kind: 'groups'; albums: string; groups: GroupSnapshot[] }
  | { kind: 'matches'; groups: { id: string; matches: StagingMatches | null }[] };

/**
 * One entry as `staging journal` lists it: its attrs and id (the entry's name), whether it can
 * still be undone, the grouping edit or the rejection it keeps, and the first album it filed into
 * or rejected, as the reader can see it.
 */
export type StagingJournalEntry = StagingJournalAttrs & {
  id: string;
  undoable: boolean;
  edit?: StagingEdit;
  reject?: StagingReject;
  destination?: { path: string; title: string };
};

/**
 * `staging journal [<category>]`: a page of entries, newest first, with the cursor of the next
 * page (null on the last), and the category's totals (every category's without one).
 */
export type StagingJournalPage = { entries: StagingJournalEntry[]; cursor: string | null; totals: StagingDecidedTotals };

/**
 * `staging promote <group>…`: the library album the groups' files went into (`created` when this
 * made it), the groups decided, how many files moved, the groups the files left that were deleted
 * or changed, the groups refused because their members changed (`--expect`), and the files that
 * did not move. `journal` is the entry that undoes it, null on a dry run or when nothing was
 * decided.
 */
export type StagingPromoteResult = {
  ok: true;
  dryRun: boolean;
  journal: string | null;
  album: { path: string; title: string; created: boolean } | null;
  groups: string[];
  moved: number;
  groupsRemoved: string[];
  groupsChanged: string[];
  changed: string[];
  failed: { path: string; error: string }[];
};

/**
 * `staging discard <group|file|folder>…`: how many staged originals went to the trash, in which
 * batches, the groups they left (deleted or changed), the groups refused by `--expect`, and what
 * did not go. `journal` as for promote.
 */
export type StagingDiscardResult = {
  ok: true;
  dryRun: boolean;
  journal: string | null;
  files: number;
  batches: string[];
  groupsRemoved: string[];
  groupsChanged: string[];
  changed: string[];
  failed: { path: string; error: string }[];
};

/** Why `staging accept` left a group as it was; `discard`, its proposal is to discard it, which accept never does. */
type StagingAcceptSkip = 'changed' | 'below-confidence' | 'no-proposal' | 'not-writable' | 'discard';

/**
 * `staging accept <group>…`: each group's proposal and its files (`plan`), the journal entries of
 * the groups filed, and the groups left alone, with why. A dry run answers the plan alone.
 */
export type StagingAcceptResult = {
  ok: true;
  dryRun: boolean;
  plan: { group: string; proposal: Proposal; files: number }[];
  journal: string[];
  skipped: { group: string; reason: StagingAcceptSkip }[];
};

/** `staging later <group>… [--off]`: the groups now put aside (or, with `--off`, back in their lane). */
export type StagingLaterResult = { ok: true; groups: string[]; later: boolean };

/**
 * `staging undo <entry>…`: the entries undone, how many files came back and which groups were
 * given back their members, and the entries that could not be undone, with why and the files that
 * stayed where they are.
 */
export type StagingUndoResult = {
  ok: true;
  undone: string[];
  restoredFiles: number;
  restoredGroups: string[];
  failed: { id: string; reason: string; files?: string[] }[];
};

/**
 * `staging move <path>… <dir>`: staged entries moved into a folder of a category, with the links
 * to them following; those going to another category first left their own category's groups.
 */
export type StagingMoveResult = { ok: true; moved: number; relinked: number; left: number; failed: { path: string; error: string }[] };

/**
 * How sure a detection is: `high`, a mark only that source leaves (a `Takeout/Google Photos`
 * tree, a scanner named in the EXIF) or several signs and nothing pointing elsewhere; `medium`,
 * signs that point one way more than any other; `low`, a sign or two, or two sources as likely.
 */
export type StagingDetectionConfidence = 'high' | 'medium' | 'low';

/**
 * What a folder of staged (or any) files looks like it came from, by `staging detect`: the
 * category `kind` it fits (`generic` when no source's marks were found; never `inbox`), how sure,
 * and the `evidence`, strongest first. `category` is the user's category of that kind (the one the
 * folder lies in when it is of that kind, otherwise the first by name), null when they have none
 * or the kind is `generic`. `seen` is what was read: the files within (`files`, counted), the file
 * names sampled, and the folders listed or seen in the sample. `dismissed` is true when the folder
 * carries `detectDismissed: true` (set with `attrs -J detectDismissed=true <folder>`): its owner
 * keeps it where it is and wants no hint for it.
 */
export type StagingDetection = {
  path: string;
  dismissed: boolean;
  kind: StagingCategoryKind;
  confidence: StagingDetectionConfidence;
  evidence: string[];
  category: { name: string; label: string; path: string } | null;
  seen: { files: number; sampled: number; folders: number };
};

/**
 * `staging detect [<folder>…] [--user u]`: a detection per folder named, or without one per folder
 * newly arrived in the user's default category, newest first: each folder directly in it but an
 * upload folder, and each folder directly in an upload folder, leaving out the dismissed ones.
 * `more` is true when more arrived than were looked at.
 */
export type StagingDetectAnswer = { user: string; detections: StagingDetection[]; more: boolean };
