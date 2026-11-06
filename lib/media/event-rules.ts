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

import { CHUNK_TARGET_SECONDS } from '@media/transcript';
import { FINGERPRINTED_AT_ATTR } from '@media/fingerprints';
import { FACE_EMBEDDING_TYPE, FACE_MODEL } from '@archive/media/regions';
import { parseStagedPath } from '@archive/staging/paths';
import { RENDITION_FACTS, TEXT_FACTS } from '@media/facts';
import {
  deriveForExif as extractedFacts,
  deriveForFile as fileFacts,
  FILE_FACTS,
  type FileRuleContext,
  isIndexableMedia,
  isMediaPath,
  isTextIndexedMimetype,
  type NodeSnapshot,
  type VfsEventInput,
} from '@media/file-rules';
import type { DomainEvent } from '@ein/client';
import { isTrashPath } from '@ein/paths';
import { authoredHash, textEmbeddingType } from '@ems/text-embedding';

// The media module's, which the archive's rules and the staging rules read as their own.
export { isIndexableMedia };
export type { NodeSnapshot, VfsEventInput };

/**
 * File-node attr: when `exif-interpret` last read what the file's metadata means in the archive —
 * its capture time and place — written last, which this bridge announces as
 * `media.metadata.interpreted`.
 */
export const INTERPRETED_AT_ATTR = 'interpretedAt';

const MEDIA_EVENT_SOURCE = 'archive-bridge';

/** Facts the bridge produces. */
export const MEDIA_EVENTS = {
  // The facts of a media file itself, which the media module's bridge announces (`@media/file-rules`).
  fileDiscovered: FILE_FACTS.discovered,
  fileContentChanged: FILE_FACTS.contentChanged,
  fileRemoved: FILE_FACTS.removed,
  fileTurned: FILE_FACTS.turned,
  metadataExtracted: FILE_FACTS.metadataExtracted,
  // The facts of a file's text, the media module's too (`@media/facts`): the bridge there derives
  // the first two, and this module's scan finds the others' gaps.
  textLanguageSet: TEXT_FACTS.languageSet,
  transcriptGenerated: TEXT_FACTS.transcriptGenerated,
  transcriptStale: TEXT_FACTS.transcriptStale,
  ocrStale: TEXT_FACTS.ocrStale,
  textEmbeddingStale: TEXT_FACTS.textEmbeddingStale,
  textMissing: TEXT_FACTS.textMissing,
  /**
   * What a file's metadata means in the archive is read: `exif-interpret` wrote its capture time
   * and place and, last, `interpretedAt`. Only on the write that changed it. Starts the archive's
   * analysis: faces and the device link.
   */
  metadataInterpreted: 'media.metadata.interpreted',
  renditionsMade: FILE_FACTS.renditionsMade,
  /** A file's renditions are missing or stale; the media module's `renditions-scan` announces it. */
  renditionsStale: RENDITION_FACTS.stale,
  /** `<file>/position` exists. Subject is the position node. */
  positionAvailable: 'media.position.available',
  /** One face. Subject is the face node, so assignment is a per-face unit. */
  faceDetected: 'media.face.detected',
  /**
   * Face detection has finished for an image, including a zero-face result, or for a video, on
   * the write that finished it. A video's `data.speakersAt` says whether its voices are there yet.
   */
  facesCompleted: 'media.faces.completed',
  /**
   * A recording's voices are written (`speakersAt` on the file). Subject is the file: who each
   * voice is gets decided once per recording, not once per turn.
   */
  speakersDetected: 'media.speakers.detected',
  /**
   * A face region of a video with voices changed person: a voice seen speaking with it may be
   * someone else now. Subject is the video, whose voices are decided together.
   */
  speakersFaceChanged: 'media.speakers.face-changed',
  /**
   * A recording with speech in its transcript has no voices: never voiceprinted. The reconciler's
   * gap.
   */
  speakersMissing: 'media.speakers.missing',
  /**
   * A photo or video's faces were found by other face models than EMS runs now (`facesBy`). Its
   * own fact because the face pipelines' ordinary trigger skips every file that has `facesAt`.
   */
  facesStale: 'media.faces.stale',
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
  'system.vfs.position.created',
  'system.vfs.embedding.created',
  // A face's person changing: about one write per face. Any other write to a region is dropped on
  // the names the event carries; a person change costs one read of the file.
  'system.vfs.media-region.updated',
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
/** Only images get a face-detection marker, so only images can be missing one. */
const IMAGE_MIMETYPE = /^image\//;
/** A photo or a video: what faces are found in. */
const PICTURE_MIMETYPE = /^(image|video)\//;

/** Everything a rule needs from the VFS, so the rules stay testable in isolation. */
export type RuleContext = FileRuleContext & {
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
   * The engine EMS reads pictures' text with now (`generations()` in `@ems/client`). A picture
   * marked read whose `ocrBy` names another engine, or none, is read again; one whose text a
   * person wrote is not. Derived from EMS like `transcriptGeneration`, and undefined when EMS cannot
   * be asked, which disables the check.
   */
  ocrGeneration?: string;
  /**
   * The face models EMS runs now (`generations()` in `@ems/client`). A detected file whose
   * `facesBy` names others, or none, has its faces detected again: their vectors are in another
   * space. Only when EMS runs the models recognition is tuned for (`FACE_MODEL`), since a
   * re-detection with any others stores nothing. Derived from EMS like `transcriptGeneration`, and
   * undefined when EMS cannot be asked, which disables the check.
   */
  faceGeneration?: string;
  /**
   * The text embedder EMS runs now (`generations()` in `@ems/client`). A text under a
   * file's `metadata/` whose vector carries another `embeddedBy`, or has none, is embedded again
   * from the stored text. Derived from EMS like `transcriptGeneration`, with no `off`, and undefined
   * when EMS cannot be asked or runs a model nothing has given a type to, which disables the check.
   */
  textGeneration?: string;
};

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

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
 * The fact revealed by detect-faces' final update of the source file. A video's only on the write
 * that set `facesAt`: what follows it (the voices tied to its faces) asks EMS, and a video's file
 * takes many later attr writes.
 */
function deriveFacesCompleted(
  event: VfsEventInput,
  file: NodeSnapshot,
  now: number,
): Omit<DomainEvent, 'id'>[] {
  const mimetype = str(file.attrs.mimetype) ?? '';
  const facesAt = str(file.attrs.facesAt);

  if (!isIndexableMedia(file) || !PICTURE_MIMETYPE.test(mimetype) || !facesAt) return [];
  const video = !IMAGE_MIMETYPE.test(mimetype);
  if (video && !(event.changedAttrs ?? []).includes('facesAt')) return [];

  return [{
    type: MEDIA_EVENTS.facesCompleted,
    subject: event.path,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype,
      facesAt,
      faceCount: num(file.attrs.faceCount) ?? 0,
      ...(video ? { speakersAt: str(file.attrs.speakersAt) ?? '' } : {}),
    },
  }];
}

/** Region attrs that decide whom a voice seen speaking with the face votes for. */
const REGION_PERSON_ATTRS = ['personId', 'assignLocked', 'rejectedPersonIds'];

/**
 * The fact a face region's person changing reveals about a video's voices. Only a video that has
 * voices: the voices tied to the face are decided again where the face now disagrees with them
 * (@archive/media/speaker-assign).
 *
 * A region removed is no fact: `detect-faces` replacing a video's regions announces
 * `media.faces.completed`, which ties the voices to the new ones, and a face a person removes by
 * hand leaves the voices as they were decided.
 */
async function deriveForRegion(event: VfsEventInput, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  if (event.type !== 'updated' || !(event.changedAttrs ?? []).some((name) => REGION_PERSON_ATTRS.includes(name))) return [];
  const regionsDir = parentOf(event.path);
  if (nameOf(regionsDir) !== 'regions') return [];
  const filePath = parentOf(regionsDir);
  if (isTrashPath(filePath)) return [];
  const file = await ctx.getNode(filePath);
  const mimetype = str(file?.attrs.mimetype) ?? '';
  if (!file || !mimetype.startsWith('video/') || !str(file.attrs.speakersAt)) return [];
  return [{
    type: MEDIA_EVENTS.speakersFaceChanged,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: { mimetype, regionPath: event.path },
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
  // Every audio and video file gets a transcript node, a silent one an empty cue list.
  const missingTranscript = !metadataChildren.includes('transcript');
  // `detect-faces` writes `facesAt` in both of its exit paths, including on a photo with nobody
  // in it, so its absence means the step never ran — which a `regions/` directory would not say,
  // since the legacy importer writes one at import time. Images only: a video gets the marker
  // too, but one without it is not announced again — sampling every video of an archive is hours
  // of card time, and an import detects its videos' faces as it indexes them (ein/core#410).
  const missingFaces = IMAGE_MIMETYPE.test(str(file.attrs.mimetype) ?? '') && !str(file.attrs.facesAt);

  const events: Omit<DomainEvent, 'id'>[] = [];

  // A re-emit re-opens a whole fan-out and each pipeline's own `skipIf` drops the stages already
  // done, so this predicate wants a term per pipeline hanging off the fact: the media module's
  // `media.metadata.extracted` for a file whose metadata the archive never read (then interpreting
  // it starts the rest) or that lacks a transcript, and the archive's `media.metadata.interpreted`
  // for its own analysis, faces. A stage it does not ask about is a stage nothing ever
  // re-announces — and a guard like `skipIfAttr: facesAt` cannot rescue a pipeline nobody
  // announces, it only skips one that is (ein/core#140).
  //
  // Renditions, picture vectors and fingerprints have no term here: the media module's scans
  // compare their markers, in every tree, and announce a gap as a fact only their pipelines take.
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
  const interpreted = str(file.attrs[INTERPRETED_AT_ATTR]) !== undefined;

  if (!undecodable && (!interpreted || (!isImage && missingTranscript))) {
    events.push(...(await extractedFacts(`${filePath}/metadata/exif`, ctx, now)).map((fact) => ({ ...fact, source: MEDIA_EVENT_SOURCE })));
  } else if (!undecodable && missingFaces) {
    const fact = await interpretedFact(filePath, file, ctx, now);
    if (fact) events.push(fact);
  }

  // A transcript an interrupted run left without `transcribedAt`, or one decoded with other
  // whisper settings than EMS runs now. Only a transcript that names a model is compared with the
  // settings: one with `transcribedBy` null was written for a file with no audio track, and
  // transcribing it again would write the same nulls back on every scan. One a person corrected
  // (`editedAt`) is never stale: `transcribe-file` keeps it whatever the settings.
  const transcript = !isImage && !missingTranscript && !undecodable ? await ctx.getNode(`${filePath}/metadata/transcript`) : undefined;

  if (transcript) {
    const transcribedWith = str(transcript.attrs.transcribedWith);
    const unfinished = !str(transcript.attrs.transcribedAt);
    const superseded = ctx.transcriptGeneration !== undefined && str(transcript.attrs.transcribedBy) !== undefined &&
      transcribedWith !== ctx.transcriptGeneration && !str(transcript.attrs.editedAt);

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

  const mimetype = str(file.attrs.mimetype) ?? '';

  // Faces found by other models than EMS runs now, on a photo or a video. A file never detected is
  // `missingFaces`'s above, so this asks only one that has `facesAt`.
  if (ctx.faceGeneration === FACE_MODEL && !undecodable && PICTURE_MIMETYPE.test(mimetype) && str(file.attrs.facesAt)) {
    const facesBy = str(file.attrs.facesBy);
    if (facesBy !== ctx.faceGeneration) {
      events.push({
        type: MEDIA_EVENTS.facesStale,
        subject: filePath,
        nodeId: file.id,
        time: now,
        source: MEDIA_EVENT_SOURCE,
        data: { mimetype, facesBy: facesBy ?? '', expected: ctx.faceGeneration },
      });
    }
  }

  // Text in a picture read by another engine than EMS reads with now, or marked read with none
  // named. A picture never read (no `textIndexedAt`) is `media.text.missing`'s, so it is not
  // announced twice, one whose text a person wrote (`textManual`) is never read again, and a staged
  // one, which `media-ocr` does not read, is found again once it is filed.
  const ocrBy = str(file.attrs.ocrBy);
  const read = Boolean(str(file.attrs.textIndexedAt)) && file.attrs.textManual !== true;
  if (ctx.ocrGeneration && !undecodable && isImage && read && ocrBy !== ctx.ocrGeneration && !parseStagedPath(filePath)) {
    events.push({
      type: MEDIA_EVENTS.ocrStale,
      subject: filePath,
      nodeId: file.id,
      time: now,
      source: MEDIA_EVENT_SOURCE,
      data: { mimetype, ocrBy: ocrBy ?? '', expected: ctx.ocrGeneration },
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
 * node's `metadata/` — extracted text, an album's description — nor for one in a staging area,
 * neither of which the text pipelines read: a staged file is read when it is filed.
 */
export function deriveTextGap(filePath: string, file: NodeSnapshot, now: number): Omit<DomainEvent, 'id'>[] {
  const mimetype = str(file.attrs.mimetype) ?? '';

  if (file.type !== 'file' || file.attrs.sourceId || (num(file.attrs.size) ?? 0) === 0) return [];
  if (filePath.includes('/metadata/') || parseStagedPath(filePath)) return [];
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

/** Facts derivable from an embedding node: a face's. */
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
  if (embeddingType === FACE_EMBEDDING_TYPE && nameOf(path) === 'embedding' && nameOf(parentOf(parent)) === 'regions') {
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

  return [];
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
 * The fact `exif-interpret` announces by writing `interpretedAt` on the file, which it does last,
 * with the archive's reading of its metadata in `data`; and, since that is where a member's capture
 * time comes from, the album fact of every album holding it. Only on the write that changed it.
 */
async function deriveInterpreted(event: VfsEventInput, file: NodeSnapshot, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'>[]> {
  if (event.type !== 'updated' || !(event.changedAttrs ?? []).includes(INTERPRETED_AT_ATTR)) return [];
  const fact = await interpretedFact(event.path, file, ctx, now);
  return fact ? [fact, ...await deriveForMemberChange(event.path, file, 'member-indexed', ctx, now)] : [];
}

/** `media.metadata.interpreted` for a file whose metadata the archive has read: when, where, the device. */
async function interpretedFact(filePath: string, file: NodeSnapshot, ctx: RuleContext, now: number): Promise<Omit<DomainEvent, 'id'> | undefined> {
  const interpretedAt = str(file.attrs[INTERPRETED_AT_ATTR]);
  if (!interpretedAt || !isIndexableMedia(file)) return undefined;
  const exif = await ctx.getNode(`${filePath}/metadata/exif`);
  const where = exif?.attrs.where as { gps?: Record<string, unknown> } | undefined;
  const deviceinfo = exif?.attrs.deviceinfo as { make?: string; model?: string } | undefined;
  const deviceSerial = str(exif?.attrs.deviceSerialNumber) ?? '';
  return {
    type: MEDIA_EVENTS.metadataInterpreted,
    subject: filePath,
    nodeId: file.id,
    time: now,
    source: MEDIA_EVENT_SOURCE,
    data: {
      mimetype: str(file.attrs.mimetype) ?? '',
      interpretedAt,
      takenAt: str(file.attrs.takenAt) ?? null,
      hasGps: Boolean(where?.gps),
      deviceSerial,
      // Whether there is *anything* to match a device on: a serial, or make and model, since most
      // phones write no serial.
      deviceKey: deviceSerial || str(deviceinfo?.model) || str(deviceinfo?.make) || '',
    },
  };
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
  if (!isMediaPath(event.path)) return [];

  // Membership events name the container, whatever its type, so they are sorted
  // by event before the node type below gets to say anything.
  if (event.type === 'child-attached' || event.type === 'child-detached') {
    const cause = event.type === 'child-attached' ? 'member-attached' : 'member-detached';
    return await deriveForContainer(event.path, event.nodeType, cause, ctx, now);
  }

  switch (event.nodeType) {
    case 'file': {
      // The child's side of an arrival in an imported album's `files/`. Answered
      // before the node is read: the name test decides for almost every file.
      if (event.type === 'moved') return await deriveForFilesDirArrival(event.path, 'member-attached', ctx, now);

      const arrival = event.type === 'created' ? await deriveForFilesDirArrival(event.path, 'member-attached', ctx, now) : [];
      const file = await ctx.getNode(event.path);
      if (!file) return arrival;
      // A file the media module announces to be read — new, or new bytes — says nothing yet of its
      // old faces or voices: nothing downstream acts on the prior source while it is read again.
      if ((await fileFacts(event.path, ctx, now, file)).length > 0) return arrival;

      // A capture time that moved under an indexed member — a retime, or a
      // re-resolve — moves the member inside every album holding it. Decided on
      // the names the event carries, so an attr write that left the time alone
      // costs no reverse lookup.
      const retimed = event.type === 'updated' && (event.changedAttrs ?? []).some((name) => CAPTURE_TIME_ATTRS.includes(name))
        ? await deriveForMemberChange(event.path, file, 'member-retimed', ctx, now)
        : [];
      // Stacking reads a member's print, which lands after the attachment and after the metadata:
      // `compute-fingerprint` writes `fingerprintedAt` once every print is there.
      const fingerprinted = event.type === 'updated' && (event.changedAttrs ?? []).includes(FINGERPRINTED_AT_ATTR)
        ? await deriveForMemberChange(event.path, file, 'member-fingerprinted', ctx, now)
        : [];

      return [
        ...arrival,
        ...deriveFacesCompleted(event, file, now),
        ...await deriveInterpreted(event, file, ctx, now),
        ...deriveSpeakersDetected(event, file, now),
        ...retimed,
        ...fingerprinted,
      ];
    }
    case 'embedding':
      return await deriveForEmbedding(event.path, ctx, now);
    case 'position':
      return await deriveForPosition(event.path, ctx, now);
    case 'media-region':
      return await deriveForRegion(event, ctx, now);
    case 'directory':
      return event.type === 'moved' ? await deriveForDirectoryMove(event.path, ctx, now) : [];
    default:
      return [];
  }
}
