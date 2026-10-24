/**
 * Online face → person assignment: the incremental half of face recognition.
 *
 * When a face is detected, its embedding is searched against every other face.
 * A clear match to a face that already belongs to someone reuses that person;
 * otherwise a new unnamed person is minted for it. That is what makes the
 * system self-reinforcing — the second photo of a stranger finds the first,
 * sees it now carries a personId, and joins it instead of creating a rival
 * identity. Naming that person later is one action for the whole run of photos.
 *
 * The batch counterpart is `cluster-faces`, which sees the whole graph at once
 * and is the better tool for a backfill; this path sees one image and must
 * decide immediately. Both share the voting logic in @archive/media/face-cluster, so
 * they cannot drift apart.
 *
 * Faces are regions with an `embedding` child (@archive/media/regions). The search runs
 * over embeddings, each hit is mapped to its region in one batched parent lookup,
 * and the person is read from and written to the region. Votes are keyed by
 * embedding id, since that is what the search returns.
 */

import type { Command } from '@ein/client';
import { toText } from '@std/streams/to-text';
import { type FaceEdge, propagateLabels } from '@archive/media/face-cluster';
import { type Dims, displayDims, toPixels } from '@archive/media/orientation';
import { createUnnamedPerson } from '@archive/people/person';
import { FACE_EMBEDDING_TYPE, faceEmbeddingPathOf, faceEmbeddingsOfRegions, type RegionAttrs, regionsOfEmbeddings, regionsPathOf } from '@archive/media/regions';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

type FaceAttrs = RegionAttrs;

export type AssignOptions = {
  /** Min cosine similarity for a neighbour's vote to count. */
  voteThreshold: number;
  /** Min winning vote weight to attach to an existing person. */
  attachThreshold: number;
  /** Winner must beat the runner-up by this factor. */
  margin: number;
  /** Neighbours to fetch per face. */
  k: number;
  /** Mint an unnamed person when nothing matches. */
  create: boolean;
  /** A face below these never *seeds* a person; it may still attach to one. */
  minCreateConfidence: number;
  /** Shortest side of the face, in display-frame pixels. */
  minCreateSize: number;
  /** Re-decide faces a previous automatic run assigned. */
  reassign: boolean;
  /** Allow one person on two faces of the same image (collages, mirrors). */
  allowDuplicatePerson: boolean;
  dryRun: boolean;
};

export const DEFAULT_ASSIGN_OPTIONS: AssignOptions = {
  voteThreshold: 0.5,
  attachThreshold: 0.55,
  margin: 1.2,
  k: 24,
  create: true,
  minCreateConfidence: 0.7,
  minCreateSize: 48,
  reassign: false,
  allowDuplicatePerson: false,
  dryRun: false,
};

type AssignReason =
  | 'attached'
  | 'created'
  | 'skipped-locked'
  | 'skipped-no-vector'
  | 'skipped-assigned'
  | 'skipped-gate'
  | 'skipped-no-match';

type AssignResult = {
  /** The region. */
  facePath: string;
  /** The region's node id. */
  faceId: string;
  personId: string | null;
  created: boolean;
  confidence: number;
  reason: AssignReason;
};

/**
 * Process-wide lock around the find → decide → create → write sequence.
 *
 * Without it, two faces of the same new person processed concurrently both see
 * "no match" and each mint a person. Today the only caller runs on a
 * concurrency-1 queue worker, but that is a deployment detail that is expected
 * to change, and inline pipeline steps are already parallel. `#!ts` bins are
 * imported into the one Deno process and an aliased lib resolves to a single
 * module, so this really is process-wide.
 */
let queue: Promise<unknown> = Promise.resolve();
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  // Keep the chain alive regardless of this call's outcome.
  queue = run.then(() => {}, () => {});
  return run;
};

const occ = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v !== 'null';

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The stored vector, as the `[0.1,0.2,…]` JSON text findSimilar expects back.
 * Null when the embedding has none yet.
 */
const readVector = async (vfs: Vfs, access: Access, path: string): Promise<Uint8Array | null> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    const text = await toText(handle.readable);
    return text.length > 0 ? new TextEncoder().encode(text) : null;
  } finally {
    await handle.close();
  }
};

/**
 * Big and confident enough to be worth treating as a new identity.
 *
 * `faceBox` is a fraction of the display frame, so the size gate needs that frame's dimensions
 * to stay a pixel threshold ("enough detail to identify"). Unknown dimensions mean no gate:
 * refusing to seed would be worse than seeding a small face.
 */
const canSeedPerson = (attrs: FaceAttrs, opts: AssignOptions, dims?: Dims): boolean => {
  if ((attrs.confidence ?? 0) < opts.minCreateConfidence) return false;
  const box = attrs.faceBox;
  if (box && dims) {
    const pixels = toPixels(box, dims);
    if (Math.min(pixels.width, pixels.height) < opts.minCreateSize) return false;
  }
  return true;
};

/**
 * Decide a person for every unassigned face of one image.
 *
 * Faces are handled best-first so the clearest one seeds a new person, and the
 * weaker ones then have something to attach to.
 */
export const assignFacesForFile = async (
  vfs: Vfs,
  access: Access,
  filePath: string,
  options: Partial<AssignOptions> = {},
): Promise<AssignResult[]> => {
  const opts = { ...DEFAULT_ASSIGN_OPTIONS, ...options };

  const regionsPath = regionsPathOf(filePath);
  let children;
  try {
    children = await vfs.children<FaceAttrs>(access, regionsPath);
  } catch {
    return []; // no regions directory
  }
  // A region without an embedding is a tag: a box and maybe a name, nothing to search with.
  const embeddingOf = await faceEmbeddingsOfRegions(vfs, access, children.map((c) => c.node.id));

  // The size gate is in pixels, the boxes are fractions: one read of the image gives the frame
  // they are fractions of.
  let dims: Dims | undefined;
  try {
    const file = await vfs.get<{ width?: number; height?: number; angle?: unknown }>(access, filePath);
    const { width, height } = file.attrs;
    if (typeof width === 'number' && typeof height === 'number') dims = displayDims(width, height, file.attrs.angle);
  } catch {
    // no dimensions — the gate below is skipped rather than guessed
  }

  // Persons already on this image: a person cannot be two faces in one photo.
  const takenPersonIds = new Set<string>();
  for (const c of children) {
    if (occ(c.node.attrs.personId)) takenPersonIds.add(c.node.attrs.personId);
  }

  const candidates = children
    .filter((c) => {
      const a = c.node.attrs;
      if (!embeddingOf.has(c.node.id)) return false;
      if (occ(a.personId)) return opts.reassign && a.personSource === 'auto';
      return true;
    })
    .sort((x, y) => (y.node.attrs.confidence ?? 0) - (x.node.attrs.confidence ?? 0));

  const results: AssignResult[] = [];

  for (const child of candidates) {
    const facePath = `${regionsPath}/${child.name}`;
    const faceId = child.node.id;
    const embeddingId = embeddingOf.get(faceId)!;
    const attrs = child.node.attrs;

    if (attrs.assignLocked === true) {
      results.push({ facePath, faceId, personId: null, created: false, confidence: 0, reason: 'skipped-locked' });
      continue;
    }

    const result = await withLock(async (): Promise<AssignResult> => {
      const vector = await readVector(vfs, access, faceEmbeddingPathOf(facePath));
      if (!vector) {
        return { facePath, faceId, personId: null, created: false, confidence: 0, reason: 'skipped-no-vector' };
      }

      const matches = (await vfs.findSimilar(access, FACE_EMBEDDING_TYPE, vector, opts.k, opts.voteThreshold)).filter((m) => m.id !== embeddingId);
      const regionOf = await regionsOfEmbeddings(vfs, access, matches.map((m) => m.id));
      const regionIds = [...new Set(regionOf.values())];
      const neighbours = regionIds.length > 0 ? await vfs.getNodesByIds<FaceAttrs>(access, regionIds) : new Map();

      // Only neighbours that already belong to someone can vote, and only from
      // other images — two faces in one photo are different people.
      const labeled = new Map<string, string>();
      const edges: FaceEdge[] = [];
      for (const m of matches) {
        const regionId = regionOf.get(m.id);
        const node = regionId ? neighbours.get(regionId) : undefined;
        if (!node) continue;
        const personId = node.attrs.personId;
        if (!occ(personId)) continue;
        if (node.attrs.fileId && node.attrs.fileId === attrs.fileId) continue;
        if (!opts.allowDuplicatePerson && takenPersonIds.has(personId)) continue;
        labeled.set(m.id, personId);
        edges.push({ a: m.id, b: embeddingId, sim: m.similarity });
      }

      // Same voting rules as the batch path, over this face's neighbourhood.
      const rejected = Array.isArray(attrs.rejectedPersonIds) ? new Map([[embeddingId, new Set(attrs.rejectedPersonIds)]]) : undefined;
      const { assignments } = propagateLabels(edges, labeled, {
        threshold: opts.voteThreshold,
        minMargin: opts.margin,
        minVotes: opts.attachThreshold,
        rejected,
      });
      const winner = assignments.find((a) => a.faceId === embeddingId);

      if (winner) {
        if (!opts.dryRun) {
          await vfs.update(access, facePath, {
            attrs: {
              personId: winner.personId,
              personSource: 'auto',
              personConfidence: winner.confidence,
              personAssignedAt: nowIso(),
            },
          });
        }
        takenPersonIds.add(winner.personId);
        return { facePath, faceId, personId: winner.personId, created: false, confidence: winner.confidence, reason: 'attached' };
      }

      if (!opts.create) {
        return { facePath, faceId, personId: null, created: false, confidence: 0, reason: 'skipped-no-match' };
      }
      if (!canSeedPerson(attrs, opts, dims)) {
        // A tiny or uncertain detection — a background face in a crowd shot —
        // may join someone later, but must not mint an identity of its own.
        return { facePath, faceId, personId: null, created: false, confidence: 0, reason: 'skipped-gate' };
      }

      if (opts.dryRun) {
        return { facePath, faceId, personId: null, created: true, confidence: 0, reason: 'created' };
      }

      const person = await createUnnamedPerson(vfs, access, { createdBy: 'assign-faces', representativeFaceId: faceId });
      await vfs.update(access, facePath, {
        attrs: {
          personId: person.id,
          personSource: 'auto',
          personConfidence: null,
          personAssignedAt: nowIso(),
        },
      });
      takenPersonIds.add(person.id);
      return { facePath, faceId, personId: person.id, created: true, confidence: 0, reason: 'created' };
    });

    results.push(result);
  }

  return results;
};
