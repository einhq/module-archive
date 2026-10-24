/**
 * A label's model, read from and written to its tag directory (`/archive/tags/<label>`), and the
 * VFS work around the classifier (`@archive/labels/classifier`): which pictures carry the label,
 * a random sample of those that do not, and what is left out of its suggestions.
 *
 * - **Positives** are the picture vectors of the files the label is on, each file weighing 1, and
 *   of the members of the albums it is on. An album's members share the weight of one labeling,
 *   `1/√n` each, so a 400-picture album counts more than one file but not 400 times more. A
 *   video's keyframes share their file's weight.
 * - **Negatives** are a random sample of the archive's pictures, one vector each, plus the vectors of what
 *   was rejected for the label (`attrs.rejected`, node ids of files and albums) at
 *   `REJECTED_WEIGHT`. Half the sample trains; the other half sets the floor, so the floor is
 *   measured on pictures the direction never saw.
 * - **Suggestions** are the pictures at or above the floor that neither carry the label, nor sit
 *   in an album that does, nor were rejected for it.
 * - **A vocabulary word** (`@archive/labels/vocabulary`) that is not used enough to measure is
 *   asked by its words instead: the prompt through the picture embedder's text tower, from
 *   `VOCABULARY_FLOOR`. Such a model may sit on a tag directory that links nothing yet, which is
 *   not a label until something carries it.
 */
import { dirname } from '@std/path';
import type { Command, StepPhase } from '@ein/client';
import { TAGS_ROOT } from '@ein/paths';
import { albumMembers, albumsHolding } from '@archive/media/album-members';
import { fileOfPictureVector, PICTURE_DIR, pictureEmbeddingType } from '@archive/media/embedding-types';
import { embedPictureQuery } from '@ems/text-embedding';
import { crossValidate, dot, floorAt, passingOf, type Sample, seededRandom, train, unit } from '@archive/labels/classifier';
import type { LabelModel, LabelModelReason, LabelModelSummary } from '@archive/labels/api';

/** Sampled negatives that train the direction, and as many again that set its floor. */
const NEGATIVES = 1500;
/**
 * At most this many positive vectors train, drawn at random from all of them: training costs
 * every sample every iteration, and a label on hundreds of albums would otherwise take minutes of
 * the server's thread for no better a direction.
 */
const MAX_POSITIVES = 1000;
/** Rows read at each random cursor while sampling: few, so one album's run of pictures is not most of a sample. */
const PER_CURSOR = 4;
/** Cursors read at once while sampling, and how many batches in a row may find nothing new before it stops. */
const CURSOR_BATCH = 25;
const IDLE_BATCHES = 3;
/** A rejected picture counts as this many sampled ones: someone said it is not the label. */
const REJECTED_WEIGHT = 3;
/**
 * The share of the pictures not carrying a label that may sit above its floor: the most a label
 * suggests, as a share of the archive. The sample it is measured on also holds pictures that are
 * the label without carrying it, so this caps how many are suggested rather than how many are
 * wrong. At least `LEAST_PASSING` sampled pictures pass, so a small archive's floor is not its
 * single best unlabeled picture.
 */
const FP_RATE = 0.005;
const LEAST_PASSING = 3;
/** Cross-validation folds: each is a training of its own, so few. */
const FOLDS = 4;
/** At least this many pictures, from at least two files or albums, before cross-validation is tried. */
const MIN_MEASURED_PICTURES = 6;
/** Below either, held-out pictures were not found again: what the label names is not what the pictures show. */
const MIN_AUC = 0.9;
const MIN_RECALL = 0.2;
/**
 * The cosine from which a picture counts as showing a vocabulary word's prompt. Higher than
 * search's floor: a suggestion has no query of the reader's own to excuse a weak match.
 */
const VOCABULARY_FLOOR = 0.12;
/**
 * A model is trained again after this long, whatever changed: the archive it is measured on has
 * grown. Seconds of the server's thread per label, so not daily.
 */
const REFRESH_AFTER_MS = 7 * 24 * 3600 * 1000;
/** Matches counted for `LabelModel.matches`. */
const MATCH_CAP = 1000;
/** Albums whose members are read at once. */
const ALBUM_CONCURRENCY = 16;
/** Ids per batched VFS call. */
const IDS_PER_CALL = 1000;

/** The attrs a tag directory carries beside its links. */
type TagDirAttrs = { model?: LabelModel; rejected?: string[] };

/** A label's tag directory. */
const tagDirOf = (label: string): string => `${TAGS_ROOT}/${label}`;

/** The label a path names when it is a tag directory, else undefined. */
const labelOfPath = (path: string): string | undefined => dirname(path) === TAGS_ROOT && path.length > TAGS_ROOT.length + 1 ? path.slice(TAGS_ROOT.length + 1) : undefined;

const isPicture = (attrs: Record<string, unknown>): boolean => {
  const mimetype = typeof attrs.mimetype === 'string' ? attrs.mimetype : '';
  return mimetype.startsWith('image/') || mimetype.startsWith('video/');
};

const chunks = <T>(items: T[], size = IDS_PER_CALL): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** FNV-1a over the strings, as hex: what a model was trained on, cheaply compared. */
const fingerprint = (parts: string[]): string => {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) hash = Math.imul(hash ^ part.charCodeAt(i), 16777619);
    hash = Math.imul(hash ^ 10, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** What a label is on: the link targets in its tag directory, split by what they are. */
type Carriers = { files: { path: string; id: string }[]; albums: { path: string; id: string }[]; targets: string[] };

const carriersOf = async (cmd: Command, tagDir: string): Promise<Carriers> => {
  const targets = (await cmd.sys.vfs.children(cmd.access, tagDir))
    .map((entry) => entry.node.props.softlink)
    .filter((target): target is string => typeof target === 'string')
    .sort();
  const carriers: Carriers = { files: [], albums: [], targets };
  for (const batch of chunks(targets, 50)) {
    const nodes = await Promise.all(batch.map((path) => cmd.sys.vfs.get(cmd.access, path).then((node) => ({ path, node }), () => undefined)));
    for (const found of nodes) {
      if (!found) continue;
      if (found.node.type === 'album') carriers.albums.push({ path: found.path, id: found.node.id });
      else if (found.node.type === 'file' && isPicture(found.node.attrs)) carriers.files.push({ path: found.path, id: found.node.id });
    }
  }
  return carriers;
};

/**
 * How models are trained. It is part of every signature, so a change to the training — the
 * sample, the sizes, the floor — is raised here and every kept model reads as stale.
 */
const RECIPE = 2;

/** The signature of what a model is trained on: the recipe, the label's link targets, its rejections, and a vocabulary word's prompt. */
const signatureOf = (targets: string[], rejected: string[], prompt?: string): string =>
  fingerprint([`recipe ${RECIPE}`, ...targets, '|', ...rejected.toSorted(), '|', prompt ?? '']);

/** Each file's picture vector ids (`<file>/metadata/picture/*`), by file id: three levels of batched child lookups. */
const pictureVectorIds = async (cmd: Command, fileIds: string[]): Promise<Map<string, string[]>> => {
  const step = async (parents: Map<string, string>, name?: string): Promise<Map<string, string>> => {
    const next = new Map<string, string>();
    for (const batch of chunks([...parents.keys()])) {
      for (const [id, children] of await cmd.sys.vfs.getChildLinksByIds(cmd.access, batch)) {
        for (const child of children) if (name === undefined || child.name === name) next.set(child.id, parents.get(id)!);
      }
    }
    return next;
  };
  const metadata = await step(new Map(fileIds.map((id) => [id, id])), 'metadata');
  const pictureDirs = await step(metadata, PICTURE_DIR);
  const vectors = await step(pictureDirs);
  const byFile = new Map<string, string[]>();
  for (const [vectorId, fileId] of vectors) byFile.set(fileId, [...(byFile.get(fileId) ?? []), vectorId]);
  return byFile;
};

/** The vectors behind ids, unit length, in one embedding type; ids without one are absent. */
const readVectors = async (cmd: Command, type: string, ids: string[]): Promise<Map<string, Float32Array>> => {
  const out = new Map<string, Float32Array>();
  const decoder = new TextDecoder();
  for (const batch of chunks(ids)) {
    for (const [id, bytes] of await cmd.sys.vfs.getVectors(cmd.access, type, batch)) out.set(id, unit(JSON.parse(decoder.decode(bytes)) as number[]));
  }
  return out;
};

/** The embedding type most of these vector nodes are in: the one a label's model is learned in. */
const typeOf = async (cmd: Command, vectorIds: string[]): Promise<string | undefined> => {
  const counts = new Map<string, number>();
  for (const batch of chunks(vectorIds)) {
    for (const node of (await cmd.sys.vfs.getNodesByIds(cmd.access, batch)).values()) {
      const type = node.attrs.embeddingType;
      if (typeof type === 'string') counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * `count` picture files at random, none of `exclude` (file ids). A file's `sha256` is uniform, so
 * the files just after a random hash value, in the index on it, are a uniform draw; each cursor
 * reads `PER_CURSOR` of them. Node ids would not do: they follow when a node was made, and a
 * backfill makes most vectors in a few days.
 */
const sampleFiles = async (cmd: Command, count: number, exclude: ReadonlySet<string>, random: () => number): Promise<string[]> => {
  const hex = () => Array.from({ length: 16 }, () => Math.floor(random() * 16).toString(16)).join('');
  const ids = new Set<string>();
  const attempts = Math.ceil(count / PER_CURSOR) * 3;
  let idle = 0;
  for (let tried = 0; ids.size < count && tried < attempts && idle < IDLE_BATCHES; tried += CURSOR_BATCH) {
    const pages = await Promise.all(Array.from({ length: CURSOR_BATCH }, () =>
      cmd.sys.vfs.query(cmd.access, {
        types: ['file'],
        // Originals: a rendition has the picture's look but no vector of its own.
        where: [{ ref: 'sourceId', op: 'missing' }],
        orderBy: { ref: 'sha256', dir: 'asc' },
        after: { value: hex(), id: '' },
        limit: PER_CURSOR,
      })));
    const before = ids.size;
    for (const entry of pages.flat()) if (isPicture(entry.node.attrs) && !exclude.has(entry.id)) ids.add(entry.id);
    // An archive with fewer pictures than the sample wants soon has all of them.
    idle = ids.size === before ? idle + 1 : 0;
  }
  return [...ids].slice(0, count);
};

/** The picture files an album holds, by id. */
const albumPictures = async (cmd: Command, path: string): Promise<{ path: string; id: string }[]> => {
  try {
    const { members } = await albumMembers(cmd, path);
    return members.filter((member) => member.node.type === 'file' && isPicture(member.node.attrs)).map((member) => ({ path: member.path, id: member.node.id }));
  } catch {
    // An album gone or unreadable since it was labeled holds nothing here.
    return [];
  }
};

/** Files weighed as labeling them weighs: 1 for a file, `1/√n` for each of an album's n. */
type Weighed = { id: string; path: string; weight: number; group: string };

const weighCarriers = async (cmd: Command, files: { path: string; id: string }[], albums: { path: string; id: string }[]): Promise<Weighed[]> => {
  const byId = new Map<string, Weighed>();
  const held: { album: { path: string; id: string }; pictures: { path: string; id: string }[] }[] = [];
  for (const batch of chunks(albums, ALBUM_CONCURRENCY)) {
    held.push(...await Promise.all(batch.map(async (album) => ({ album, pictures: await albumPictures(cmd, album.path) }))));
  }
  for (const { album, pictures } of held) {
    for (const picture of pictures) {
      const weight = 1 / Math.sqrt(pictures.length);
      const known = byId.get(picture.id);
      if (!known || known.weight < weight) byId.set(picture.id, { ...picture, weight, group: album.path });
    }
  }
  // A file labeled itself counts as itself, whatever album it is also in.
  for (const file of files) byId.set(file.id, { ...file, weight: 1, group: file.path });
  return [...byId.values()];
};

/** A vector to train on, before it is read: each vector a share of its file's weight. */
type Slot = { id: string; weight: number; group: string };

const slotsOf = (weighed: Weighed[], vectorIds: Map<string, string[]>, scale = 1): Slot[] =>
  weighed.flatMap((file) => {
    const own = vectorIds.get(file.id) ?? [];
    return own.map((id) => ({ id, weight: scale * file.weight / own.length, group: file.group }));
  });

/** The slots whose vectors were read, as samples. */
const samplesOf = (slots: Slot[], vectors: Map<string, Float32Array>, positive: boolean): Sample[] =>
  slots.flatMap((slot) => {
    const vector = vectors.get(slot.id);
    return vector ? [{ vector, positive, weight: slot.weight, group: slot.group }] : [];
  });

const summaryOf = (label: string, model: LabelModel, rejected: string[], signature: string): LabelModelSummary => {
  const { weights: _, ...rest } = model;
  const old = Date.now() - Date.parse(model.trainedAt) > REFRESH_AFTER_MS;
  return { label, ...rest, rejected: rejected.length, stale: model.signature !== signature || old };
};

/** The model kept for a label, with its summary; undefined when there is no tag directory or no model. */
export const readLabelModel = async (cmd: Command, label: string): Promise<{ model: LabelModel; summary: LabelModelSummary } | undefined> => {
  const tagDir = tagDirOf(label);
  const node = await cmd.sys.vfs.get<TagDirAttrs>(cmd.access, tagDir).catch(() => undefined);
  const model = node?.attrs.model;
  if (!model) return undefined;
  const rejected = node.attrs.rejected ?? [];
  const { targets } = await carriersOf(cmd, tagDir);
  return { model, summary: summaryOf(label, model, rejected, signatureOf(targets, rejected, model.prompt)) };
};

/** The vector as the embedding store reads one. */
const vectorBytes = (weights: ArrayLike<number>): Uint8Array => new TextEncoder().encode(JSON.stringify(Array.from(weights)));

/** The files above a floor in a direction, by path, with their best score. */
const filesAbove = async (cmd: Command, type: string, weights: ArrayLike<number>, floor: number, limit: number): Promise<{ files: Map<string, number>; capped: boolean }> => {
  const hits = await cmd.sys.vfs.findSimilar(cmd.access, type, vectorBytes(weights), limit, floor);
  const paths = hits.length === 0 ? new Map<string, string[]>() : await cmd.sys.vfs.resolveIdPaths(cmd.access, hits.map((hit) => hit.id));
  const files = new Map<string, number>();
  for (const hit of hits) {
    for (const vectorPath of paths.get(hit.id) ?? []) {
      const file = fileOfPictureVector(vectorPath);
      if (file && hit.similarity > (files.get(file) ?? -Infinity)) files.set(file, hit.similarity);
    }
  }
  return { files, capped: hits.length >= limit };
};

const stamp = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Learn a label from its pictures and keep the model on its tag directory. Answers why not when
 * there is nothing to learn from; a model is kept even when the label is not learnable, so the
 * page can say how it measured. A vocabulary word comes with its `prompt`, and is asked by it
 * while it has too few pictures to measure; its tag directory is made when it has none.
 */
export const trainLabel = async (
  cmd: Command,
  label: string,
  prompt?: string,
  phase: StepPhase = async () => {},
): Promise<{ model: LabelModel; summary: LabelModelSummary } | { reason: LabelModelReason }> => {
  const tagDir = tagDirOf(label);
  if (prompt !== undefined && !await cmd.sys.vfs.exists(cmd.access, tagDir)) await cmd.sys.vfs.ensure(cmd.access, 'directory', TAGS_ROOT, label);
  const node = await cmd.sys.vfs.get<TagDirAttrs>(cmd.access, tagDir);
  const rejected = node.attrs.rejected ?? [];
  const carriers = await carriersOf(cmd, tagDir);

  await phase(`${carriers.files.length} files and ${carriers.albums.length} albums carry it`);
  const positives = await weighCarriers(cmd, carriers.files, carriers.albums);
  await phase(`${positives.length} pictures weighed`);
  const rejectedNodes = rejected.length === 0 ? new Map() : await cmd.sys.vfs.getNodesByIds(cmd.access, rejected);
  const rejectedFiles: { path: string; id: string }[] = [];
  const rejectedAlbums: { path: string; id: string }[] = [];
  const rejectedPaths = rejected.length === 0 ? new Map<string, string[]>() : await cmd.sys.vfs.resolveIdPaths(cmd.access, rejected);
  for (const [id, rejectedNode] of rejectedNodes) {
    const path = rejectedPaths.get(id)?.[0];
    if (!path) continue;
    if (rejectedNode.type === 'album') rejectedAlbums.push({ path, id });
    else if (rejectedNode.type === 'file' && isPicture(rejectedNode.attrs)) rejectedFiles.push({ path, id });
  }
  const positiveIds = new Set(positives.map((file) => file.id));
  const rejectedWeighed = (await weighCarriers(cmd, rejectedFiles, rejectedAlbums)).filter((file) => !positiveIds.has(file.id));

  const vectorIds = await pictureVectorIds(cmd, [...positives, ...rejectedWeighed].map((file) => file.id));
  const positiveVectorIds = positives.flatMap((file) => vectorIds.get(file.id) ?? []);
  const pictured = positives.filter((file) => vectorIds.has(file.id));
  const excluded = new Set([...positives, ...rejectedWeighed].map((file) => file.path));
  if (prompt !== undefined && (positiveVectorIds.length < MIN_MEASURED_PICTURES || new Set(pictured.map((file) => file.group)).size < 2)) {
    return await trainFromWords(cmd, label, prompt, {
      pictures: positiveVectorIds.length,
      groups: new Set(pictured.map((file) => file.group)).size,
      excluded,
      signature: signatureOf(carriers.targets, rejected, prompt),
      rejected,
    });
  }
  const type = await typeOf(cmd, positiveVectorIds);
  if (!type) return { reason: 'no-pictures' };
  await phase(`${positiveVectorIds.length} vectors found`);

  const random = seededRandom(label);
  // One vector of each sampled file, so a video's keyframes do not crowd the sample.
  const sampledFiles = await sampleFiles(cmd, Math.ceil(NEGATIVES * 2.2), new Set([...positives, ...rejectedWeighed].map((file) => file.id)), random);
  const sampledVectorIds = await pictureVectorIds(cmd, sampledFiles);
  const sampled = [...sampledVectorIds.values()].map((own) => own[Math.floor(random() * own.length)]).slice(0, NEGATIVES * 2);
  await phase(`${sampled.length} sampled`);
  // Only the positives that train are read: a label on hundreds of albums has tens of thousands.
  const allPositives = slotsOf(positives, vectorIds);
  const chosen = allPositives.length <= MAX_POSITIVES
    ? allPositives
    : allPositives.map((slot) => ({ slot, key: random() })).sort((a, b) => a.key - b.key).slice(0, MAX_POSITIVES).map(({ slot }) => slot);
  const rejectedSlots = slotsOf(rejectedWeighed, vectorIds, REJECTED_WEIGHT);
  const vectors = await readVectors(cmd, type, [...chosen, ...rejectedSlots].map((slot) => slot.id).concat(sampled));
  await phase(`${vectors.size} vectors read`);
  const positiveSamples = samplesOf(chosen, vectors, true);
  if (positiveSamples.length === 0) return { reason: 'no-pictures' };
  const sampledVectors = sampled.map((id) => vectors.get(id)).filter((vector): vector is Float32Array => vector !== undefined);
  const half = Math.ceil(sampledVectors.length / 2);
  const negatives: Sample[] = [
    ...sampledVectors.slice(0, half).map((vector) => ({ vector, positive: false, weight: 1 })),
    ...samplesOf(rejectedSlots, vectors, false),
  ];
  const calibration = sampledVectors.slice(half);
  if (negatives.length === 0 || calibration.length === 0) return { reason: 'no-pictures' };

  const samples = [...positiveSamples, ...negatives];
  const groups = new Set(allPositives.map((sample) => sample.group)).size;
  let measured: LabelModel['measured'];
  if (positiveSamples.length >= MIN_MEASURED_PICTURES && new Set(positiveSamples.map((sample) => sample.group)).size >= 2) {
    measured = await crossValidate(samples, { folds: FOLDS, fpRate: FP_RATE, leastPassing: LEAST_PASSING, random });
  }
  await phase('cross-validated');
  const learnable = measured !== undefined && measured.auc >= MIN_AUC && measured.recall >= MIN_RECALL;

  const direction = await train(samples);
  const floor = floorAt(calibration.map((vector) => dot(direction, vector)), passingOf(calibration.length, FP_RATE, LEAST_PASSING));
  const weights = Array.from(direction, (value) => Math.round(value * 1e6) / 1e6);
  await phase('trained');

  // The matches the page would offer: above the floor, minus what carries the label or was rejected.
  const above = await filesAbove(cmd, type, weights, floor, MATCH_CAP + excluded.size);
  const matches = [...above.files.keys()].filter((path) => !excluded.has(path));
  await phase(`${matches.length} matches`);

  const model: LabelModel = {
    embeddingType: type,
    source: 'examples',
    weights,
    floor: Math.round(floor * 1e6) / 1e6,
    pictures: allPositives.length,
    groups,
    negatives: negatives.length,
    ...(measured ? { measured: { auc: round3(measured.auc), recall: round3(measured.recall), folds: measured.folds } } : {}),
    learnable,
    ...(learnable ? {} : { reason: measured ? 'not-visual' as const : 'too-few-examples' as const }),
    matches: Math.min(matches.length, MATCH_CAP),
    matchesCapped: matches.length >= MATCH_CAP || above.capped,
    signature: signatureOf(carriers.targets, rejected),
    trainedAt: stamp(),
  };
  await cmd.sys.vfs.update<TagDirAttrs>(cmd.access, tagDir, { attrs: { model } });
  return { model, summary: summaryOf(label, model, rejected, model.signature) };
};

/** A vocabulary word's model: its prompt's text vector, from `VOCABULARY_FLOOR`. */
const trainFromWords = async (
  cmd: Command,
  label: string,
  prompt: string,
  known: { pictures: number; groups: number; excluded: Set<string>; signature: string; rejected: string[] },
): Promise<{ model: LabelModel; summary: LabelModelSummary }> => {
  const { bytes, producer } = await embedPictureQuery(cmd, prompt);
  const type = pictureEmbeddingType(producer);
  if (!type) throw new Error(`no embedding type for picture embedder "${producer}"`);
  const weights = Array.from(unit(JSON.parse(new TextDecoder().decode(bytes)) as number[]), (value) => Math.round(value * 1e6) / 1e6);
  const above = await filesAbove(cmd, type, weights, VOCABULARY_FLOOR, MATCH_CAP + known.excluded.size);
  const matches = [...above.files.keys()].filter((path) => !known.excluded.has(path));
  const model: LabelModel = {
    embeddingType: type,
    source: 'vocabulary',
    prompt,
    weights,
    floor: VOCABULARY_FLOOR,
    pictures: known.pictures,
    groups: known.groups,
    negatives: 0,
    learnable: true,
    matches: Math.min(matches.length, MATCH_CAP),
    matchesCapped: matches.length >= MATCH_CAP || above.capped,
    signature: known.signature,
    trainedAt: stamp(),
  };
  await cmd.sys.vfs.update<TagDirAttrs>(cmd.access, tagDirOf(label), { attrs: { model } });
  return { model, summary: summaryOf(label, model, known.rejected, model.signature) };
};

/**
 * Drop the vocabulary models that no longer name a word of the vocabulary in use (`words`), from
 * tag directories nothing carries: what an archive in another language was offered. Returns the
 * labels dropped.
 */
export const dropStaleWords = async (cmd: Command, words: ReadonlySet<string>): Promise<string[]> => {
  const dropped: string[] = [];
  let entries;
  try {
    entries = await cmd.sys.vfs.children(cmd.access, TAGS_ROOT);
  } catch {
    return dropped;
  }
  for (const entry of entries) {
    const model = entry.node.attrs.model as LabelModel | undefined;
    if (model?.source !== 'vocabulary' || entry.childCount > 0 || words.has(entry.name)) continue;
    await cmd.sys.vfs.update<TagDirAttrs>(cmd.access, tagDirOf(entry.name), { attrs: { model: null } });
    dropped.push(entry.name);
  }
  return dropped;
};

/** Add or take back rejections: node ids of files or albums that are not the label. Returns how many the label has. */
export const setRejected = async (cmd: Command, label: string, paths: string[], rejecting: boolean): Promise<number> => {
  const tagDir = tagDirOf(label);
  const node = await cmd.sys.vfs.get<TagDirAttrs>(cmd.access, tagDir);
  const ids = await Promise.all(paths.map(async (path) => (await cmd.sys.vfs.get(cmd.access, path)).id));
  const current = new Set(node.attrs.rejected ?? []);
  for (const id of ids) rejecting ? current.add(id) : current.delete(id);
  await cmd.sys.vfs.update<TagDirAttrs>(cmd.access, tagDir, { attrs: { rejected: [...current] } });
  return current.size;
};

/**
 * A label as a question for `search --like`: its direction and floor, and which answers to leave
 * out — files that carry the label or sit in an album that does, albums that carry it, and what
 * was rejected for it. Undefined when `path` is not a tag directory; throws when the label has no
 * model yet.
 */
export type LabelLike = {
  label: string;
  type: string;
  vector: Uint8Array;
  floor: number;
  /** Of these file paths, the ones that are no answer. */
  excludedFiles: (paths: string[]) => Promise<Set<string>>;
  /** Album paths that are no answer. */
  excludedAlbums: Set<string>;
};

export const labelLike = async (cmd: Command, path: string): Promise<LabelLike | undefined> => {
  const label = labelOfPath(path);
  if (!label) return undefined;
  const node = await cmd.sys.vfs.get<TagDirAttrs>(cmd.access, path);
  const model = node.attrs.model;
  if (!model) throw new Error(`label '${label}' has no model yet; run label-model train ${label}`);
  const rejected = node.attrs.rejected ?? [];
  const [carriers, rejectedPaths] = await Promise.all([
    carriersOf(cmd, path),
    rejected.length === 0 ? new Map<string, string[]>() : cmd.sys.vfs.resolveIdPaths(cmd.access, rejected),
  ]);
  const rejectedSet = new Set([...rejectedPaths.values()].flat());
  const labeledFiles = new Set(carriers.files.map((file) => file.path));
  const labeledAlbums = new Set(carriers.albums.map((album) => album.path));
  return {
    label,
    type: model.embeddingType,
    vector: vectorBytes(model.weights),
    floor: model.floor,
    excludedFiles: async (paths) => {
      const out = new Set(paths.filter((file) => labeledFiles.has(file) || rejectedSet.has(file)));
      if (labeledAlbums.size > 0) { for (const file of (await albumsHolding(cmd, paths, labeledAlbums)).keys()) out.add(file); }
      return out;
    },
    excludedAlbums: new Set([...labeledAlbums, ...rejectedSet]),
  };
};
