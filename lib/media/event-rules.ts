/**
 * VFS mutation -> media domain fact.
 *
 * The single place that decides what counts as a fact worth acting on. A fact is
 * a projection of VFS state, never a record of "a step finished", which is what
 * lets the same rules serve both the live bridge and the reconciler: replaying
 * them over an existing tree produces exactly the events that would have fired
 * had nothing been missed.
 *
 * Rules read the node fresh rather than trusting event payloads, so they are
 * safe to re-run and correct under at-least-once delivery. The one exception is a
 * removal, read off the attrs the deleted event carries because nothing is left
 * to read. Emitting a fact twice
 * is harmless — the pipeline's `skipIf` and one-instance-per-node absorb it.
 */

import { CHUNK_TARGET_SECONDS } from '@archive/media/transcript';
import { FINGERPRINT_TYPES, fingerprintDone } from '@archive/media/fingerprints';
import type { DomainEvent } from '@ein/client';
import { isTrashPath, TEMP_PATH } from '@ein/paths';
import { deferredCopy } from '@archive/staging/deferral';
import { authoredHash, textEmbeddingType } from '@ems/text-embedding';

const MEDIA_EVENT_SOURCE = 'archive-bridge';

/** Facts the bridge produces. */
export const MEDIA_EVENTS = {
  /** A media file with bytes and no EXIF yet — the entry point to indexing. */
  fileDiscovered: 'media.file.discovered',
  /** An already-indexed file whose bytes changed; everything derived is stale. */
  fileContentChanged: 'media.file.content-changed',
  /**
   * A media file is gone: its last name was unlinked. Read off the attrs the deleted event
   * carries, since the node no longer exists to be read, so `data` is what the file was.
   */
  fileRemoved: 'media.file.removed',
  /**
   * An indexed video was turned or flipped by hand (`angleManual` or `mirror` changed). Its
   * transcoded renditions are encoded at the old orientation and have to be re-encoded.
   */
  fileTurned: 'media.file.turned',
  /**
   * A person set or cleared the language of a read picture's text (`ocrLanguageManual`,
   * `file-set-text-language`). The picture is read again in it: the language picks the transcriber
   * for its handwriting.
   */
  textLanguageSet: 'media.text.language-set',
  /** `<file>/metadata/exif` is populated. Unlocks most of the pipeline fan-out. */
  metadataExtracted: 'media.metadata.extracted',
  /** `<file>/position` exists. Subject is the position node. */
  positionAvailable: 'media.position.available',
  /** A fingerprint landed under `<file>/metadata/`. */
  fingerprintComputed: 'media.fingerprint.computed',
  /** One face. Subject is the face node, so assignment is a per-face unit. */
  faceDetected: 'media.face.detected',
  /** Face detection has finished for an image, including a zero-face result. */
  facesCompleted: 'media.faces.completed',
  /**
   * A recording's voices are written (`speakersAt` on the file). Subject is the file: who each
   * voice is gets decided once per recording, not once per turn.
   */
  speakersDetected: 'media.speakers.detected',
  /**
   * A recording with speech in its transcript has no voices: never voiceprinted. The reconciler's
   * gap.
   */
  speakersMissing: 'media.speakers.missing',
  /**
   * A video's or a recording's transcript is written: `<file>/metadata/transcript` gained its
   * `transcribedAt`. Subject is the file; `data.speech` says whether anything was said.
   */
  transcriptGenerated: 'media.transcript.generated',
  /**
   * A transcript exists but was decoded with other whisper settings than EMS runs now, or an
   * interrupted run left it without `transcribedAt`. Its own fact because the transcribe
   * pipeline's ordinary trigger skips every file that has the node — exactly the set this fact is
   * about.
   */
  transcriptStale: 'media.transcript.stale',
  /**
   * A photo or video has no picture vectors (`<file>/metadata/picture`), or has them from an
   * image embedder EMS no longer runs. Its own fact because the embed pipeline's ordinary
   * trigger skips every file that already has the directory.
   */
  pictureStale: 'media.picture.stale',
  /**
   * A picture's text was read by another engine than EMS reads with now (`ocrBy`). Its own fact
   * because `media-ocr`'s ordinary triggers skip every picture already read.
   */
  ocrStale: 'media.ocr.stale',
  /**
   * A file's texts lack a vector from the text embedder EMS runs now: extracted text, a
   * transcript or a hand-written description with no vector, or one from another model (a
   * transcript also when its chunks were cut at another length). `data.stale` names which. The
   * repair embeds the stored text again and never re-runs what wrote it.
   */
  textEmbeddingStale: 'media.text-embedding.stale',
  /**
   * A document or picture `document-index` reads has never had its text extracted: no
   * `textIndexedAt`. The bridge announces it for each such file in a directory that was moved,
   * since the move publishes an event for the directory only; the reconciler announces it for a
   * file whose write or move came while nothing was listening. `document-index` excludes the
   * same paths for it as for the write.
   */
  textMissing: 'media.text.missing',
  /**
   * The set of media an album holds, or what is known about a member's location in it, changed.
   * Subject is the **album** node — the one fact here whose subject is an aggregate rather than
   * a file. A member attached or detached, a member's capture time arriving or moving, a
   * member's fingerprint landing: all of them make the album's stacks and denormalised span
   * answers about a member set the album no longer has, and the pipeline behind this fact
   * recomputes both. It is deliberately over-eager (a cover link counts as an attachment) —
   * both commands no-op on an unchanged input signature, so a spurious fact costs one listing.
   */
  albumMembersChanged: 'media.album.members-changed',
  /**
   * A media file's duplicate findings may be wrong: a staged file arrived in its inbox from
   * elsewhere, or a library file arrived that staged files may copy. Subject is the file, or a
   * directory that moved in whole, whose files `duplicates --record` then takes one by one.
   * Derived by `@archive/staging/facts`.
   */
  duplicatesStale: 'media.duplicates.stale',
} as const;

/**
 * VFS routing keys the bridge must bind to see every mutation these rules care
 * about. Deliberately narrow — this is what keeps the bridge off the firehose.
 */
export const MEDIA_BRIDGE_ROUTING_KEYS = [
  'system.vfs.file.created',
  'system.vfs.file.updated',
  // No busier than `file.created`: every file deleted was once created.
  'system.vfs.file.deleted',
  'system.vfs.exif.created',
  'system.vfs.exif.updated',
  'system.vfs.position.created',
  'system.vfs.embedding.created',
  // Album membership. `child-attached` / `child-detached` carry the parent, so an album's own
  // level is exactly these two keys and nothing else on the system publishes on them.
  'system.vfs.album.child-attached',
  'system.vfs.album.child-detached',
  // An imported album keeps its media in a lone `files/` directory, and that is a plain
  // `directory`. Its detach key is bound — the name test on the path is free, and the churn
  // behind it (pipeline instances being pruned, derivatives being cleared) is bounded and
  // periodic. Its attach key is deliberately NOT bound: `directory.child-attached` fires for
  // every thumbnail, every metadata child and every pipeline instance node of every file the
  // crawl touches, which is the firehose the narrow list exists to stay off. Attachment into
  // `files/` is seen from the child's side instead: `file.created` (already bound) and
  // `file.moved`. What that misses is a hard link into `files/` (`ln`, no `created`), which is
  // left to the reconciling sweep.
  'system.vfs.directory.child-detached',
  'system.vfs.file.moved',
  // A directory moved whole publishes this event for the directory alone, none for the files in it.
  'system.vfs.directory.moved',
];

/** The lone media child of an imported album; membership there is membership of the album. */
const FILES_DIR_NAME = 'files';
/** Attrs whose change moves a member's location in an album's span and stacks. */
const CAPTURE_TIME_ATTRS = ['takenAt', 'takenAtUtc'];
/**
 * Attrs only a hand-set orientation writes (`file-set-orientation`, the legacy import). Not the
 * plain `angle`: `exif-extract` writes that on every index, and the rendition the index queues
 * is encoded at it already.
 */
const MANUAL_ORIENTATION_ATTRS = ['angleManual', 'mirror'];

const MEDIA_MIMETYPE = /^(image|video|audio)\//;
/** Only images get a face-detection marker, so only images can be missing one. */
const IMAGE_MIMETYPE = /^image\//;
/** What `detect-faces` detects on: photos, and videos through their frames. */
const FACES_MIMETYPE = /^(image|video)\//;
/** What `embed-picture` takes: a photo, or a video's keyframes. */
const PICTURE_MIMETYPE = /^(image|video)\//;
/**
 * What gets extracted text: the documents `document-index` reads (its trigger's `filter` says the
 * same, and `document-index.test.ts` holds the two together) and every picture, which `media-ocr`
 * reads — a camera RAW through its preview.
 */
export const isTextIndexedMimetype = (mimetype: string): boolean =>
  /^image\//.test(mimetype) || [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
  ].includes(mimetype);

/**
 * What `media-transcode` leaves behind, per media type: the extension of a transcoded
 * rendition and how many of them that type gets. Video gets the 1080p rendition the lightbox
 * plays and the muted hover clip a grid tile plays; audio gets the one normalised track.
 *
 * Counted by extension rather than looked up by name because the names are the target boxes
 * out of `config/sizes.yaml` (`1920x1080.mp4`, `480x480.mp4`, `128k-44100.m4a`), so changing a
 * size would otherwise turn every video in the archive into a permanent gap. The table still
 * has to move with `TARGETS` in `bin/generate-derivatives` when a rendition is added or
 * dropped, and that table says so.
 */
const TRANSCODE_RENDITIONS: Record<string, { ext: string; count: number }> = {
  video: { ext: '.mp4', count: 2 },
  audio: { ext: '.m4a', count: 1 },
};

/**
 * Under this many seconds a video gets no hover clip at all: `generate-derivatives` skips it
 * because the poster frame already is the whole video. Expecting one anyway would report a gap
 * no amount of transcoding can close, and `media-scan` would republish that file on every run
 * forever — the redundancy the whole command is built to avoid.
 */
const MIN_PREVIEW_SECONDS = 2;

/**
 * File-node attr recording renditions EMS *refused* on its CPU-decode budget, as distinct from
 * ones it failed at or never reached.
 *
 * Written by `generate-derivatives` (and cleared per rendition the moment one is made), read
 * here so `lacksTranscode` stops counting a rendition nothing on this box is going to produce.
 * The same shape as `undecodable` and for the same reason — a gap no re-announcement can close
 * has to be recorded on the file node, because that is what the reconciler reads — but keyed
 * per rendition rather than per file: a source can be over budget for the full 1080p rendition
 * and comfortably inside it for the 20-second hover clip, and that is the common case, not the
 * corner one.
 */
export const TRANSCODE_REFUSED_ATTR = 'transcodeRefused';

/**
 * One refusal, keyed in `TRANSCODE_REFUSED_ATTR` by the rendition's file name (`1920x1080.mp4`),
 * which is what `lacksTranscode` counts.
 */
export type TranscodeRefusal = {
  /** The message EMS refused with, for a human reading `attrs`. */
  reason: string;
  /**
   * The signature of the CPU-decode budget the refusal was computed against —
   * `capabilities.encode.cpu_budget` as EMS reported it at the time (its
   * `<max MB>/<MB per 1k frames>/<max windows>`), read through `transcodeBudget()`.
   *
   * This is what makes the marker clearable without anyone having to remember to clear it. The
   * refusal is a function of EMS's memory budget and not of the source, so raising the budget
   * must re-open the gap — and it does, because the signature stored here no longer matches
   * the one the scan reads from EMS, and the exclusion below stops applying. The whole
   * signature, not just the megabytes: a source can be refused for needing too many windows at
   * an unchanged budget. Opaque here on purpose: both the writer and the reader take it from
   * EMS, so they cannot derive it differently.
   */
  budget: string;
  /** When the refusal was recorded, epoch ms. */
  at: number;
};

/** The refusals recorded on a file node, tolerant of an attr written by an older shape. */
const refusalsOf = (file: NodeSnapshot): Record<string, TranscodeRefusal> => {
  const raw = file.attrs[TRANSCODE_REFUSED_ATTR];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, TranscodeRefusal>;
};

export type NodeSnapshot = {
  id: string;
  type: string;
  attrs: Record<string, unknown>;
  /** Last modification time, epoch ms. */
  modtime?: number;
};

/** Everything a rule needs from the VFS, so the rules stay testable in isolation. */
export type RuleContext = {
  getNode(path: string): Promise<NodeSnapshot | undefined>;
  exists(path: string): Promise<boolean>;
  /** Child names of a directory, empty when it does not exist. Reconciler only. */
  childNames?(path: string): Promise<string[]>;
  /**
   * Paths of every directory holding the file at `filePath` — by hard link (every path the id
   * resolves to) and by softlink (every link whose target is the file). The album fact needs
   * the containers a member sits in, and a file's own path names only one of them. Bridge
   * only: the reconciler's album pass is the sweep, not a replay of these facts.
   */
  containersOf?(filePath: string, nodeId: string): Promise<string[]>;
  /**
   * Every file within the directory at `path` (`NodeQuery.within`) that has no `textIndexedAt`,
   * with its absolute path. Bridge only: what a directory moved whole brings along.
   */
  unreadFilesWithin?(path: string): Promise<{ path: string; node: NodeSnapshot }[]>;
  /**
   * Whether a sidecar not yet paired with its file (`@archive/media/sidecars`) lies within the
   * folder at `path`. Bridge only: a media file landing beside one is what it may pair with.
   */
  unpairedSidecarsIn?(path: string): Promise<boolean>;
  /**
   * The `transcribedWith` value a transcript decoded right now would carry — every whisper
   * setting that decides the output, as EMS reports it. A transcript stamped with anything else
   * was made with other settings, and the file is transcribed again, its chunk vectors with it.
   *
   * Undefined disables the check, and it is undefined whenever the inference server cannot be
   * asked: the value has to come from the side that decodes, or a stale literal here would mark
   * every transcript stale forever and re-transcribing would write the same value back.
   */
  transcriptGeneration?: string;
  /**
   * The image embedder EMS runs now (`imageEmbedGeneration()` in `@ems/client`). A photo or video
   * whose `metadata/picture` carries another `embeddedBy`, or none, is re-embedded: vectors from
   * two models are not comparable and must not be searched side by side.
   *
   * Derived from EMS, never configured: a literal that disagreed with what `embed-picture` writes
   * would mark every file stale forever, and re-embedding would write the same value back.
   * Re-embedding the archive is cheap, so there is no `off`. Undefined when EMS cannot be asked,
   * which disables the check.
   */
  pictureGeneration?: string;
  /**
   * The engine EMS reads pictures' text with now (`ocrGeneration()` in `@ems/client`). A picture
   * whose `ocrBy` names another engine is read again. One with no `ocrBy` was read by Tesseract and
   * keeps that reading until a reset or import reads it anew (user, 2026-10-18: no archive-wide
   * re-read). Derived from EMS like `pictureGeneration`, and undefined when EMS cannot be asked,
   * which disables the check.
   */
  ocrGeneration?: string;
  /**
   * The text embedder EMS runs now (`textEmbedGeneration()` in `@ems/client`). A text under a
   * file's `metadata/` whose vector carries another `embeddedBy`, or has none, is embedded again
   * from the stored text. Derived from EMS like `pictureGeneration`, with no `off`, and undefined
   * when EMS cannot be asked or runs a model nothing has given a type to, which disables the check.
   */
  textGeneration?: string;
  /**
   * The CPU-decode budget EMS is running under, as `TranscodeRefusal.budget` stores it
   * (`transcodeBudget()` in `@ems/client`).
   *
   * A refusal recorded against a different signature is stale: the operator changed the budget,
   * so the rendition deserves another attempt and the gap re-opens on its own. **Undefined
   * means no refusal is trusted** — the conservative direction, since it can only cause a
   * re-announcement, never suppress one — and it is undefined whenever EMS cannot be asked.
   */
  cpuEncodeBudget?: string;
};

/** The slim VFS event as published on `system.vfs.<nodeType>.<eventType>`. */
export type VfsEventInput = {
  type: string;
  path: string;
  nodeId: string;
  nodeType: string;
  timestamp: number;
  /** Attr names an `updated` event changed. Absent on other event types and on older publishers. */
  changedAttrs?: string[];
  /** The node's attrs as they were, on a `deleted` event only. */
  attrs?: Record<string, unknown>;
  /** Where the node was before, on a `moved` event only. */
  fromPath?: string;
  /** Who made the write. */
  uid?: number;
  /** The audit record the write left, when the trail kept one. */
  auditId?: string;
};

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

/**
 * True if `node` is a file the media pipelines should index at all. Exported so a count of
 * "still indexing" can leave out what will never be indexed — a text file, an empty file.
 */
export const isIndexableMedia = (node: NodeSnapshot): boolean => {
  if (node.type !== 'file') return false;
  // Derivatives (thumbnails, transcodes, face crops) carry the id of what they
  // were made from. Indexing them would make the pipelines recurse on their own
  // output — this one check replaces a `skipIf` in every media pipeline.
  if (node.attrs.sourceId) return false;
  if (!MEDIA_MIMETYPE.test(str(node.attrs.mimetype) ?? '')) return false;
  // No bytes yet: the node exists but the upload has not landed.
  return (num(node.attrs.size) ?? 0) > 0;
};

/** How many transcoded renditions this file should have; `undefined` for a type that gets none. */
const expectedTranscodes = (file: NodeSnapshot): { ext: string; count: number } | undefined => {
  const mediaType = (str(file.attrs.mimetype) ?? '').split('/')[0];
  const expected = TRANSCODE_RENDITIONS[mediaType];

  if (!expected) return undefined;

  // `duration` may be absent; `generate-derivatives` falls through and makes the clip in that
  // case, so expect it here too.
  const duration = num(file.attrs.duration);
  const tooShortToPreview = mediaType === 'video' && duration !== undefined && duration > 0 && duration < MIN_PREVIEW_SECONDS;

  return tooShortToPreview ? { ...expected, count: 1 } : expected;
};

/**
 * True when a video or audio file is short of the renditions `media-transcode` writes.
 *
 * They land under `thumbnails/` alongside the poster frames, so the derivatives term cannot see
 * them: a video that got its still frames and no transcode has a `thumbnails/` directory and
 * reads as complete. Hence the separate listing — which is why the caller reaches for this last,
 * once every cheaper term has come back clean, since any of them re-opens the same fan-out.
 *
 * `generate-derivatives` counts a rendition as present only when it has bytes, which a listing
 * cannot see, so this under-detects a zero-byte rendition left by a failed encode. That is the
 * safe direction: `regenerate` is what repairs those, and over-detecting here would republish
 * files this fact cannot fix.
 */
const lacksTranscode = async (filePath: string, file: NodeSnapshot, ctx: RuleContext): Promise<boolean> => {
  const expected = expectedTranscodes(file);

  if (!expected) return false;

  const names = (await ctx.childNames?.(`${filePath}/thumbnails`)) ?? [];
  const present = names.filter((name) => name.endsWith(expected.ext)).length;

  // Renditions this box refused to make count as accounted for, not as gaps. Only those whose
  // recorded budget matches the one in force: a raised budget makes the refusal stale, the
  // count drops back, and the file is announced again — which is the whole point of storing the
  // signature rather than a bare flag.
  //
  // Counted against the same extension the presence check uses, and only for names that are not
  // already present, so a refusal left behind by a rendition that has since been made by hand
  // cannot push the total past what exists.
  const refused = ctx.cpuEncodeBudget === undefined ? 0 : Object.entries(refusalsOf(file))
    .filter(([name, refusal]) => name.endsWith(expected.ext) && refusal?.budget === ctx.cpuEncodeBudget && !names.includes(name)).length;

  return present + refused < expected.count;
};

/**
 * Facts derivable from a file node, independent of which event revealed it.
 *
 * `node` lets a caller that already holds the snapshot skip the re-read — the
 * reconciler walks with `children()`, which returns every child in full, so
 * re-fetching each one is pure overhead.
 */
export async function deriveForFile(
  filePath: string,
  ctx: RuleContext,
  now: number,
  node?: NodeSnapshot,
): Promise<Omit<DomainEvent, 'id'>[]> {
  // Nothing in a trash is indexed: a trashed file waits there to be restored or purged.
  if (isTrashPath(filePath)) return [];

  const file = node ?? await ctx.getNode(filePath);

  if (!file || !isIndexableMedia(file)) return [];

  const exif = await ctx.getNode(`${filePath}/metadata/exif`);
  const base = {
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
  };
  const data = {
    mimetype: str(file.attrs.mimetype) ?? '',
    size: num(file.attrs.size) ?? 0,
    sha256: str(file.attrs.sha256) ?? '',
  };

  if (!exif) {
    // A staged exact copy is not indexed while it is one: its original stands in for it.
    if (deferredCopy(filePath, file.attrs)) return [];
    return [{ ...base, type: MEDIA_EVENTS.fileDiscovered, data }];
  }

  // Already indexed. The only thing left to say about it is whether the bytes
  // moved out from under that index — compared by content hash rather than
  // timestamps, because the pipeline's own writes bump the file's modtime.
  const indexedSha = str(exif.attrs.sourceSha256);
  const currentSha = str(file.attrs.sha256);

  if (indexedSha && currentSha && indexedSha !== currentSha) {
    return [{
      ...base,
      type: MEDIA_EVENTS.fileContentChanged,
      data: { ...data, previousSha256: indexedSha },
    }];
  }

  return [];
}

/**
 * The fact `voiceprint-file` announces by writing `speakersAt` on the file, which it does last.
 * Only on the write that changed it, so every later attr write to the file stays quiet.
 */
function deriveSpeakersDetected(event: VfsEventInput, file: NodeSnapshot, now: number): Omit<DomainEvent, 'id'>[] {
  const speakersAt = str(file.attrs.speakersAt);
  if (!speakersAt || event.type !== 'updated' || !(event.changedAttrs ?? []).includes('speakersAt')) return [];
  return [{
    type: MEDIA_EVENTS.speakersDetected,
    subject: event.path,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: { mimetype: str(file.attrs.mimetype) ?? '', speakersAt, speakerCount: num(file.attrs.speakerCount) ?? 0 },
  }];
}

/**
 * The fact a hand-set turn of an indexed video reveals. Only on the write that changed the
 * orientation, and only once the file is indexed: before that, the transcode the index queues
 * reads the new orientation anyway.
 */
async function deriveFileTurned(event: VfsEventInput, file: NodeSnapshot, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  if (event.type !== 'updated' || !(event.changedAttrs ?? []).some((name) => MANUAL_ORIENTATION_ATTRS.includes(name))) return [];
  const mimetype = str(file.attrs.mimetype) ?? '';
  if (!isIndexableMedia(file) || !mimetype.startsWith('video/')) return [];
  if (!await ctx.exists(`${event.path}/metadata/exif`)) return [];
  return [{
    type: MEDIA_EVENTS.fileTurned,
    subject: event.path,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: { mimetype, angle: num(file.attrs.angle) ?? 0, mirror: file.attrs.mirror === true },
  }];
}

/**
 * The fact a hand-set text language of a read picture reveals. Only on the write that changed it,
 * and only once the picture was read: before that, the reading it is queued for asks in it anyway.
 */
function deriveTextLanguageSet(event: VfsEventInput, file: NodeSnapshot, now: number): Omit<DomainEvent, 'id'>[] {
  if (event.type !== 'updated' || !(event.changedAttrs ?? []).includes('ocrLanguageManual')) return [];
  const mimetype = str(file.attrs.mimetype) ?? '';
  if (!IMAGE_MIMETYPE.test(mimetype) || !str(file.attrs.textIndexedAt)) return [];
  return [{
    type: MEDIA_EVENTS.textLanguageSet,
    subject: event.path,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: { mimetype, language: str(file.attrs.ocrLanguageManual) ?? null },
  }];
}

/** The fact revealed by detect-faces' final update of the source file. */
function deriveFacesCompleted(
  filePath: string,
  file: NodeSnapshot,
  now: number,
): Omit<DomainEvent, 'id'>[] {
  const mimetype = str(file.attrs.mimetype) ?? '';
  const facesAt = str(file.attrs.facesAt);

  if (!isIndexableMedia(file) || !IMAGE_MIMETYPE.test(mimetype) || !facesAt) return [];

  return [{
    type: MEDIA_EVENTS.facesCompleted,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype,
      facesAt,
      faceCount: num(file.attrs.faceCount) ?? 0,
    },
  }];
}

/** The text nodes under a file's `metadata/` that `media-reembed` embeds, by name. */
const TEXT_NODE_NAMES = ['content', 'transcript'] as const;

/**
 * Which of a file's texts have no current vector from `generation`, as `media-reembed` decides
 * it: the vector beside the text, named for the model's type, has to carry `embeddedBy` equal to
 * it; a transcript's chunk set also has to be cut at CHUNK_TARGET_SECONDS, and a hand-written
 * description's vector has to carry the hash of the text as it is now.
 *
 * A text that gives `media-reembed` nothing to embed is never stale, or the file would be
 * announced on every scan: an empty text node, and a transcript that heard no speech, which
 * keeps no chunk set. A content vector made from the opening of a long text, which
 * `media-reembed` redoes in parts, is not asked about: telling it apart takes the text itself.
 */
async function staleTexts(
  filePath: string,
  file: NodeSnapshot,
  metadataChildren: string[],
  generation: string,
  ctx: RuleContext,
): Promise<string[]> {
  const type = textEmbeddingType(generation);
  if (!type) return [];

  const stale: string[] = [];
  for (const name of TEXT_NODE_NAMES) {
    if (!metadataChildren.includes(name)) continue;
    const vector = await ctx.getNode(`${filePath}/metadata/${name}/${type}`);
    if (vector?.attrs.embeddedBy === generation && (name !== 'transcript' || vector.attrs.chunkSeconds === CHUNK_TARGET_SECONDS)) continue;
    const text = await ctx.getNode(`${filePath}/metadata/${name}`);
    if (!text || num(text.attrs.size) === 0 || (name === 'transcript' && text.attrs.speech === false)) continue;
    stale.push(name);
  }

  const authored = str(file.attrs.description)?.trim();
  if (authored) {
    const vector = metadataChildren.includes('authored') ? await ctx.getNode(`${filePath}/metadata/authored/${type}`) : undefined;
    if (vector?.attrs.embeddedBy !== generation || vector.attrs.authoredHash !== await authoredHash(authored)) stale.push('authored');
  }
  return stale;
}

/**
 * Facts for a file the bridge may have missed *after* indexing started — it has
 * EXIF, but some later stage never ran (the bridge was down, or the stage did
 * not exist yet when the file was indexed).
 *
 * Re-emitting `media.metadata.extracted` restarts the whole fan-out; every
 * pipeline hanging off it has its own `skipIf`, so the stages already done skip
 * at trigger time without creating an instance. Reconciler only — the bridge
 * derives this from the exif node's own event.
 */
export async function deriveGaps(
  filePath: string,
  ctx: RuleContext,
  now: number,
  node?: NodeSnapshot,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const file = node ?? await ctx.getNode(filePath);

  if (!file || !isIndexableMedia(file)) return [];

  const exif = await ctx.getNode(`${filePath}/metadata/exif`);

  // Not indexed at all, or indexed against different bytes — that is discovery's
  // job, not a gap.
  if (!exif?.attrs.indexedAt) return [];

  const metadataChildren = (await ctx.childNames?.(`${filePath}/metadata`)) ?? [];
  const missingFingerprint = !fingerprintDone(str(file.attrs.mimetype) ?? '', file.attrs.fingerprintedAt, metadataChildren);
  // Every audio and video file gets a transcript node, a silent one an empty cue list.
  const missingTranscript = !metadataChildren.includes('transcript');
  const missingDerivatives = !(await ctx.exists(`${filePath}/thumbnails`));
  // `detect-faces` writes `facesAt` in both of its exit paths, including on a photo with nobody
  // in it, so its absence means the step never ran — which a `regions/` directory would not say,
  // since the legacy importer writes one at import time. Photos and videos only: nothing else
  // ever gets the marker, so a recording would otherwise read as a gap on every scan forever.
  const missingFaces = FACES_MIMETYPE.test(str(file.attrs.mimetype) ?? '') && !str(file.attrs.facesAt);

  const events: Omit<DomainEvent, 'id'>[] = [];

  // One re-emit re-opens the whole fan-out and each pipeline's own `skipIf` drops the stages
  // already done, so this predicate wants a term per pipeline hanging off the fact. A stage it
  // does not ask about is a stage nothing ever re-announces — and a guard like
  // `skipIfAttr: facesAt` cannot rescue a pipeline nobody announces, it only skips one that is.
  // That is a one-way door: an image with a fingerprint and thumbnails but no `facesAt` reads as
  // complete to the fingerprint and derivative terms alone (ein/core#140).
  //
  // `media-device` deliberately has no term and must not get one: `device-link` writes nothing
  // when the registry holds no match, so "no `devicePath`" cannot tell a link that never ran
  // from one that ran and found nothing. Most files in an archive come from cameras nobody has
  // registered, so a term here would republish most of the corpus on every scan and starve the
  // real gaps. That pipeline is swept from the other side instead, where the registry is what
  // changed and an indexed equality answers it: `device-relink <device>`, or `--all` over the
  // whole registry.
  //
  // A source nothing can decode is excluded: `exif-extract` records why on the file node and
  // every step downstream skips on it, so re-announcing republishes the same file on every scan
  // without ever closing the gap.
  const undecodable = Boolean(str(file.attrs.undecodable));
  const isImage = IMAGE_MIMETYPE.test(str(file.attrs.mimetype) ?? '');
  const incomplete = missingFingerprint || missingDerivatives || missingFaces || (!isImage && missingTranscript);

  // `lacksTranscode` is last because it is the only term that costs a read of its own, and it is
  // asked only of a decodable file nothing else has already re-announced.
  if (!undecodable && (incomplete || await lacksTranscode(filePath, file, ctx))) {
    events.push(...await deriveForExif(`${filePath}/metadata/exif`, ctx, now));
  }

  // A transcript an interrupted run left without `transcribedAt`, or one decoded with other
  // whisper settings than EMS runs now. Only a transcript that names a model is compared with the
  // settings: one with `transcribedBy` null was written for a file with no audio track, and
  // transcribing it again would write the same nulls back on every scan.
  const transcript = !isImage && !missingTranscript && !undecodable ? await ctx.getNode(`${filePath}/metadata/transcript`) : undefined;

  if (transcript) {
    const transcribedWith = str(transcript.attrs.transcribedWith);
    const unfinished = !str(transcript.attrs.transcribedAt);
    const superseded = ctx.transcriptGeneration !== undefined && str(transcript.attrs.transcribedBy) !== undefined &&
      transcribedWith !== ctx.transcriptGeneration;

    if (unfinished || superseded) {
      events.push({
        type: MEDIA_EVENTS.transcriptStale,
        subject: filePath,
        nodeId: file.id,
        time: now,
        source: MEDIA_EVENT_SOURCE,
        data: {
          mimetype: str(file.attrs.mimetype) ?? '',
          transcribedWith: transcribedWith ?? '',
          ...(ctx.transcriptGeneration ? { expectedTranscribedWith: ctx.transcriptGeneration } : {}),
        },
      });
    }
  }

  // Voices: a recording whose transcript heard speech and that has no speakers.
  if (transcript?.attrs.speech === true && !str(file.attrs.speakersAt)) {
    events.push({
      type: MEDIA_EVENTS.speakersMissing,
      subject: filePath,
      nodeId: file.id,
      time: now,
      source: MEDIA_EVENT_SOURCE,
      data: { mimetype: str(file.attrs.mimetype) ?? '' },
    });
  }

  // Picture vectors: missing, half-written (no `embeddedBy`, which is written last) or from another
  // embedder. One read, and only for a file that has the directory at all.
  const mimetype = str(file.attrs.mimetype) ?? '';
  if (ctx.pictureGeneration && !undecodable && PICTURE_MIMETYPE.test(mimetype)) {
    const picture = metadataChildren.includes('picture') ? await ctx.getNode(`${filePath}/metadata/picture`) : undefined;
    const embeddedBy = picture && str(picture.attrs.embeddedBy);

    if (embeddedBy !== ctx.pictureGeneration) {
      events.push({
        type: MEDIA_EVENTS.pictureStale,
        subject: filePath,
        nodeId: file.id,
        time: now,
        source: MEDIA_EVENT_SOURCE,
        data: { mimetype, embeddedBy: embeddedBy ?? '', expected: ctx.pictureGeneration },
      });
    }
  }

  // Text in a picture read by another engine. A picture never read is `media.text.missing`'s, and
  // one without `ocrBy` keeps Tesseract's reading (`ocrGeneration`).
  const ocrBy = str(file.attrs.ocrBy);
  if (ctx.ocrGeneration && !undecodable && isImage && ocrBy && ocrBy !== ctx.ocrGeneration) {
    events.push({
      type: MEDIA_EVENTS.ocrStale,
      subject: filePath,
      nodeId: file.id,
      time: now,
      source: MEDIA_EVENT_SOURCE,
      data: { mimetype, ocrBy, expected: ctx.ocrGeneration },
    });
  }

  // Text vectors, after the facts above: a new transcript embeds its chunks again, so a file
  // already announced as `transcriptStale` waits for the next scan for the rest.
  if (ctx.textGeneration && !events.some((event) => event.type === MEDIA_EVENTS.transcriptStale)) {
    const stale = await staleTexts(filePath, file, metadataChildren, ctx.textGeneration, ctx);
    if (stale.length > 0) {
      events.push({
        type: MEDIA_EVENTS.textEmbeddingStale,
        subject: filePath,
        nodeId: file.id,
        time: now,
        source: MEDIA_EVENT_SOURCE,
        data: { mimetype, stale, expected: ctx.textGeneration },
      });
    }
  }

  // A position whose geocode never ran is its own gap: nothing re-emits
  // position.available once the node exists.
  const position = await ctx.getNode(`${filePath}/position`);

  if (position && !position.attrs.geocodedAt) {
    events.push(...await deriveForPosition(`${filePath}/position`, ctx, now));
  }

  return events;
}

/**
 * The text gap for a file `document-index` reads: no `textIndexedAt`, which `index-document`
 * writes whether it found text or not. Apart from `deriveGaps` because a document is not media
 * and has no exif, and a file with no children can have this gap. Read by the reconciler for every
 * file it walks and by the bridge for the files a directory move carried. None for a file in a
 * node's `metadata/` — extracted text, an album's description — which `document-index` never reads.
 */
export function deriveTextGap(filePath: string, file: NodeSnapshot, now: number): Omit<DomainEvent, 'id'>[] {
  const mimetype = str(file.attrs.mimetype) ?? '';

  if (file.type !== 'file' || file.attrs.sourceId || (num(file.attrs.size) ?? 0) === 0) return [];
  if (filePath.includes('/metadata/')) return [];
  if (!isTextIndexedMimetype(mimetype) || str(file.attrs.textIndexedAt)) return [];

  return [{
    type: MEDIA_EVENTS.textMissing,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: { mimetype },
  }];
}

/**
 * The text gap of every file a directory moved whole carried along, `deriveTextGap` per file. The
 * move publishes one event, for the directory, so this is the only fact that reaches those files:
 * a folder filed out of staging is read here.
 */
async function deriveForDirectoryMove(dirPath: string, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  if (!ctx.unreadFilesWithin) return [];
  return (await ctx.unreadFilesWithin(dirPath)).flatMap(({ path, node }) => deriveTextGap(path, node, now));
}

/**
 * Facts derivable from a populated exif node.
 *
 * The fact is keyed on the *exif* node but its payload — and every consumer downstream —
 * reads the **file** node's promoted attrs (mimetype, width/height, angle, takenAt). So
 * `exif-extract` must write those before it fills the exif node, and says so at that line.
 * The other order is a real race: derivatives and face boxes then land in the raw frame
 * because `angle` had not arrived yet.
 */
async function deriveForExif(
  exifPath: string,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const exif = await ctx.getNode(exifPath);

  // The node is created empty and filled by a following update; only the filled
  // state is a fact.
  if (!exif || !exif.attrs.indexedAt) return [];

  const filePath = parentOf(parentOf(exifPath));
  const file = await ctx.getNode(filePath);

  // The same test discovery applies: a text node can carry an exif child from an earlier life
  // (album descriptions on fry, 2026-10-10), and every consumer of this fact renders media.
  if (!file || !isIndexableMedia(file)) return [];

  const where = exif.attrs.where as { gps?: Record<string, unknown> } | undefined;
  const fileinfo = exif.attrs.fileinfo as Record<string, unknown> | undefined;
  const deviceinfo = exif.attrs.deviceinfo as { make?: string; model?: string } | undefined;
  const deviceSerial = str(exif.attrs.deviceSerialNumber) ?? '';

  return [{
    type: MEDIA_EVENTS.metadataExtracted,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype: str(file.attrs.mimetype) ?? '',
      width: num(file.attrs.width) ?? null,
      height: num(file.attrs.height) ?? null,
      takenAt: str(file.attrs.takenAt) ?? null,
      hasGps: Boolean(where?.gps),
      deviceSerial,
      // Whether there is *anything* to match a device on: a serial, or make and
      // model, since most phones write no serial.
      deviceKey: deviceSerial || str(deviceinfo?.model) || str(deviceinfo?.make) || '',
      duration: num(fileinfo?.duration) ?? null,
    },
  }];
}

/** Facts derivable from an embedding node — faces, fingerprints, descriptions. */
async function deriveForEmbedding(
  path: string,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const node = await ctx.getNode(path);

  if (!node) return [];

  const embeddingType = str(node.attrs.embeddingType) ?? '';
  const parent = parentOf(path);

  // <file>/regions/face-N/embedding — one event per face, so assignment is independently
  // retryable and never re-runs detection for the whole file. The fact is about the region:
  // that is where the person is written, so `skipIfAttr: personId` has to read it there.
  if (embeddingType === 'face' && nameOf(path) === 'embedding' && nameOf(parentOf(parent)) === 'regions') {
    const region = await ctx.getNode(parent);
    if (!region) return [];
    const filePath = parentOf(parentOf(parent));

    return [{
      type: MEDIA_EVENTS.faceDetected,
      subject: parent,
      nodeId: region.id,
      time: now,
      source: MEDIA_EVENT_SOURCE,
      data: {
        filePath,
        fileId: str(region.attrs.fileId) ?? '',
        confidence: num(region.attrs.confidence) ?? null,
      },
    }];
  }

  // <file>/metadata/sscd-* — a picture's or video's fingerprint, which album stacking waits for.
  if ((embeddingType === FINGERPRINT_TYPES.image || embeddingType === FINGERPRINT_TYPES.video) && nameOf(parent) === 'metadata') {
    const filePath = parentOf(parent);
    const file = await ctx.getNode(filePath);

    if (!file) return [];

    return [{
      type: MEDIA_EVENTS.fingerprintComputed,
      subject: filePath,
      nodeId: file.id,
      time: now,
      source: MEDIA_EVENT_SOURCE,
      data: {
        mimetype: str(file.attrs.mimetype) ?? '',
        kind: embeddingType,
        label: str(node.attrs.label) ?? '',
      },
    }];
  }

  return [];
}

/**
 * `<file>/metadata/transcript` gaining its `transcribedAt`: a transcript finished. transcribe-file
 * writes the cues first and the attrs with `transcribedAt` after, anew on every run, so this fires
 * once per transcription — and never for a re-embed of its chunks, which writes only the vectors
 * beneath it.
 */
async function deriveForTranscript(
  event: VfsEventInput,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const changed = event.type === 'created' || (event.type === 'updated' && (event.changedAttrs ?? ['transcribedAt']).includes('transcribedAt'));
  if (!changed) return [];
  const transcript = await ctx.getNode(event.path);
  if (!transcript || !str(transcript.attrs.transcribedAt)) return [];
  const filePath = parentOf(parentOf(event.path));
  const file = await ctx.getNode(filePath);
  if (!file || file.type !== 'file') return [];

  return [{
    type: MEDIA_EVENTS.transcriptGenerated,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype: str(file.attrs.mimetype) ?? '',
      speech: transcript.attrs.speech === true,
      language: str(transcript.attrs.language) ?? '',
    },
  }];
}

/**
 * `<file>/metadata/chromaprint` — a recording's fingerprint, announced as an `sscd-*` embedding is.
 * `compute-fingerprint` writes the values first and `computedAt` last, so that write is the one
 * that announces it.
 */
async function deriveForChromaprint(
  event: VfsEventInput,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const changed = event.type === 'created' || (event.type === 'updated' && (event.changedAttrs ?? ['computedAt']).includes('computedAt'));
  if (!changed) return [];
  const print = await ctx.getNode(event.path);
  if (!print || !str(print.attrs.computedAt)) return [];
  const filePath = parentOf(parentOf(event.path));
  const file = await ctx.getNode(filePath);
  if (!file || file.type !== 'file') return [];

  return [{
    type: MEDIA_EVENTS.fingerprintComputed,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype: str(file.attrs.mimetype) ?? '',
      kind: 'chromaprint',
      label: str(print.attrs.label) ?? '',
    },
  }];
}

/**
 * The fingerprint facts with the album fact that rides on them: stacking reads the fingerprint,
 * which lands after the attachment and after the metadata; without this the stacks would wait
 * for the sweep.
 */
async function withMemberFingerprinted(
  facts: Omit<DomainEvent, 'id'>[],
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const fingerprint = facts.find((fact) => fact.type === MEDIA_EVENTS.fingerprintComputed);
  if (!fingerprint) return facts;
  const file = await ctx.getNode(fingerprint.subject);
  return file ? [...facts, ...await deriveForMemberChange(fingerprint.subject, file, 'member-fingerprinted', ctx, now)] : facts;
}

/** Facts derivable from a file's position node. */
async function deriveForPosition(
  path: string,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  if (nameOf(path) !== 'position') return [];

  const node = await ctx.getNode(path);

  if (!node) return [];

  const filePath = parentOf(path);
  const file = await ctx.getNode(filePath);

  if (!file || file.type !== 'file') return [];

  // No coordinates in `data`: they live in the node's content, which is written
  // just after creation. The geocode step reads them from `$NODE_PATH` anyway,
  // so leaving them out removes a race instead of papering over one.
  return [{
    type: MEDIA_EVENTS.positionAvailable,
    subject: path,
    nodeId: node.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: { filePath },
  }];
}

/** One album fact. `cause` says which kind of change it stands for, for a reader of `/dev/events`. */
const albumFact = (albumPath: string, album: NodeSnapshot, now: number, cause: string, member?: string): Omit<DomainEvent, 'id'> => ({
  type: MEDIA_EVENTS.albumMembersChanged,
  subject: albumPath,
  nodeId: album.id,
  time: now,
  source: MEDIA_EVENT_SOURCE,
  data: { cause, ...(member ? { member } : {}) },
});

/**
 * The album whose membership a change to the directory at `path` is a change to: the directory
 * itself when it is an album, or its parent when it is an imported album's `files/`. Anything
 * else — a subfolder, a file's `thumbnails/`, a pipeline instance — is nobody's membership.
 *
 * The name test comes before the read, so the bound `directory.child-detached` key costs nothing
 * for the overwhelming majority of directories, which are not called `files`.
 */
async function albumOfContainer(path: string, ctx: RuleContext): Promise<{ path: string; node: NodeSnapshot } | undefined> {
  const node = await ctx.getNode(path);

  if (!node) return undefined;
  if (node.type === 'album') return { path, node };

  if (node.type === 'directory' && nameOf(path) === FILES_DIR_NAME) {
    const parentPath = parentOf(path);
    const parent = await ctx.getNode(parentPath);

    if (parent?.type === 'album') return { path: parentPath, node: parent };
  }

  return undefined;
}

/**
 * The fact a membership change to the container at `path` reveals. The bridge sees these on
 * the container's own `child-attached` / `child-detached`, which carry the parent.
 */
async function deriveForContainer(
  path: string,
  nodeType: string,
  cause: string,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  // Free rejection for the churn behind the directory key; an album is always worth the read.
  if (nodeType !== 'album' && !(nodeType === 'directory' && nameOf(path) === FILES_DIR_NAME)) return [];

  const album = await albumOfContainer(path, ctx);

  return album ? [albumFact(album.path, album.node, now, cause)] : [];
}

/**
 * The fact a file arriving at `filePath` reveals about an imported album's `files/` — the one
 * attachment the container's own key cannot report, since `directory.child-attached` is not
 * bound. A file arriving directly in an album is reported by `album.child-attached` and is not
 * repeated here.
 */
async function deriveForFilesDirArrival(
  filePath: string,
  cause: string,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  const dir = parentOf(filePath);

  if (nameOf(dir) !== FILES_DIR_NAME) return [];

  const album = await albumOfContainer(dir, ctx);

  return album ? [albumFact(album.path, album.node, now, cause, filePath)] : [];
}

/**
 * One album fact per album holding the file — by its own level or its `files/`, by hard link
 * or by softlink — for a change to what is known about the member rather than to the member
 * set: its capture time arriving or moving, its fingerprint landing. Without `containersOf`
 * (the reconciler) there is nothing to answer.
 */
async function deriveForMemberChange(
  filePath: string,
  file: NodeSnapshot,
  cause: string,
  ctx: RuleContext,
  now: number,
): Promise<Omit<DomainEvent, 'id'>[]> {
  if (!ctx.containersOf || !isIndexableMedia(file)) return [];

  const facts: Omit<DomainEvent, 'id'>[] = [];
  const seen = new Set<string>();

  for (const container of await ctx.containersOf(filePath, file.id)) {
    const album = await albumOfContainer(container, ctx);

    if (!album || seen.has(album.node.id)) continue;
    seen.add(album.node.id);
    facts.push(albumFact(album.path, album.node, now, cause, filePath));
  }

  return facts;
}

/**
 * The removal of a file the pipelines indexed. Decided on the attrs the event carries, the only
 * record left of the node; a payload without them derives nothing.
 */
function deriveForRemoval(event: VfsEventInput, now: number): Omit<DomainEvent, 'id'>[] {
  if (!event.attrs) return [];

  const file: NodeSnapshot = { id: event.nodeId, type: event.nodeType, attrs: event.attrs };
  if (!isIndexableMedia(file)) return [];

  return [{
    type: MEDIA_EVENTS.fileRemoved,
    subject: event.path,
    nodeId: event.nodeId,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype: str(file.attrs.mimetype) ?? '',
      size: num(file.attrs.size) ?? 0,
      ...(str(file.attrs.sha256) ? { sha256: str(file.attrs.sha256) } : {}),
    },
  }];
}

/**
 * Map one VFS mutation to the facts it reveals. Returns an empty array for the
 * overwhelming majority of events — that is the point.
 */
export async function deriveEvents(
  event: VfsEventInput,
  ctx: RuleContext,
  now: number = Date.now(),
): Promise<Omit<DomainEvent, 'id'>[]> {
  // Scratch is never the archive's: a picture put in /tmp to search with is not indexed, and
  // indexed it would answer every search through its vectors.
  if (event.path === TEMP_PATH || event.path.startsWith(`${TEMP_PATH}/`)) return [];

  // Membership events name the container, whatever its type, so they are sorted
  // by event before the node type below gets to say anything.
  if (event.type === 'child-attached' || event.type === 'child-detached') {
    const cause = event.type === 'child-attached' ? 'member-attached' : 'member-detached';
    return await deriveForContainer(event.path, event.nodeType, cause, ctx, now);
  }

  switch (event.nodeType) {
    case 'file': {
      if (event.type === 'deleted') return deriveForRemoval(event, now);
      if (nameOf(event.path) === 'transcript' && nameOf(parentOf(event.path)) === 'metadata') return await deriveForTranscript(event, ctx, now);
      if (nameOf(event.path) === 'chromaprint' && nameOf(parentOf(event.path)) === 'metadata') {
        return await withMemberFingerprinted(await deriveForChromaprint(event, ctx, now), ctx, now);
      }

      // The child's side of an arrival in an imported album's `files/`. Answered
      // before the node is read: the name test decides for almost every file.
      if (event.type === 'moved') return await deriveForFilesDirArrival(event.path, 'member-attached', ctx, now);

      const arrival = event.type === 'created' ? await deriveForFilesDirArrival(event.path, 'member-attached', ctx, now) : [];
      const file = await ctx.getNode(event.path);
      const primary = await deriveForFile(event.path, ctx, now, file);
      // Discovery and content change supersede the old face marker: nothing
      // downstream acts on the prior source while media-reindex is still
      // clearing/rebuilding derivatives.
      if (primary.length > 0) return [...arrival, ...primary];

      if (!file) return arrival;

      // A capture time that moved under an indexed member — a retime, or a
      // re-resolve — moves the member inside every album holding it. Decided on
      // the names the event carries, so an attr write that left the time alone
      // costs no reverse lookup.
      const retimed = event.type === 'updated' && (event.changedAttrs ?? []).some((name) => CAPTURE_TIME_ATTRS.includes(name))
        ? await deriveForMemberChange(event.path, file, 'member-retimed', ctx, now)
        : [];

      return [
        ...arrival,
        ...deriveFacesCompleted(event.path, file, now),
        ...deriveSpeakersDetected(event, file, now),
        ...await deriveFileTurned(event, file, ctx, now),
        ...deriveTextLanguageSet(event, file, now),
        ...retimed,
      ];
    }
    case 'exif': {
      const facts = await deriveForExif(event.path, ctx, now);
      // Metadata is where a member's capture time comes from, and an attachment
      // fires long before it: the album fact rides on the same event.
      if (facts.length === 0) return facts;
      const filePath = parentOf(parentOf(event.path));
      const file = await ctx.getNode(filePath);
      return file ? [...facts, ...await deriveForMemberChange(filePath, file, 'member-indexed', ctx, now)] : facts;
    }
    case 'embedding':
      return await withMemberFingerprinted(await deriveForEmbedding(event.path, ctx, now), ctx, now);
    case 'position':
      return await deriveForPosition(event.path, ctx, now);
    case 'directory':
      return event.type === 'moved' ? await deriveForDirectoryMove(event.path, ctx, now) : [];
    default:
      return [];
  }
}
