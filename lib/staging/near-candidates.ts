/**
 * The index lookups a near check makes: a file's fingerprints and the files whose fingerprints lie
 * near them. Reads only; what is near is `@archive/media/near-duplicates`' to say, and what is
 * written `@archive/staging/duplicates`'.
 *
 * A file's fingerprints are under its `metadata/` (`@archive/media/fingerprints`): `sscd-image`
 * for a picture, `sscd-video-keyframe-<n>` for each of a video's keyframes, embedding nodes both,
 * and `chromaprint` for a recording, a file of its values. The nearest pictures and videos are
 * asked of the embedding index (HNSW over each type's vectors, `findSimilar`), and the files they
 * belong to are two parent links up. Pictures taken within a few seconds of a file's own capture
 * time, read off the capture-time index, are compared too, so a copy the index's approximate walk
 * passes over is still found when it kept its time. Every lookup is batched: a check is about a
 * dozen round trips whatever the archive's size. Chromaprints have no index: a recording is
 * compared with the recordings nearest it in length, read off the mimetype index, one read each.
 */
import { decodeChromaprint } from '@archive/media/chromaprint';
import { lengthWindow, NEAR, parseVector } from '@archive/media/near-duplicates';
import { FINGERPRINT_TYPES } from '@archive/media/fingerprints';
import type { Command } from '@ein/client';
import { NOT_DERIVED } from '@ein/client';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

const METADATA_DIR = 'metadata';
const EXIF_CHILD = 'exif';
const IMAGE_PRINT = FINGERPRINT_TYPES.image;
const KEYFRAME_PREFIX = `${FINGERPRINT_TYPES.video}-keyframe-`;
const CHROMAPRINT_CHILD = FINGERPRINT_TYPES.audio;

/** Chromaprints read at once. */
const READS_AT_ONCE = 8;

/** What kind of fingerprint a file of `mimetype` has, if any a near check compares. */
export type PrintKind = 'image' | 'video' | 'audio';
export const printKindOf = (mimetype: unknown): PrintKind | undefined =>
  typeof mimetype !== 'string'
    ? undefined
    : mimetype.startsWith('image/')
    ? 'image'
    : mimetype.startsWith('video/')
    ? 'video'
    : mimetype.startsWith('audio/')
    ? 'audio'
    : undefined;

/** A kind of print the embedding index holds. */
type VectorKind = Exclude<PrintKind, 'audio'>;

/** The embedding type a kind of print is indexed under. */
const embeddingType = (kind: VectorKind): string => kind === 'image' ? FINGERPRINT_TYPES.image : FINGERPRINT_TYPES.video;

/** A file's fingerprint nodes and its exif node, by id. */
type FilePrints = { image?: string; keyframes: string[]; exif?: string };

/** The fingerprints and exif node of each of `fileIds` that has a `metadata/`: two batched child lookups. */
const printsOf = async (vfs: Vfs, access: Access, fileIds: string[]): Promise<Map<string, FilePrints>> => {
  const found = new Map<string, FilePrints>();
  if (fileIds.length === 0) return found;
  const children = await vfs.getChildLinksByIds(access, [...new Set(fileIds)]);
  const metadataOf = new Map<string, string>();
  for (const [id, links] of children) {
    const metadata = links.find((link) => link.name === METADATA_DIR);
    if (metadata) metadataOf.set(id, metadata.id);
  }
  if (metadataOf.size === 0) return found;
  const below = await vfs.getChildLinksByIds(access, [...metadataOf.values()]);
  for (const [id, metadata] of metadataOf) {
    const prints: FilePrints = { keyframes: [] };
    for (const link of below.get(metadata) ?? []) {
      if (link.name === IMAGE_PRINT) prints.image = link.id;
      else if (link.name.startsWith(KEYFRAME_PREFIX)) prints.keyframes.push(link.id);
      else if (link.name === EXIF_CHILD) prints.exif = link.id;
    }
    found.set(id, prints);
  }
  return found;
};

/** The file each of `printIds` is a fingerprint of: two batched parent lookups. */
const filesOfPrints = async (vfs: Vfs, access: Access, printIds: string[]): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  if (printIds.length === 0) return found;
  const up = await vfs.getParentLinksByIds(access, [...new Set(printIds)]);
  const metadataOf = new Map<string, string>();
  for (const [id, links] of up) if (links[0]) metadataOf.set(id, links[0].parentId);
  const files = await vfs.getParentLinksByIds(access, [...new Set(metadataOf.values())]);
  for (const [print, metadata] of metadataOf) {
    const link = files.get(metadata)?.find((each) => each.name === METADATA_DIR);
    if (link) found.set(print, link.parentId);
  }
  return found;
};

/** The vectors of `ids`, of embedding type `type`, as numbers and as the text the index takes. */
const vectorsOf = async (vfs: Vfs, access: Access, type: string, ids: string[]): Promise<Map<string, { vector: number[]; bytes: Uint8Array }>> => {
  const found = new Map<string, { vector: number[]; bytes: Uint8Array }>();
  if (ids.length === 0) return found;
  for (const [id, bytes] of await vfs.getVectors(access, type, [...new Set(ids)])) {
    const vector = parseVector(bytes);
    if (vector) found.set(id, { vector, bytes });
  }
  return found;
};

/** A file's fingerprints as a near check compares them: one picture's, or a video's keyframes. */
type OwnPrints = { kind: VectorKind; vectors: { vector: number[]; bytes: Uint8Array }[] };

/** The fingerprints of the file `id`, of `kind`; undefined when it has none yet. */
export const ownPrints = async (vfs: Vfs, access: Access, id: string, kind: VectorKind): Promise<OwnPrints | undefined> => {
  const prints = (await printsOf(vfs, access, [id])).get(id);
  const ids = kind === 'image' ? (prints?.image ? [prints.image] : []) : prints?.keyframes ?? [];
  if (ids.length === 0) return undefined;
  const vectors = await vectorsOf(vfs, access, embeddingType(kind), ids);
  const ordered = ids.flatMap((each) => vectors.get(each) ?? []);
  return ordered.length > 0 ? { kind, vectors: ordered } : undefined;
};

/** A candidate file and its fingerprints, for the rules to compare with the checked file's. */
type Candidate = { id: string; vectors: number[][] };

/**
 * The files whose fingerprints may lie near `own`, as `access` reads them, but `self`: the index's
 * nearest to each of its prints (`NEAR.candidates` of them, at the rules' floor), the files with a
 * capture time within `NEAR.windowSeconds` of `takenAtUtc`, and `extra`. Each with its
 * fingerprints of the same kind, read in one batch.
 */
export const nearCandidates = async (
  vfs: Vfs,
  access: Access,
  self: string,
  own: OwnPrints,
  options: { takenAtUtc?: string; extra?: string[] } = {},
): Promise<Candidate[]> => {
  const type = embeddingType(own.kind);
  const floor = own.kind === 'image' ? NEAR.image : NEAR.video;
  const hits = (await Promise.all(own.vectors.map((print) => vfs.findSimilar(access, type, print.bytes, NEAR.candidates, floor)))).flat();
  const byPrint = await filesOfPrints(vfs, access, hits.map((hit) => hit.id));
  const ids = new Set<string>([...byPrint.values()]);

  if (options.takenAtUtc !== undefined) {
    const at = Date.parse(options.takenAtUtc);
    if (!Number.isNaN(at)) {
      // In the form capture times are stored in, whole seconds and `Z`, so they compare as text.
      const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
      const rows = await vfs.query(access, {
        types: ['file'],
        where: [
          { ref: 'takenAtUtc', op: 'gte', value: iso(at - NEAR.windowSeconds * 1000) },
          { ref: 'takenAtUtc', op: 'lte', value: iso(at + NEAR.windowSeconds * 1000) },
          NOT_DERIVED,
        ],
        orderBy: { ref: 'takenAtUtc', dir: 'asc' },
        limit: NEAR.windowRows,
      });
      for (const row of rows) ids.add(row.id);
    }
  }
  for (const id of options.extra ?? []) ids.add(id);
  ids.delete(self);
  if (ids.size === 0) return [];

  const prints = await printsOf(vfs, access, [...ids]);
  const wanted = new Map<string, string[]>();
  for (const [id, each] of prints) {
    const list = own.kind === 'image' ? (each.image ? [each.image] : []) : each.keyframes;
    if (list.length > 0) wanted.set(id, list);
  }
  const vectors = await vectorsOf(vfs, access, type, [...wanted.values()].flat());
  return [...wanted].flatMap(([id, list]) => {
    const found = list.flatMap((print) => {
      const vector = vectors.get(print)?.vector;
      return vector ? [vector] : [];
    });
    return found.length > 0 ? [{ id, vectors: found }] : [];
  });
};

/** The fraction of a second each of `fileIds` was taken at, from its exif node's raw tags, when it has one. */
export const subSecondsOf = async (vfs: Vfs, access: Access, fileIds: string[]): Promise<Map<string, string>> => {
  const found = new Map<string, string>();
  const prints = await printsOf(vfs, access, fileIds);
  const exifOf = new Map([...prints].flatMap(([id, each]) => each.exif ? [[each.exif, id] as const] : []));
  if (exifOf.size === 0) return found;
  for (const [exif, node] of await vfs.getNodesByIds(access, [...exifOf.keys()])) {
    const raw = (node.attrs as { raw?: Record<string, unknown> }).raw;
    const value = raw?.SubSecTimeOriginal;
    if (value !== undefined && value !== null && String(value).trim() !== '') found.set(exifOf.get(exif)!, String(value).trim());
  }
  return found;
};

/**
 * The recordings `access` reads that last about as long as `duration` seconds, but `self`: of at
 * most `NEAR.lengthRows` within the lengths `sameLength` allows, the `NEAR.recordings` nearest in
 * length.
 */
export const recordingsLike = async (vfs: Vfs, access: Access, self: string, duration: number): Promise<string[]> => {
  const { from, to } = lengthWindow(duration);
  const rows = await vfs.query(access, {
    types: ['file'],
    where: [{ ref: 'mimetype', op: 'prefix', value: 'audio/' }, { ref: 'duration', op: 'gte', value: from }, { ref: 'duration', op: 'lte', value: to }, NOT_DERIVED],
    limit: NEAR.lengthRows,
  });
  return rows
    .filter((row) => row.id !== self)
    .map((row) => ({ id: row.id, apart: Math.abs(Number((row.node.attrs as { duration?: unknown }).duration) - duration) }))
    .sort((a, b) => a.apart - b.apart || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, NEAR.recordings)
    .map((each) => each.id);
};

/** The chromaprint of each of `files` that has one, by id: one read of `<path>/metadata/chromaprint` each, a few at a time. */
export const chromaprintsOf = async (vfs: Vfs, access: Access, files: { id: string; path: string }[]): Promise<Map<string, Uint32Array>> => {
  const found = new Map<string, Uint32Array>();
  let next = 0;
  const read = async () => {
    while (next < files.length) {
      const { id, path } = files[next++];
      const handle = await vfs.open(access, `${path}/${METADATA_DIR}/${CHROMAPRINT_CHILD}`).catch(() => undefined);
      if (!handle) continue;
      try {
        const print = decodeChromaprint(new Uint8Array(await new Response(handle.readable).arrayBuffer()));
        if (print.length > 0) found.set(id, print);
      } finally {
        await handle.close();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, files.length) }, read));
  return found;
};

/**
 * The files `access` reads that may lie near the file `id`, of `kind`, but itself: for a picture or
 * a video the index's nearest to each of its prints, for a recording those about as long
 * (`duration`, without which there are none). For the reverse check, which takes those staged in an
 * inbox.
 */
export const nearFilesOf = async (vfs: Vfs, access: Access, id: string, kind: PrintKind, duration?: number): Promise<string[]> => {
  if (kind === 'audio') return duration === undefined ? [] : await recordingsLike(vfs, access, id, duration);
  const own = await ownPrints(vfs, access, id, kind);
  if (!own) return [];
  const floor = kind === 'image' ? NEAR.image : NEAR.video;
  const hits = (await Promise.all(own.vectors.map((print) => vfs.findSimilar(access, embeddingType(kind), print.bytes, NEAR.candidates, floor)))).flat();
  return [...new Set((await filesOfPrints(vfs, access, hits.map((hit) => hit.id))).values())].filter((each) => each !== id);
};
