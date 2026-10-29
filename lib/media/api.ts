/**
 * What the media area's commands answer with under `JSON_OUTPUT=1`, as types (`@archive/media/api`).
 *
 * The UI and other modules import these instead of restating the shapes, and each command checks
 * its answer against them. Imports only other type-only files, so a browser can import it
 * without type-checking the module.
 */

import type { CommentEntry, NodeOwnership } from '@ein/api';
import type { PersonFace, PersonVoice } from '@archive/people/api';
import type { StagingGroupDetail, StagingRowInfo } from '@archive/staging/api';

export type NodeRef = {
  id: string;
  path: string;
  name: string;
};

/**
 * Where a face sits in the image: fractions (0..1) of the display frame, so the same numbers
 * land correctly over the original and over every srcset size. See @archive/media/orientation.
 */
export type FaceBox = { x: number; y: number; width: number; height: number };

export type PersonTag = NodeRef & {
  born?: string;
  age?: number;
  ageMonths?: number;
  ageApprox?: boolean;
  /** How the file knows the person: a tag, a face, or only a voice heard in it. */
  source: 'tag' | 'face' | 'voice';
  /** Only for `source: 'face'` — a boxless legacy tag has none. */
  faceBox?: FaceBox;
};

export type MediaPosition = {
  lat: number;
  lng: number;
  address?: string;
  city?: string;
  country?: string;
};

/** A location link, carrying the location's own point when it has one. */
export type LocationRef = NodeRef & { lat?: number; lng?: number; radius?: number };

/**
 * An album holding the file. `memberPath` is the softlink inside the album, set
 * only when the album links the file rather than holding it (added to it, or a staging suggestion).
 */
export type AlbumRef = NodeRef & { memberPath?: string };

/** A person who owns the device, with the span the ownership link carries. */
export type OwnerRef = NodeRef & { from?: string; to?: string };

/** The device the file was taken with, and who owned it. */
export type DeviceRef = NodeRef & { make?: string; model?: string; owners: OwnerRef[] };

/** A perceptual fingerprint child — provenance only, never the vector. */
export type FingerprintRef = { name: string; computedAt?: string; computedBy?: string };

/**
 * The content hashes the node happens to carry. `file-sync` writes `sha256`;
 * the legacy import brought `md5`/`sha1` and never wrote one.
 */
export type MediaHashes = { sha256?: string; sha1?: string; md5?: string };

export type StackMemberRef = {
  id: string;
  path: string;
  name: string;
  ownership: NodeOwnership;
  mimetype?: string;
  takenAt?: string;
  width?: number;
  height?: number;
  /** Pixel aspect ratio of the raster above, present only when it is not square. */
  sar?: number;
  angle?: number;
  duration?: number;
  size?: number;
};

export type MediaStackDetails = {
  albumId: string;
  albumPath: string;
  albumOwnership: NodeOwnership;
  excluded: boolean;
  membersComplete: boolean;
  frontId?: string;
  members: StackMemberRef[];
};

export type MediaExif = {
  make?: string;
  model?: string;
  serial?: string;
  iso?: number;
  exposure?: number;
  fps?: number;
  duration?: number;
  frames?: number;
  /** Audio stream, from ffprobe at index time (`exif-extract`). Audio files only. */
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  width?: number;
  height?: number;
  /** Pixel aspect ratio of `width`/`height` — an anamorphic video's, never a still's. */
  sar?: number;
  /** The picture: the raster turned by `angle` and squared by `sar`. */
  displayWidth?: number;
  displayHeight?: number;
  devicePath?: string;
  /** Only present when fetched with `--fields raw`. */
  raw?: Record<string, unknown>;
};

/** A face belonging to someone recognition found but nobody has named. */
export type UnknownFace = {
  faceId: string;
  /** The region; its crop is the child `image.avif`, and may be absent. */
  facePath: string;
  personId: string;
  personPath: string;
  personName: string;
  faceBox?: FaceBox;
};

/**
 * One editable box on the photo — a region; multiple entries may belong to the same person. On a
 * video the box holds at `atSeconds` only, and `appearances` say when the face is on screen.
 */
export type MediaFace = {
  faceId: string;
  facePath: string;
  faceBox: FaceBox;
  atSeconds?: number;
  appearances?: [number, number][];
  /** On a video: the face has a track, its box a line per sampled frame; one drawn by hand has none. */
  tracked?: boolean;
  /** A detected face with a vector; false for a tag — a box a human drew, an import carried, or a face too poor to vote. */
  hasFace: boolean;
  personId?: string;
  personPath?: string;
  personName?: string;
  unnamed?: boolean;
};

/** What `detect-chapters` says of one file: the cuts it found, or why it looked for none. */
export type DetectChaptersAnswer = {
  path: string;
  skipped?: 'not-video' | 'undecodable' | 'detected' | 'no-rendition' | 'ems-lacks-op' | 'unreadable';
  boundaries?: { t: number; score: number | null; kind: 'cut' | 'leader' }[];
  detectedBy?: string;
};

export type MediaDetails = {
  path: string;
  name: string;
  /** File-node mode and owner, for client-side edit affordances. */
  ownership: NodeOwnership;
  /** The hand-written one. Never machine-written — see `content`. */
  description?: string;
  /** Text found in the image or document itself (index-document, OCR for images). */
  content?: string;
  /** `content` was cut short by the server. */
  contentTruncated?: boolean;
  /** The language `content` was read in (ISO 639-1), with EMS's confidence when it told it. */
  contentLanguage?: { code: string; confidence?: number };
  /** The language a person set for a picture's text (`file-set-text-language`). */
  contentLanguageManual?: string;
  /**
   * A timed transcript with at least one cue exists at `<path>/metadata/transcript`, as
   * WebVTT. The body is fetched separately — it can run to an hour of speech, which has no
   * business in every details response.
   */
  hasTranscript?: boolean;
  /** What whisper detected, for the subtitles' language and the panel heading. */
  transcriptLanguage?: string;
  /**
   * A video's storyboard: its frames at an even interval tiled row by row into one sheet,
   * `<path>/thumbnails/<name>`, for the frame the player's timeline shows under the pointer.
   * Tile `i` is the frame at `i × interval` seconds; `count` can fall short of a full grid.
   * `sha256` is the sheet's, so a sheet made again under the same name is a new URL.
   */
  storyboard?: { name: string; sha256: string; interval: number; count: number; columns: number; tileWidth: number; tileHeight: number };
  /**
   * Where a video's chapters start, in seconds on the rendition's clock, the first at 0: its cuts,
   * from `<path>/metadata/chapters`. Present only when there is at least one cut.
   */
  chapters?: number[];
  /** The wall clock, at whatever precision is honest. */
  takenAt?: string;
  /** The instant, `YYYY-MM-DDTHH:MM:SSZ`. Only needed to offer the viewer's own reading. */
  takenAtUtc?: string;
  /** Which source won: `manual`, `gps`, `device` or `name`. */
  takenAtSource?: string;
  /** A digitized copy (a scan): the clocks recorded while digitizing were not believed. */
  digitized?: true;
  /** Why a hand-typed time is what it is, when somebody said. */
  takenAtNote?: string;
  /** The hand-typed source itself — present exactly when there is something to revert. */
  whenManual?: string;
  /** Effective orientation of the display frame the face boxes are measured in. */
  angle: 0 | 90 | 180 | 270;
  mirror: boolean;
  mimetype?: string;
  size?: number;
  /**
   * Why nothing can decode the file, set by `exif-extract` when ffprobe could not read the
   * container at all (a MOV truncated before its `moov` atom, say). Present only on the files
   * that have it, and the lightbox shows the reason in place of a player that cannot work.
   */
  undecodable?: string;
  /** Whatever content hashes the node carries. */
  hashes: MediaHashes;
  exif: MediaExif | null;
  /** The file's own point (`<file>/position`) and the address reverse geocoding wrote on it. */
  position: MediaPosition | null;
  location: LocationRef | null;
  photographer: NodeRef | null;
  device: DeviceRef | null;
  /** Every album holding the file — the one it lives in and any that link it. */
  albums: AlbumRef[];
  people: PersonTag[];
  /** Every active box, without the one-row-per-person collapse used by the sidebar. */
  faces: MediaFace[];
  /** Kept out of `people` so the sidebar is not swamped by "Unknown …" rows. */
  unknownFaces: UnknownFace[];
  /** The voices of a recording, in the order they are first heard; empty for one never voiceprinted. */
  speakers: MediaSpeaker[];
  /** Turns spoken by somebody no voice could be told for: a brief voice unlike any heard at length. */
  unattributedTurns: [number, number][];
  comments: CommentEntry[];
  fingerprints: FingerprintRef[];
  albumStack?: MediaStackDetails;
};

export type SubclusterResult = {
  person: { id: string; path: string; name: string; unnamed: boolean };
  total: number;
  withoutVector: number;
  faces: PersonFace[];
  merges: Merge[];
  groups: number[][];
  suggested: { threshold: number; groups: number };
};

/** `subcluster-voices`: the same dendrogram over one person's voices, one per recording heard in. */
export type VoiceSubclusterResult = {
  person: { id: string; path: string; name: string; unnamed: boolean };
  total: number;
  /** Voices whose recording was never voiceprinted, which have nothing to compare. */
  withoutVector: number;
  voices: PersonVoice[];
  merges: Merge[];
  groups: number[][];
  suggested: { threshold: number; groups: number };
};

/** `face-confirm`: regions a human said show the person they are on. */
export type FaceConfirmResult = { confirmed: string[] };

/**
 * One agglomeration step as it comes over the wire: `[a, b, similarity, size]`.
 *
 * `a` and `b` are cluster ids — `0..n-1` are faces, and merge `i` creates
 * cluster `n + i`. Merges arrive ordered by decreasing similarity.
 */
export type Merge = [a: number, b: number, sim: number, size: number];

/** One voice of a recording, as media-details reports it. */
export type MediaSpeaker = {
  /** The speaker node, under `<file>/metadata/transcript/speakers/`. */
  speakerPath: string;
  /** Stable within the file: `speaker_0`, `speaker_1`, … by first appearance. */
  speaker: string;
  /** When it speaks, `[start, end]` in seconds, in time order. */
  turns: [number, number][];
  talkSeconds: number;
  personId?: string;
  personPath?: string;
  personName?: string;
  unnamed?: boolean;
  /** `auto` from recognition, `manual` when a person said so, `cluster` from a batch pass. */
  personSource?: string;
};

/** `face-add`: the face created on a picture by hand, and the person it went to. */
export type FaceAddResult = {
  personId: string;
  /** On a video: the second the box was drawn at. */
  atSeconds?: number;
  /** Set when the crop could not be cut; the face exists regardless. */
  cropError?: string;
};

/** `face-set-box`: a face's box moved by hand. */
export type FaceSetBoxResult = {
  /** Set when the crop could not be recut; the new box is saved regardless. */
  cropError?: string;
};

/** `album add`: which files became members, as links in the album or moved into it, and which already were. */
export type AlbumAddResult = {
  album: string;
  /** Each file linked, with the link that now files it in the album. */
  added: { path: string; link: string }[];
  /** Each staged file moved into the album, from where it was to where it now lives. */
  moved: { path: string; to: string }[];
  /** Files the album already held or linked; nothing was done for them. */
  already: string[];
  /** `--create` made the album. */
  created?: boolean;
  /** The staging journal entries that undo moving the staged files (`staging undo`), one per category they came from. */
  journal?: string[];
};

/** One album in `album-span`'s answer: the span it has (or, with `--dry-run`, would have) and its media's own. */
export type AlbumSpanRow = {
  path: string;
  /** The span: the media's, reaching out to `spanStart` / `spanEnd` where those lie beyond it. */
  timeStart?: string;
  timeEnd?: string;
  mediaCount: number;
  /** The first and last capture among the media, as wall clocks; what a hand-set end may not cut into. */
  mediaStart?: string;
  mediaEnd?: string;
  /** The days the span was set by hand to start and end on, kept while they lie beyond the media. */
  spanStart?: string;
  spanEnd?: string;
};

/**
 * `album-span`: how many albums were looked at and written, and a row for each written one — or,
 * with `--dry-run`, for each looked at, nothing written.
 */
export type AlbumSpanAnswer = { scanned: number; updated: number; skipped: number; albums: AlbumSpanRow[] };

/** One album or directory in an `album list` page: what its card shows without another read. */
export type AlbumListItem = {
  /** The directory name: the slug the path is built from, and the page's cursor. */
  name: string;
  /** `attrs.name`, or the directory name when it has none. */
  title: string;
  path: string;
  /** Whether its media lives in a `files/` directory under it. */
  hasFilesDir: boolean;
  origin?: string;
  modtime?: number;
  description?: string;
  labels?: string[];
  timeStart?: string;
  timeEnd?: string;
  /** The rest is a suggested album's summary (`autoAlbum`). */
  locationPath?: string;
  memberCount?: number;
  provisional?: boolean;
  pinned?: boolean;
  overall?: number;
  kind?: 'trip';
  days?: number;
  /** A suggested album's own (`origin` `auto`): what staging decides it by. */
  staging?: StagingRowInfo;
};

/**
 * `album list`: a page of the albums and directories under a root, in the store's name order.
 * `nextCursor` is the last name of the page while more follow, and null once none do.
 */
export type AlbumListResult = { items: AlbumListItem[]; nextCursor: string | null };

/** One album in `album info`: its `album list` row, and what only a read of the album gives. */
export type AlbumInfo = AlbumListItem & {
  id: string;
  /** Where its `coverPhoto` link points, or null without one. */
  coverPhoto: string | null;
  /** The album before it in a series (its `previous` link, `album set … previous`), or null without one. It may no longer exist. */
  previous: string | null;
  /** The album after it in a series (its `next` link), or null without one. It may no longer exist. */
  next: string | null;
  /** Its children: the members it holds or links, the cover link, its series links, and its profile. */
  count: number;
  /** A suggested album's parts and candidates, as the reader sees them. */
  suggested?: StagingGroupDetail;
};

/**
 * What matching knows of a library album (`attrs.albumProfile` of its `.profile` child, written by
 * `album-profile`): the hash of what it was built from (`signature`), when it was built and when a
 * build last found it current (`checkedAt`), the picture-vector type
 * its prototypes are in; how many members, how many dated, on how many days and over how long a
 * span; its capture instants (epoch minutes, sorted, at most 1,024, every active day kept while
 * there are at most 400), its members per day (wall clock, at most 400, the fullest), the days
 * whose count this build changed (at most 64); its members per 0.01° cell (at most 64), per linked
 * location (at most 16) and per person (at most 48), most first; and up to four member picture
 * vectors, by embedding node id, that stand for how it looks.
 */
export type AlbumProfile = {
  version: 1;
  signature: string;
  computedAt: string;
  checkedAt: string;
  pictureType?: string;
  members: number;
  dated: number;
  activeDays: number;
  spanDays: number;
  times: number[];
  days: [string, number][];
  changedDays: string[];
  cells: [string, number][];
  locations: [string, number][];
  people: [string, number][];
  prototypes: string[];
};

/**
 * `album-profile <album>… | --all [--stale] [--force]`: the library albums looked at, the profiles
 * written, those already current, the albums passed over (not a library album, or current enough
 * for `--stale`), and the albums that failed, by path.
 */
export type AlbumProfileResult = { ok: true; albums: number; written: number; unchanged: number; skipped: number; failed: string[]; durationMs: number };

/** `album info <path>…`: each album asked for, in the order asked, and the paths that name none. */
export type AlbumInfoAnswer = { albums: AlbumInfo[]; missing: string[] };

/** `album-stack front|separate|allow|stack|unstack`: the member the album should show next. */
export type AlbumStackMutation = {
  focusPath: string;
};

/** One dated original, as much of it as a thumbnail strip needs (`dayinhistory`, `latest`). */
export type DatedMedia = {
  path: string;
  /** The wall clock, which is what a caption should say. */
  takenAt?: string;
  takenAtUtc: string;
  mimetype?: string;
  width?: number;
  height?: number;
  angle?: number;
  /** Pixel aspect ratio of that raster; only an anamorphic video carries one. */
  sar?: number;
};

/** `dayinhistory`: one calendar day, in every year the archive has something on it. */
export type DayInHistory = {
  /** `MM-DD` the years below are all a slice of. */
  monthDay: string;
  /** Years that had something, newest first. */
  years: { year: number; items: DatedMedia[] }[];
};

/**
 * `file-set-time`: how many files were given their time, and for each the capture time it now
 * resolves to and where that comes from (both absent when it has none).
 */
export type FileSetTimeAnswer = { ok: true; updated: number; files: { path: string; takenAt?: string; source?: string }[] };

/** `media-resolve-time`: how many originals were re-dated, and from which source. */
export type MediaResolveTimeResult = {
  ok: true;
  dryRun: boolean;
  /** Originals read. */
  scanned: number;
  /** Those whose capture time changed, or would under `--dry-run`. */
  changed: number;
  /** Of the changed, those left with no capture time. */
  cleared: number;
  /** Already current, or with an exif record too old to say. */
  untouched: number;
  /** GPS fixes disbelieved as stale. */
  staleGps: number;
  /** Changed files by the source their time now comes from. */
  bySource: Record<string, number>;
};

/** A path in an `--against` scan, marked with which of the two roots holds it. */
export type DuplicatePathTag = { path: string; inScope: boolean; inAgainst: boolean };

/** One checksum shared by several files; `paths` are tagged under `--against`. */
export type ExactDuplicateGroup = {
  sha256: string;
  /** Bytes of one copy. */
  size: number;
  count: number;
  /** Bytes freed by keeping one copy. */
  reclaimable: number;
  paths: string[] | DuplicatePathTag[];
};

/** `duplicates [<subtree>]`: originals of any type that share a checksum, the most reclaimable first. */
export type ExactDuplicateScan = { mode: 'exact'; totalGroups: number; totalReclaimable: number; groups: ExactDuplicateGroup[] };

/** `duplicates <file>`: the other files with that file's checksum, renditions left out. */
export type ExactDuplicatesOf = { mode: 'exact'; path: string; sha256: string; count: number; duplicates: string[] };

/** `duplicates --fuzzy [<subtree>]`: files whose perceptual fingerprints lie close, clustered. */
export type FuzzyDuplicateScan = { mode: 'fuzzy'; totalClusters: number; clusters: { members: string[]; topSimilarity: number }[] };

/** `duplicates --fuzzy <file>`: the files closest to one, the most similar first. */
export type FuzzyDuplicatesOf = { mode: 'fuzzy'; path: string; count: number; duplicates: { path: string; similarity: number }[] };

/**
 * What `merge-duplicates` fills into the kept file from the dropped ones: its fields, the people
 * named in boxes (`faces`) and `people/` tags, the comments, the paired sidecar (`<file>/sidecar`),
 * and the drops' library albums.
 */
export type MergeField = 'description' | 'time' | 'place' | 'labels' | 'star' | 'sidecar' | 'faces' | 'people' | 'comments' | 'albums';

/** A point a sidecar names, in degrees. */
export type SidecarPoint = { lat: number; lng: number };

/**
 * What a Google Photos Takeout JSON says about its photo or video: the name it was uploaded under
 * (`title`), when it was taken (`takenAt`, `photoTakenTime`) and uploaded (`uploadedAt`,
 * `creationTime`), both UTC (`…Z`); where (`where`, Google's location, and `whereEdited` when a
 * person set one other than the file's own); the caption, the people named in it, whether it was a
 * favourite, archived or in Google's trash, and the phone folder it was uploaded from
 * (`localFolder`).
 */
export type TakeoutSidecar = {
  kind: 'takeout';
  title?: string;
  takenAt?: string;
  uploadedAt?: string;
  where?: SidecarPoint;
  whereEdited?: boolean;
  description?: string;
  people?: string[];
  favorited?: boolean;
  archived?: boolean;
  trashed?: boolean;
  localFolder?: string;
};

/** What a Takeout album folder's `metadata.json` says: the album's title, caption and date (UTC). */
export type TakeoutAlbumSidecar = { kind: 'takeout-album'; title: string; description?: string; date?: string };

/**
 * What an XMP sidecar says about its file: when it was taken as a wall clock at its own precision
 * (`wallClock`, from `photoshop:DateCreated` or `exif:DateTimeOriginal`), where, its title and
 * caption, its rating and colour label, and its keywords (`dc:subject`).
 */
export type XmpSidecar = {
  kind: 'xmp';
  wallClock?: string;
  where?: SidecarPoint;
  title?: string;
  description?: string;
  rating?: number;
  label?: string;
  keywords?: string[];
};

/**
 * `attrs.sidecar` on a paired sidecar, `<file>/sidecar` (its `sourceId` the file's id), or on a
 * Takeout album's `metadata.json` (its `sourceId` the folder's id): what it says, and when it was
 * paired.
 */
export type MediaSidecar = (TakeoutSidecar | TakeoutAlbumSidecar | XmpSidecar) & { pairedAt: string };

/**
 * `media-sidecars [<folder>]`: the unpaired sidecars found within the folder (`found`), and what
 * became of them: moved to `<file>/sidecar` (`paired`), shared by an edited copy or a Live Photo's
 * video through a softlink (`shared`), read as an album folder's title (`albums`), removed as a
 * second copy of a sidecar already paired (`duplicates`), not matched to any file (`unmatched`,
 * the first of them by path in `unmatchedPaths`), or not a sidecar at all (`other`). Then what the
 * pairing gave the files: a caption (`described`), a star for the inbox's owner (`starred`), a
 * capture time resolved again (`retimed`) and a position (`positioned`). `failed` names the
 * sidecars whose move was refused. With `dryRun`, what it would do.
 */
export type MediaSidecarsAnswer = {
  ok: boolean;
  path: string;
  dryRun: boolean;
  found: number;
  paired: number;
  shared: number;
  albums: number;
  duplicates: number;
  unmatched: number;
  unmatchedPaths: string[];
  other: number;
  described: number;
  starred: number;
  retimed: number;
  positioned: number;
  failed: { path: string; error: string }[];
};

/**
 * `merge-duplicates <keep> <drop>…`: what the kept file was filled in with, where it is now (a
 * staged one joining a library album is filed there), and the drops moved to the trash. `trash restore <batch>` undoes the drop; past 2,000 drops they fill several
 * batches, all in `batches`, `batch` being the first. With `dryRun`, what it would do.
 */
export type MergeDuplicatesResult = {
  ok: true;
  keep: string;
  merged: MergeField[];
  trashed: number;
  batch: string | null;
  batches: string[];
  dryRun: boolean;
};

/**
 * `exif-extract <file>`: when the metadata was read, and what was learned of the picture (`angle`
 * and `sar` only when not upright and square); or, for a staged exact copy left unindexed, that it
 * was deferred and the id of its original.
 */
export type ExifExtractAnswer =
  | { indexedAt: string; width?: number; height?: number; sar?: number; angle?: number; undecodable?: string }
  | { deferred: true; of: string };

/**
 * What a staged file's duplicate finding says it is: a byte copy of another file (`exact`), or
 * the same picture or recording in other bytes (`near`): a re-encode, a downscale, a crop.
 */
export type DuplicateKind = 'exact' | 'near';

/** Where the file a finding names lies: in the library (`/archive/albums`), or in the same inbox. */
export type DuplicateWhere = 'library' | 'inbox';

/**
 * How a near peer was found alike: by the pictures' SSCD fingerprints (`sscd`, `score` their
 * cosine), by a video's keyframes (`keyframes`, `score` the share of its keyframes another
 * video's match), or by the recordings' chromaprints (`chromaprint`, `score` how alike they are
 * aligned).
 */
type DuplicateMethod = 'sscd' | 'keyframes' | 'chromaprint';

/** A file a staged file looks like: its node id, how that was found, and how alike they are, 0–1. */
export type DuplicatePeer = { id: string; method: DuplicateMethod; score: number };

/**
 * `duplicate` on a staged media original, written whole by `@archive/staging/duplicates` and
 * nowhere else. Without `kind` it is a marker: the file was checked for these bytes in this inbox
 * and is no copy. A copy names its original by id (`of`): the smallest-id library twin the inbox's
 * owner can read, otherwise the smallest-id twin staged in the same inbox. A copy found when it
 * arrived is `deferred`: it is not indexed, and shows its original, for as long as it stays a copy.
 * An original that looks like other originals — in the library, or staged in the same inbox — is
 * `near`, its `peers` the strongest first, `where` the library when any of them is there. One that
 * looks like too many to be a copy of any (a dark frame, a test chart) is a `hub` and has none. A
 * discarded file keeps the trashed form, without `inbox`, `kind`, `where` and `peers`, so it is in
 * no inbox's findings.
 */
export type DuplicateFinding = {
  /** The owner of the inbox the file was checked in, while it is staged there. */
  inbox?: string;
  /** The bytes the finding was computed for. */
  sha256: string;
  /** When it was computed; ignored when two findings are compared. */
  at: string;
  kind?: DuplicateKind;
  where?: DuplicateWhere;
  /** The original's node id. */
  of?: string;
  /** A copy that is not indexed: no exif, no renditions, nothing derived from it. */
  deferred?: true;
  /** A near finding's look-alikes, at most 29. */
  peers?: DuplicatePeer[];
  /** No near check was kept: the picture looked like 30 files or more. */
  hub?: 'many';
};

/**
 * `duplicateDecision` on a staged file: the files a person said it is not a copy of
 * (`staging separate`), by node id. Written only by that command, and read by every near check,
 * which never pairs the two again.
 */
export type DuplicateDecision = { separate?: string[] };

/**
 * `staging separate <file> <other>…`: the pairs recorded as not duplicates (`--undo`: no longer
 * recorded so), each on both of its staged files, and the near findings decided again.
 */
export type DuplicateSeparateResult = { ok: true; pairs: number; undone: boolean };

/**
 * `duplicates --record <file|dir>…`: the findings recomputed for the files named and the files
 * within the directories named. `recorded` counts the files whose own finding, or a twin's, was
 * written; `unchanged` those where everything already held; `skipped` what has no finding to
 * have, and why.
 */
export type DuplicatesRecorded = { ok: true; recorded: number; unchanged: number; skipped: { path: string; reason: string }[] };

/**
 * `duplicates --checksum <sha256>…`: for each checksum, the media originals carrying it that the
 * caller can read in the library or in their own staging inbox, so an upload can be skipped.
 */
export type ChecksumMatches = { matches: { sha256: string; where: DuplicateWhere; path: string }[] };

/**
 * `staging duplicates --refresh`: the staged media whose finding is missing, from another inbox,
 * for other bytes, or older than the file's fingerprints (every one with `--force`), each
 * announced to `media-duplicates` once. At most `--limit` are announced per call; `cursor`
 * continues after the last file examined until `complete`. `withPrints` counts the media examined
 * that were fingerprinted, which a near check compares. With `dryRun`,
 * counted and not announced.
 */
export type DuplicateRefreshResult = {
  ok: true;
  examined: number;
  emitted: number;
  withPrints: number;
  complete: boolean;
  cursor: string | null;
  dryRun: boolean;
};

/**
 * `staging duplicates --repair`: the findings of each inbox checked against where their files are.
 * A file no longer staged in its inbox loses its finding (`cleared`), one in a trash gets the
 * trashed form (`trashed`), and a copy whose original is gone, unreadable or other bytes now is
 * recomputed (`recomputed`).
 */
export type DuplicateRepairResult = { ok: true; users: number; examined: number; cleared: number; trashed: number; recomputed: number };

/**
 * Why a duplicate set keeps the file it keeps over a file it drops: the kept one is in the
 * library (`library`), a person chose it (`chosen`, `staging dedupe --keep`), or, between staged
 * files, the first that tells them apart of: more pixels (`pixels`), a better format (`format`:
 * RAW, HEIC, TIFF or PNG, JPEG, WebP, GIF), a capture time from a better source (`capture`:
 * typed, GPS, the camera, a sidecar, the name), more bytes (`bytes`), a name without a copy's
 * suffix (`name`), and arriving first (`earliest`).
 */
export type DuplicateKeepRule = 'library' | 'chosen' | 'pixels' | 'format' | 'capture' | 'bytes' | 'name' | 'earliest';

/** Why `keep` is kept over `over`, both node ids; `detail` says it in numbers ("4032×3024 over 2048×1536"). */
export type DuplicateReason = { rule: DuplicateKeepRule; keep: string; over: string; detail?: string };

/**
 * `outside-scope`: some files the set would drop lie outside the folder read, so resolving it
 * there leaves them. `staged-larger`: a staged look-alike has more pixels than the library file
 * kept. `possible-burst`: two of its files are the same size, from the same camera, in the same
 * second — perhaps two shots of a burst rather than one picture twice.
 */
export type DuplicateFlag = 'outside-scope' | 'staged-larger' | 'possible-burst';

/**
 * Why a set cannot be resolved as it is: its kept file is gone or no longer the same bytes
 * (`keep-gone`), dropping the copies would fill in a kept file the caller cannot write
 * (`keep-not-writable`), or, when resolving, it no longer is what was asked for (`changed`).
 * `needs-review`: a set of look-alikes a person resolves one at a time, never `--apply`.
 */
export type DuplicateBlock = 'keep-gone' | 'keep-not-writable' | 'changed' | 'needs-review';

/**
 * One file of a duplicate set. `place` says whether it is in the library or staged; a staged one
 * is `inScope` when it lies in the folder read. Its picture is drawn from `previewPath`'s
 * renditions — its own, or a byte twin's when it has none — when `thumbnails` says they exist, else
 * from the file itself. `carries` is what dropping it would fill into the kept file (none for the
 * kept one); `album` the library album holding a library file.
 */
export type DuplicateMember = {
  id: string;
  path: string;
  name: string;
  mimetype?: string;
  width?: number;
  height?: number;
  duration?: number;
  takenAt?: string;
  size?: number;
  place: DuplicateWhere;
  inScope: boolean;
  previewPath: string;
  thumbnails: boolean;
  carries: MergeField[];
  album?: { path: string; name: string };
  /** In a set of look-alikes, how alike it is to the set's anchor (absent on the anchor). */
  score?: number;
  /** The camera it came from (`devicePath`), when known. */
  device?: string;
  /** Its staged byte copies, which go with it when it is dropped. */
  copies: { id: string; path: string }[];
};

/**
 * A duplicate set in a staging inbox. An exact set, keyed `exact:<the original's id>`, is
 * byte-identical files: the original — a library file (`where: 'library'`) or the first staged one
 * (`inbox`) — and its staged copies. A near set, keyed `near:<its anchor's id>`, is a staged
 * picture or video and the files it looks like, in the library when any is there; `score` is the
 * best likeness. `keep` is the file kept (by `reasons`, or as chosen) and `discard` the staged
 * files resolving it drops: those in the folder read, alike to the kept one, each with its byte
 * copies. `staged` lists the staged files, the kept one first when it is staged, and `existing`
 * the library ones. `carries` is what the kept file would gain from the dropped ones
 * (`merge-duplicates`' fill-only merge). `bulk` says `staging dedupe --apply` resolves it;
 * otherwise `blocked` says why not.
 */
export type DuplicateSet = {
  key: string;
  kind: DuplicateKind;
  where: DuplicateWhere;
  /** An exact set's bytes. */
  sha256?: string;
  score?: number;
  keep: string;
  discard: string[];
  staged: DuplicateMember[];
  existing: DuplicateMember[];
  reasons: DuplicateReason[];
  carries: MergeField[];
  reclaimableBytes: number;
  flags: DuplicateFlag[];
  bulk: boolean;
  blocked?: DuplicateBlock;
};

/**
 * `staging duplicates [<scope>] [--kind K] [--where W]`: one page of duplicate sets with a file to
 * drop in `scope` (a folder of the inbox, the whole inbox's `files/` by default), in four classes
 * in this order: copies of library photos, copies within the inbox, look-alikes of library photos,
 * look-alikes within the inbox; each set on the page of its first file in the scope. `cursor` goes
 * on where the page ended; null after the last. `staging duplicates <group>` answers every set of a
 * suggested group's members at once, with no cursor.
 */
export type DuplicatePage = { scope: string; sets: DuplicateSet[]; cursor: string | null };

/**
 * `staging duplicates [<scope>] --counts`: the staged copies in `scope` by where their original
 * lies (`exact`), the staged look-alikes by where what they look like lies (`near`), and all.
 */
export type DuplicateCounts = { scope: string; exact: Record<DuplicateWhere, number>; near: Record<DuplicateWhere, number>; total: number };

/**
 * `staging dedupe [<scope>] <key>…` and `staging dedupe [<scope>] --apply`: the sets resolved —
 * each kept file filled in from its copies (`merged`, by where the kept file is now) and the copies
 * discarded — as one journal entry (`journal`, which `staging undo` takes) and one trash batch;
 * the sets left alone, with why; and for `--apply`, where the next call goes on (`cursor`, while
 * `more`) and how many copies are left (`remaining`). With `dryRun`, what it would do.
 */
export type DuplicateResolveResult = {
  ok: true;
  dryRun: boolean;
  resolved: number;
  discarded: number;
  journal: string | null;
  batch: string | null;
  merged: { keep: string; fields: MergeField[] }[];
  skipped: { key: string; reason: DuplicateBlock }[];
  cursor: string | null;
  more: boolean;
  remaining: number | null;
};

/**
 * Per-signal similarity of a suggested album, each in [0,1]; `overall` is the weighted
 * combination. A run fills in only what it could compute.
 */
export type AlbumScores = {
  temporal?: number;
  location?: number;
  people?: number;
  visual?: number;
  semantic?: number;
  file?: number;
  camera?: number;
  overall?: number;
};

/** One subject a container's media have, and how many of them have it. */
export type SubjectTally = { path: string; name: string; count: number };

/**
 * `subjects-in <container>`: who and what the media a container shows have — the people in them,
 * the locations they are linked to, the devices that took them and who held the camera — each
 * counted and the most counted first, and how many of the media carry a position.
 */
export type ContainerSubjects = {
  /** The media counted: the members the container shows, a stack's front for the whole stack. */
  total: number;
  /** How many of them carry a position. */
  positioned: number;
  people: SubjectTally[];
  locations: SubjectTally[];
  devices: SubjectTally[];
  photographers: SubjectTally[];
  /** The container holds more than its listing reached; the counts are over what it did. */
  truncated: boolean;
};
