/**
 * Person node lifecycle for the people area — slugs, unnamed (auto-created)
 * people, naming and merging.
 *
 * Face recognition mints a person for every identity it finds, long before
 * anyone has said who that is. Those live under `/people/unknown/<ulid>` marked
 * `attrs.unnamed`, and are ordinary `person` nodes in every other respect. The
 * separate directory is what keeps them out of the way for free: everything
 * that lists people (`ls -l /people`, `search-people`) reads the *direct*
 * children of `/people`, so an unnamed person is invisible to it without a
 * single filter.
 *
 * Naming one moves it to `/people/<slug>`. `vfs.rename` re-parents the existing
 * node rather than creating a new one, so the node id survives — which matters
 * because every recognized face refers to its person by id, and a copy-and-
 * delete would strand all of them.
 *
 * Imported by the #!ts bins via the @archive/people/person alias (a bin copied to /tmp
 * cannot use relative imports, but the alias resolves to this file, whose own
 * relative imports resolve normally).
 */

import { fileOfSpeaker, longestTurn, type Span } from '@archive/media/speakers';
import { PEOPLE_ROOT } from '@archive/paths';
import type { AttrCondition, Command } from '@ein/client';
import { unlistedIds, unlistedRoots } from '@ein/client';
import { basename, dirname, resolve } from '@std/path';
import { ulid } from '@std/ulid';
import { CHILDREN_DIR, createRelationPair, makeCtx, PARENTS_DIR, PARTNERS_DIR, readRelationDir, removeRelationPair, wouldCreateCycle } from '@archive/people/genealogy';
import type { PersonAttrs, PersonGender } from '@archive/people/types';
import type { FaceDoubtView } from '@archive/people/api';
import { CROP_PADDING, MAX_CROP_DIMENSION } from '@archive/media/face-crop';
import { FACE_EMBEDDING_NAME, REGION_TYPE } from '@archive/media/regions';

// Re-exported so #!ts bins can reach the person types: a bin is copied to /tmp
// and cannot use relative imports, only the import map's aliases.
export type { PersonAttrs, PersonGender };

// Derive the concrete vfs/access types from the Command surface so the module
// does not import core internals directly.
export type Vfs = Command['sys']['vfs'];
export type Access = Command['access'];

export { PEOPLE_ROOT };
const UNKNOWN_DIR = 'unknown';
export const UNKNOWN_ROOT = `${PEOPLE_ROOT}/${UNKNOWN_DIR}`;

const NODE_TYPE_PERSON = 'person';
const NODE_TYPE_DIRECTORY = 'directory';
const EVENTS_DIR = 'events';

/** Attrs an auto-created person carries on top of the ordinary person shape. */
type UnnamedAttrs = {
  /** Present and true only while nobody has named this person. */
  unnamed?: boolean;
  /** What produced the person: `face` for face recognition, `voice` for a voiceprint. */
  origin?: string;
  /** The command that created it (`assign-faces` | `cluster-faces`). */
  createdBy?: string;
  /** Node id of the face that seeded the person — the thumbnail to show. */
  representativeFaceId?: string;
  createdAt?: string;
};

export type PersonNodeAttrs = PersonAttrs & UnnamedAttrs;

/** True while nobody has named this person. */
export const isUnnamed = (attrs: PersonNodeAttrs | undefined): boolean => attrs?.unnamed === true;

const TRANSLITERATE: Record<string, string> = {
  å: 'a',
  ä: 'a',
  ö: 'o',
  é: 'e',
  è: 'e',
  ê: 'e',
  ü: 'u',
  ø: 'o',
  æ: 'ae',
  ß: 'ss',
  ñ: 'n',
  ç: 'c',
};

/**
 * Name -> path segment.
 *
 * Transliterates rather than stripping: dropping non-ASCII would turn "Åsa
 * Öberg" into `sa-berg`.
 */
export const slugifyName = (name: string): string => {
  const lowered = name.toLowerCase().normalize('NFC');
  let out = '';
  for (const ch of lowered) out += TRANSLITERATE[ch] ?? ch;
  return out
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip any remaining diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

/** `base`, else `base-2`, `base-3`, … — the first name free under `parent`. */
export const uniqueSlug = async (vfs: Vfs, access: Access, parent: string, base: string): Promise<string> => {
  const stem = base || 'person';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (!(await vfs.exists(access, `${parent}/${candidate}`, { follow: false }))) return candidate;
  }
  throw new Error(`could not find a free slug for ${stem}`);
};

const ensureDir = async (vfs: Vfs, access: Access, path: string): Promise<void> => {
  await vfs.ensure(access, NODE_TYPE_DIRECTORY, dirname(path), basename(path));
};

/** `/people` then `/people/unknown` — `ensure` needs the parent to exist. */
const ensureUnknownRoot = async (vfs: Vfs, access: Access): Promise<void> => {
  await ensureDir(vfs, access, PEOPLE_ROOT);
  await ensureDir(vfs, access, UNKNOWN_ROOT);
};

type CreateUnnamedOptions = {
  representativeFaceId?: string;
  /** Command name recorded in `attrs.createdBy`. */
  createdBy: string;
  /**
   * What found this person, recorded in `attrs.origin`. Defaults to `face`.
   *
   * `voice` people arrive with no `representativeFaceId`: there is no crop to show, because
   * what identified them was a span of audio. Anything that grows a thumbnail for an unnamed
   * person has to branch on this rather than assume a face is there.
   */
  origin?: string;
};

export type UnnamedPerson = { id: string; path: string; name: string };

/**
 * Create an unnamed person under `/people/unknown`.
 *
 * The display name is never empty, since an empty string would render as a
 * blank row. A short ULID-derived suffix makes it unique and stable without
 * pretending to be a real name.
 */
export const createUnnamedPerson = async (
  vfs: Vfs,
  access: Access,
  opts: CreateUnnamedOptions,
): Promise<UnnamedPerson> => {
  await ensureUnknownRoot(vfs, access);

  const id = ulid();
  const slug = id.toLowerCase();
  const name = `Unknown ${id.slice(-6)}`;
  const path = `${UNKNOWN_ROOT}/${slug}`;

  const attrs: PersonNodeAttrs = {
    name,
    unnamed: true,
    origin: opts.origin ?? 'face',
    createdBy: opts.createdBy,
    createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  if (opts.representativeFaceId) attrs.representativeFaceId = opts.representativeFaceId;

  const node = await vfs.create(access, NODE_TYPE_PERSON, UNKNOWN_ROOT, slug, {
    attrs,
  });

  // Same shape as a person-create person, so nothing downstream has to special-case one.
  await vfs.ensure(access, NODE_TYPE_DIRECTORY, path, EVENTS_DIR);

  return { id: node.id, path, name };
};

const FACE_QUERY_LIMIT = 500000;

/**
 * The regions assigned to a person — faces and hand-drawn or imported tags alike, since both
 * say the person is in that photo. `faceEmbeddingsOf` tells the two apart.
 */
export const regionsOf = (vfs: Vfs, access: Access, personId: string) =>
  vfs.query(access, {
    types: [REGION_TYPE],
    where: [{ ref: 'personId', op: 'eq', value: personId }],
    limit: FACE_QUERY_LIMIT,
  });

/**
 * How many regions and voices each person holds, `personId → count`, in two aggregates. A
 * person missing from the map holds nothing: an orphan, if nobody named them.
 *
 * `listed` counts only what the library shows, leaving out the faces and voices of files in an
 * unlisted tree (staging). They sit under their file, where no `notWithin` reaches, so while there
 * is such a tree they are counted per file and the files looked up (`unlistedIds`); one that names
 * no file is counted.
 */
export const holdingsByPerson = async (cmd: Pick<Command, 'sys' | 'access'>, opts: { listed?: boolean } = {}): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  const add = (buckets: { key: string[]; count: number }[]) => {
    for (const bucket of buckets) if (bucket.key[0]) counts.set(bucket.key[0], (counts.get(bucket.key[0]) ?? 0) + bucket.count);
  };
  const regions: AttrCondition[] = [{ ref: 'personId', op: 'exists' }];
  const voices: AttrCondition[] = [{ ref: 'embeddingType', op: 'eq', value: 'voice' }, { ref: 'personId', op: 'exists' }];
  const roots = opts.listed ? await unlistedRoots(cmd.sys.vfs) : [];
  if (roots.length === 0) {
    add(await cmd.sys.vfs.aggregate(cmd.access, { types: [REGION_TYPE], where: regions, group: [{ ref: 'personId' }] }));
    add(await cmd.sys.vfs.aggregate(cmd.access, { types: ['embedding'], where: voices, group: [{ ref: 'personId' }] }));
    return counts;
  }

  const byFile = [
    ...await cmd.sys.vfs.aggregate(cmd.access, { types: [REGION_TYPE], where: regions, group: [{ ref: 'personId' }, { ref: 'fileId' }] }),
    ...await cmd.sys.vfs.aggregate(cmd.access, { types: ['embedding'], where: voices, group: [{ ref: 'personId' }, { ref: 'fileId' }] }),
  ];
  const hidden = await unlistedIds(cmd.sys.vfs, [...new Set(byFile.map((bucket) => bucket.key[1]))]);
  add(byFile.filter((bucket) => !hidden.has(bucket.key[1])));
  const unfiled: AttrCondition = { ref: 'fileId', op: 'missing' };
  add(await cmd.sys.vfs.aggregate(cmd.access, { types: [REGION_TYPE], where: [...regions, unfiled], group: [{ ref: 'personId' }] }));
  add(await cmd.sys.vfs.aggregate(cmd.access, { types: ['embedding'], where: [...voices, unfiled], group: [{ ref: 'personId' }] }));
  return counts;
};

/**
 * The face embedding under each region that has one, `region id → embedding id`, in one batched
 * lookup. A region absent from the map is a tag: a box, no vector, no vote in recognition.
 */
export const faceEmbeddingsOf = async (vfs: Vfs, access: Access, regionIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  if (regionIds.length === 0) return out;
  for (const [id, children] of await vfs.getChildLinksByIds(access, regionIds)) {
    const child = children.find((link) => link.name === FACE_EMBEDDING_NAME);
    if (child) out.set(id, child.id);
  }
  return out;
};

/**
 * The voices of recordings currently assigned to a person: speaker nodes, by node id.
 *
 * A sibling of `regionsOf` rather than a parameter on it. The two answer different questions —
 * "which photos show this person" and "which recordings is this person heard in" — and every
 * caller knows which one it wants.
 */
export const voicesOf = (vfs: Vfs, access: Access, personId: string) =>
  vfs.query(access, {
    types: ['embedding'],
    where: [{ ref: 'embeddingType', op: 'eq', value: 'voice' }, { ref: 'personId', op: 'eq', value: personId }],
    limit: FACE_QUERY_LIMIT,
  });

/**
 * The attrs that say a region or voice is not a person at all: no identity, and locked, so the
 * next `assign-faces` or `cluster-faces` run leaves it alone rather than re-tagging it. `null`
 * removes a key.
 */
export const NOT_A_PERSON = { personId: null, personSource: null, personConfidence: null, personAssignedAt: null, assignLocked: true } as const;

/** What became of a person once regions or voices left them. */
type Released = { personPath: string | null; personRemoved: boolean; representativeChanged: boolean };

/**
 * Tidy up a person after some of their regions or voices have left them, removed or moved to
 * someone else; `goneIds` are those nodes' ids.
 *
 * An unnamed person left holding nothing is deleted, since nothing leads back to them any more.
 * Anyone else keeps going, and a representative face among the gone is replaced by a region they
 * still hold.
 */
export const releasePerson = async (vfs: Vfs, access: Access, personId: string, goneIds: ReadonlySet<string>): Promise<Released> => {
  const entries = await vfs.resolveId(access, personId).catch(() => []);
  const personPath = entries.map((entry) => entry.vfsAbsPath).find((path) => dirname(path) === UNKNOWN_ROOT) ?? entries[0]?.vfsAbsPath ?? null;
  const person = personPath ? await vfs.get<PersonNodeAttrs>(access, personPath, { follow: false }).catch(() => undefined) : undefined;
  const released: Released = { personPath, personRemoved: false, representativeChanged: false };
  if (!personPath || !person) return released;

  const remainingFaces = await regionsOf(vfs, access, personId);
  const removable = dirname(personPath) === UNKNOWN_ROOT && isUnnamed(person.attrs);
  if (removable && remainingFaces.length === 0 && (await voicesOf(vfs, access, personId)).length === 0) {
    await vfs.unlink(access, personPath, UNKNOWN_ROOT, { recursive: true });
    return { ...released, personRemoved: true };
  }
  const representative = person.attrs.representativeFaceId;
  if (representative && goneIds.has(representative)) {
    await vfs.update(access, personPath, { attrs: { representativeFaceId: remainingFaces[0]?.node.id ?? null } });
    return { ...released, representativeChanged: true };
  }
  return released;
};

/** A region lives at `<image>/regions/<name>`, so the image is already in hand. */
const REGION_PATH = /^(.*)\/regions\/[^/]+$/;

/** One region as the UI needs it: where the crop is, and which photo it came from. */
export type FaceView = {
  /** The region. The crop is the child `image.avif`, and may be absent — see `faceView`. */
  facePath: string;
  /** A face the detector found, with a vector; false for a box a human drew or an import carried. */
  hasFace: boolean;
  /** The photo this face was cut from; absent when the face sits somewhere unexpected. */
  filePath?: string;
  fileId?: string;
  /** The source photo's wall clock — what a caption shows. */
  takenAt?: string;
  /** The source photo's instant — what `--sort date` orders on. */
  takenAtUtc?: string;
  /** The source photo's type and stored size, read with its capture time, so a viewer can open it. */
  mimetype?: string;
  width?: number;
  height?: number;
  angle?: number;
  /**
   * The crop's own size in pixels, so a grid can lay it out before it loads. Computed from the
   * box and the photo's size rather than read off every crop node — see `faceCropSize`.
   */
  cropWidth?: number;
  cropHeight?: number;
  /** Head pose in degrees (`@archive/media/face-pose`); absent for faces detected before EMS reported it. */
  pose?: { pitch: number; yaw: number; roll: number };
  confidence: number;
  personSource?: string;
  /** Why the face's person is in question; `person-faces` fills it for a page. */
  doubt?: FaceDoubtView;
};

type FracBox = { x: number; y: number; width: number; height: number };

/**
 * The pixel size of a face crop, from its box and the photo's stored size: the padded box in
 * the display frame, clamped to the frame, then fitted inside the crop bound without enlarging —
 * what `faceCropRect` and `faceCropTarget` ask EMS for. It answers for every crop without
 * reading one node per face. Undefined when the photo's size or the box is unknown.
 */
export const faceCropSize = (
  box: FracBox | undefined,
  image: { width?: unknown; height?: unknown; angle?: unknown } | undefined,
): { width: number; height: number } | undefined => {
  const rawWidth = image?.width, rawHeight = image?.height;
  if (!box || typeof rawWidth !== 'number' || typeof rawHeight !== 'number' || !(rawWidth > 0 && rawHeight > 0)) return undefined;
  const angle = Number(image?.angle ?? 0);
  const [frameWidth, frameHeight] = angle === 90 || angle === 270 ? [rawHeight, rawWidth] : [rawWidth, rawHeight];
  const x = Math.min(Math.max(box.x, 0), 1), y = Math.min(Math.max(box.y, 0), 1);
  const w = Math.round(Math.min(Math.max(box.width, 0), 1 - x) * frameWidth);
  const h = Math.round(Math.min(Math.max(box.height, 0), 1 - y) * frameHeight);
  const px = Math.round(x * frameWidth), py = Math.round(y * frameHeight);
  const padX = Math.round(w * CROP_PADDING), padY = Math.round(h * CROP_PADDING);
  const left = Math.max(0, px - padX), top = Math.max(0, py - padY);
  const width = Math.min(w + 2 * padX, frameWidth - left);
  const height = Math.min(h + 2 * padY, frameHeight - top);
  if (!(width > 0 && height > 0)) return undefined;
  const scale = Math.min(1, MAX_CROP_DIMENSION / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/** Region attrs read by the curation commands; voices share the person half. */
export type FaceNodeAttrs = {
  fileId?: string;
  confidence?: number;
  personSource?: string;
  personId?: string;
  assignLocked?: boolean;
  /** Head pose in degrees, `@archive/media/face-pose`. */
  pose?: { pitch: number; yaw: number; roll: number } | null;
  /** People a human said this face is not (`person-detach --rematch`); recognition never votes it back to them. */
  rejectedPersonIds?: string[];
  /** On a voice: `voice`. Regions carry none. */
  embeddingType?: string;
};

/**
 * Project a region query row into the shape `person-faces` and `subcluster-faces`
 * both return. Shared so the two cannot drift: the UI keys off `facePath` and
 * hands it straight back to `person-detach`.
 *
 * The source photo is *derived* from the region path rather than looked up —
 * fetching each file node would put the caller back into 1+N. `hasFace` comes
 * from the caller's one batched `faceEmbeddingsOf`.
 */
export const faceView = (entry: { absPath: string; node: { attrs: unknown } }, hasFace: boolean): FaceView => {
  const attrs = entry.node.attrs as FaceNodeAttrs;
  return {
    // The crop is a child file node and may be absent: detect-faces only crops
    // when the image has known dimensions, it lives in the volatile tier, and an
    // older crop may be stored under another name. Callers need a fallback.
    facePath: entry.absPath,
    hasFace,
    filePath: REGION_PATH.exec(entry.absPath)?.[1],
    fileId: attrs.fileId,
    confidence: typeof attrs.confidence === 'number' ? attrs.confidence : 0,
    personSource: attrs.personSource,
    ...(attrs.pose ? { pose: attrs.pose } : {}),
  };
};

/** One voice of a recording as the UI needs it: which recording, and a stretch to play. */
export type VoiceView = {
  voicePath: string;
  /** The recording this was heard in; absent when the node sits somewhere unexpected. */
  filePath?: string;
  fileId?: string;
  /** The voice's longest turn: the sample to play. */
  start: number;
  end: number;
  /** How long the voice speaks in the recording, and in how many turns. */
  talkSeconds: number;
  turnCount: number;
  /** Stable within its file: `speaker_0`, `speaker_1`, … */
  speaker?: string;
  personSource?: string;
  /** The recording's wall clock — what a caption shows. */
  takenAt?: string;
  takenAtUtc?: string;
  /** The recording's kind, so a player knows which rendition to fetch. */
  mimetype?: string;
};

/**
 * Project a speaker query row into the shape `person-voices` returns.
 *
 * The face equivalent hands back a crop URL; there is no picture of a voice, so what stands
 * in for it is the recording plus its longest turn to seek to — enough for the UI to open the
 * existing player where this person speaks, in the context of the recording it came from.
 */
export const voiceView = (entry: { absPath: string; node: { attrs: unknown } }): VoiceView => {
  const attrs = entry.node.attrs as FaceNodeAttrs & { turns?: Span[]; talkSeconds?: number; speaker?: string };
  const turns = Array.isArray(attrs.turns) ? attrs.turns : [];
  const sample = longestTurn(turns) ?? [0, 0];
  return {
    voicePath: entry.absPath,
    filePath: fileOfSpeaker(entry.absPath),
    fileId: attrs.fileId,
    start: sample[0],
    end: sample[1],
    talkSeconds: typeof attrs.talkSeconds === 'number' ? attrs.talkSeconds : 0,
    turnCount: turns.length,
    speaker: attrs.speaker,
    personSource: attrs.personSource,
  };
};

/**
 * Fill in each voice's recording: its kind, for a player to pick the rendition, and its date. By id
 * in one read; a speaker node without a `fileId` is found by the path it sits under instead.
 */
export async function withRecordings(vfs: Vfs, access: Access, voices: VoiceView[]): Promise<VoiceView[]> {
  const fileIds = [...new Set(voices.map((voice) => voice.fileId).filter((id): id is string => !!id))];
  const byId = await vfs.getNodesByIds(access, fileIds);
  const byPath = new Map<string, Record<string, unknown> | undefined>();
  for (const path of new Set(voices.filter((voice) => !voice.fileId && voice.filePath).map((voice) => voice.filePath!))) {
    byPath.set(path, (await vfs.get(access, path).catch(() => undefined))?.attrs as Record<string, unknown> | undefined);
  }
  for (const voice of voices) {
    const attrs = voice.fileId ? byId.get(voice.fileId)?.attrs : voice.filePath ? byPath.get(voice.filePath) : undefined;
    if (!attrs) continue;
    if (typeof attrs.mimetype === 'string') voice.mimetype = attrs.mimetype;
    if (typeof attrs.takenAt === 'string') voice.takenAt = attrs.takenAt;
    if (typeof attrs.takenAtUtc === 'string') voice.takenAtUtc = attrs.takenAtUtc;
  }
  return voices;
}

/**
 * Resolve a person argument: bare ids go under `/people/unknown`, which is where
 * the ids in curation workflows come from. Anything with a slash is a path.
 */
export const personPathOf = (arg: string, cwd: string): string => arg.includes('/') ? resolve(cwd, arg) : `${UNKNOWN_ROOT}/${arg}`;

/** Mark a person's automatically-assigned regions as human-confirmed. */
const promoteFaces = async (vfs: Vfs, access: Access, personId: string): Promise<number> => {
  const faces = await regionsOf(vfs, access, personId);
  let promoted = 0;
  for (const face of faces) {
    const source = (face.node.attrs as { personSource?: string }).personSource;
    if (source === undefined || source === 'manual') continue;
    await vfs.update(access, face.absPath, { attrs: { personSource: 'manual' } });
    promoted++;
  }
  return promoted;
};

export type NameFields = Pick<PersonAttrs, 'name'> & Partial<Omit<PersonAttrs, 'name'>>;

type NamedPerson = { id: string; path: string; slug: string };

/**
 * Give an unnamed person a name and move them into `/people`.
 *
 * Restricted to persons under `/people/unknown` on purpose. Renaming a person
 * who is already named would strand every `<file>/people/<slug>` softlink and
 * every `attrs.relation.peerLink` pointing at them, because those record an
 * absolute path. Auto-created people have neither, which is what makes this
 * move safe. A general rename that repairs the back-references is a separate job.
 */
export const namePerson = async (
  vfs: Vfs,
  access: Access,
  personPath: string,
  fields: NameFields,
  slugOverride?: string,
): Promise<NamedPerson> => {
  const parent = dirname(personPath);
  if (parent !== UNKNOWN_ROOT) {
    throw new Error(
      `${personPath}: only unnamed people under ${UNKNOWN_ROOT} can be named this way ` +
        '(renaming a named person would strand the softlinks pointing at them)',
    );
  }

  const node = await vfs.get<PersonNodeAttrs>(access, personPath, { follow: false });
  if (node.type !== NODE_TYPE_PERSON) throw new Error(`${personPath}: not a person node (is ${node.type})`);

  // Check the derived stem before uniqueSlug, whose empty-base fallback would
  // otherwise quietly park an unsluggable name at /people/person.
  let slug = slugOverride;
  if (!slug) {
    const stem = slugifyName(fields.name);
    if (!stem) throw new Error(`could not derive a slug from name "${fields.name}" — pass an explicit slug`);
    slug = await uniqueSlug(vfs, access, PEOPLE_ROOT, stem);
  }

  // null removes the key (see NodeAttrsUpdate), so a named person keeps no
  // trace of having been auto-created.
  await vfs.update(access, personPath, {
    follow: false,
    attrs: {
      ...fields,
      unnamed: null,
      origin: null,
      createdBy: null,
      representativeFaceId: null,
      createdAt: null,
    },
  });

  await vfs.rename(access, UNKNOWN_ROOT, basename(personPath), PEOPLE_ROOT, slug, { failIfExists: true });

  // Naming is an endorsement of the grouping: a human looked at these faces and
  // said who they are. Promote them to `manual` so `face-reset`, which undoes
  // automatic runs by provenance, cannot strip the faces of a named person.
  await promoteFaces(vfs, access, node.id);

  return { id: node.id, path: `${PEOPLE_ROOT}/${slug}`, slug };
};

const EXPECTED_CHILDREN = new Set([EVENTS_DIR, PARENTS_DIR, CHILDREN_DIR, PARTNERS_DIR, 'homes', 'measurements', 'comments', 'coverPhoto']);

type MergeOptions = {
  dryRun?: boolean;
  /** Merge even when the source has children this does not know how to move. */
  force?: boolean;
};

export type MergeReport = {
  src: string;
  dst: string;
  faces: number;
  /** Voices of recordings, which follow the person like faces do. */
  voices: number;
  events: number;
  relations: number;
  /** Other softlinks to the source — a photographer, an event's writer, an account's person — now at the destination. */
  links: number;
  /** Images that end up showing the surviving person twice — reported, not fixed. */
  conflicts: number;
  skippedChildren: string[];
  deleted: boolean;
  dryRun: boolean;
};

/**
 * Fold `srcPath` into `dstPath`; the destination survives.
 *
 * This is the other half of automatic recognition: when it splits one person
 * across two identities, or a cluster turns out to be someone already named,
 * merging is the correction. Faces are re-pointed by id, so nothing has to know
 * where they live.
 *
 * Relations are recreated on the destination rather than moved, because each is
 * a *pair* of softlinks whose peer records an absolute path — moving one half
 * would leave the other pointing at a person who no longer exists. Every other
 * softlink to the source is re-pointed at the destination.
 */
export const mergePersons = async (
  vfs: Vfs,
  access: Access,
  srcPath: string,
  dstPath: string,
  opts: MergeOptions = {},
): Promise<MergeReport> => {
  const dryRun = !!opts.dryRun;

  const src = await vfs.get<PersonNodeAttrs>(access, srcPath, { follow: false });
  const dst = await vfs.get<PersonNodeAttrs>(access, dstPath, { follow: false });
  if (src.id === dst.id) throw new Error('cannot merge a person into themselves');
  for (const [path, node] of [[srcPath, src], [dstPath, dst]] as const) {
    if (node.type !== NODE_TYPE_PERSON) throw new Error(`${path}: not a person node (is ${node.type})`);
  }

  // Children this does not know how to move would be silently dropped with the
  // source, so refuse rather than lose them.
  const skippedChildren = (await vfs.children(access, srcPath, { follow: false }))
    .map((c) => c.name)
    .filter((name) => !EXPECTED_CHILDREN.has(name));
  if (skippedChildren.length > 0 && !opts.force) {
    throw new Error(`${srcPath}: unexpected children (${skippedChildren.join(', ')}) — pass --force to merge anyway`);
  }

  const report: MergeReport = {
    src: srcPath,
    dst: dstPath,
    faces: 0,
    voices: 0,
    events: 0,
    relations: 0,
    links: 0,
    conflicts: 0,
    skippedChildren,
    deleted: false,
    dryRun,
  };

  // --- faces: the bulk of it, and the reason merge exists ---
  const faces = await regionsOf(vfs, access, src.id);
  const dstFiles = new Set(
    (await regionsOf(vfs, access, dst.id))
      .map((f) => (f.node.attrs as { fileId?: string }).fileId)
      .filter((f): f is string => !!f),
  );

  for (const face of faces) {
    if (dstFiles.has((face.node.attrs as { fileId?: string }).fileId ?? '')) report.conflicts++;
    report.faces++;
    if (dryRun) continue;
    // personSource 'manual': a human decided this, so no later automatic pass
    // may second-guess it.
    await vfs.update(access, face.absPath, {
      attrs: { personId: dst.id, personSource: 'manual', personAssignedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
    });
  }

  // --- voices: a merged person keeps every recording they are heard in ---
  for (const voice of await voicesOf(vfs, access, src.id)) {
    report.voices++;
    if (dryRun) continue;
    await vfs.update(access, voice.absPath, {
      attrs: { personId: dst.id, personSource: 'manual', personAssignedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
    });
  }

  // --- events ---
  let events: { name: string }[] = [];
  try {
    events = await vfs.children(access, `${srcPath}/${EVENTS_DIR}`, { follow: false });
  } catch { /* no events dir */ }
  for (const event of events) {
    report.events++;
    if (dryRun) continue;
    await ensureDir(vfs, access, `${dstPath}/${EVENTS_DIR}`);
    let name = event.name;
    for (let n = 2; await vfs.exists(access, `${dstPath}/${EVENTS_DIR}/${name}`, { follow: false }); n++) name = `${event.name}-${n}`;
    await vfs.rename(access, `${srcPath}/${EVENTS_DIR}`, event.name, `${dstPath}/${EVENTS_DIR}`, name);
  }

  // --- relations ---
  const RELATION_DIRS = [
    { dir: PARENTS_DIR, peerDir: CHILDREN_DIR },
    { dir: CHILDREN_DIR, peerDir: PARENTS_DIR },
    { dir: PARTNERS_DIR, peerDir: PARTNERS_DIR },
  ];
  for (const { dir, peerDir } of RELATION_DIRS) {
    for (const entry of await readRelationDir(vfs, access, srcPath, dir)) {
      if (!entry.target) continue;
      const peerName = basename(entry.target);
      const dstName = basename(dstPath);
      const alreadyThere = await vfs.exists(access, `${dstPath}/${dir}/${peerName}`, { follow: false });

      // A parent edge that would make the destination their own ancestor.
      const cycle = dir === PARENTS_DIR
        ? await wouldCreateCycle(makeCtx(vfs, access), dstPath, entry.target)
        : dir === CHILDREN_DIR
        ? await wouldCreateCycle(makeCtx(vfs, access), entry.target, dstPath)
        : false;

      if (!alreadyThere && !cycle) {
        report.relations++;
        if (!dryRun) {
          await createRelationPair(vfs, access, {
            aLink: `${dstPath}/${dir}/${peerName}`,
            aTarget: entry.target,
            bLink: `${entry.target}/${peerDir}/${dstName}`,
            bTarget: dstPath,
            kind: entry.kind,
            from: entry.from,
            to: entry.to,
          });
        }
      }
      if (!dryRun) await removeRelationPair(vfs, access, entry.linkPath).catch(() => {});
    }
  }

  // --- links: whatever else points at the source follows it to the destination ---
  // Relation halves are the step above's: they carry a peer path, so they are
  // recreated as pairs rather than re-pointed.
  for (const link of await vfs.findLinks(access, srcPath)) {
    if ((link.node.attrs as { relation?: unknown }).relation) continue;
    report.links++;
    if (dryRun) continue;
    await vfs.update(access, link.absPath, { readlink: true, props: { softlink: dstPath } });
  }

  if (!dryRun) {
    await vfs.unlink(access, srcPath, dirname(srcPath), { recursive: true });
    report.deleted = true;
  }

  return report;
};
