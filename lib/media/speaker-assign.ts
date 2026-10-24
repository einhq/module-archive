/**
 * Speaker → person assignment: which person each voice of a recording is.
 *
 * The same shape as @archive/media/face-assign, and for the same reason. A speaker's voiceprint
 * is searched against every other recording's speakers; a clear match to one that already
 * belongs to someone reuses that person, and otherwise a voice that spoke long enough mints a new
 * unnamed person. The second recording of the same stranger finds the first and joins it rather
 * than creating a rival identity — so naming that person once names every recording they are
 * heard in. The batch counterpart is `cluster-voices`; both vote through
 * @archive/media/face-cluster, which is embedding-agnostic.
 *
 * A speaker is decided as a whole: one voiceprint pooled over all of its turns, which is far
 * more voice than any one turn carries, so short-spoken people can be recognised too.
 *
 * **Two rules from the diarizer.** It has already said that two speakers of one recording are
 * different voices, so:
 *
 *  - another speaker of the same recording never votes (it is evidence of *someone else*);
 *  - two speakers of one recording never go to the same person automatically. The second to
 *    win a person is left undecided rather than fused — a diarizer that split one person in two
 *    is fixed by a merge, two people fused into one has to be found first.
 *
 * **The person as a whole.** Neighbours vote, but the winner is then checked against the mean of
 * all the voices they already hold. Every attached voice becomes a neighbour for the next one, so
 * on nearest neighbours alone a person drifts from one speaker to the next through voices that
 * each resemble the one before (ein/core#623); the mean does not drift that way. A
 * lip-sync match is checked too, against a lower bar: the face seen moving with the sound is
 * often not the one speaking — the camera operator talks while someone else is in frame
 * (ein/core#632).
 */

import type { Command } from '@ein/client';
import { toText } from '@std/streams/to-text';
import { type FaceEdge, propagateLabels } from '@archive/media/face-cluster';
import { createUnnamedPerson, voicesOf } from '@archive/people/person';
import { isHeld, type SpeakerAttrs, speakersPathOf, VOICE_EMBEDDING_TYPE } from '@archive/media/speakers';

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

export type SpeakerAssignOptions = {
  /** Min cosine similarity for a neighbour's vote to count. */
  voteThreshold: number;
  /** Min winning vote weight to attach to an existing person. */
  attachThreshold: number;
  /** Min cosine similarity between the voice and the mean of the winner's voices. */
  personThreshold: number;
  /**
   * The same bar, lower, for the person a confident lip-sync match names: the face is evidence
   * of its own, but on home video it is often the person on screen while someone off it talks.
   */
  asdPersonThreshold: number;
  /** Winner must beat the runner-up by this factor. */
  margin: number;
  /** Neighbours to fetch per speaker. */
  k: number;
  /** Mint an unnamed person when nothing matches. */
  create: boolean;
  /** A speaker who spoke less than this never *founds* a person; it may still attach to one. */
  minCreateSeconds: number;
  /** Re-decide speakers a previous automatic run assigned. */
  reassign: boolean;
  /**
   * Weight of the vote a confident lip-sync match casts, on the same 0..1 scale as a cosine
   * similarity between two voiceprints. Above `attachThreshold`, so seeing someone say the words
   * is on its own enough to attach; still a vote that voices a person decided can outweigh.
   */
  asdVoteWeight: number;
  /** Ignore a lip-sync match weaker than this. */
  asdMinScore: number;
  dryRun: boolean;
};

/**
 * Erring toward *not* attaching is the safer direction — a person split in two is one merge to
 * fix, two fused has to be found first.
 */
export const DEFAULT_SPEAKER_ASSIGN_OPTIONS: SpeakerAssignOptions = {
  voteThreshold: 0.5,
  attachThreshold: 0.55,
  personThreshold: 0.7,
  asdPersonThreshold: 0.5,
  margin: 1.2,
  k: 24,
  create: true,
  minCreateSeconds: 10,
  reassign: false,
  asdVoteWeight: 0.9,
  asdMinScore: 0.6,
  dryRun: false,
};

type SpeakerAssignReason =
  | 'attached'
  | 'created'
  | 'skipped-locked'
  | 'skipped-no-vector'
  | 'skipped-taken'
  | 'skipped-unlike'
  | 'skipped-gate'
  | 'skipped-no-match';

type SpeakerAssignResult = {
  speakerPath: string;
  speakerId: string;
  personId: string | null;
  created: boolean;
  confidence: number;
  reason: SpeakerAssignReason;
};

/**
 * Process-wide lock around find → decide → create → write. Two new voices decided at once would
 * each mint a person; the pipeline's `exclusive: person-mint` — shared with faces, which mint
 * under /people/unknown too — is the deployment-level backstop.
 */
let queue: Promise<unknown> = Promise.resolve();
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
};

const occ = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v !== 'null';

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** The stored voiceprint, as the `[0.1,0.2,…]` JSON text findSimilar expects back. */
const readVector = async (vfs: Vfs, access: Access, path: string): Promise<Uint8Array | null> => {
  const handle = await vfs.open(access, path, { mode: 'r' });
  try {
    const text = await toText(handle.readable);
    return text.length > 0 ? new TextEncoder().encode(text) : null;
  } finally {
    await handle.close();
  }
};

const unitVector = (values: number[]): number[] => {
  const norm = Math.hypot(...values);
  return norm > 0 ? values.map((v) => v / norm) : values;
};

/**
 * Cosine similarity between a voiceprint and the mean of the person's other voices, or null when
 * they hold none with a stored vector.
 */
const likenessToPerson = async (vfs: Vfs, access: Access, personId: string, speakerId: string, vector: Uint8Array): Promise<number | null> => {
  const ids = (await voicesOf(vfs, access, personId)).map((v) => v.id).filter((id) => id !== speakerId);
  if (ids.length === 0) return null;
  const decoder = new TextDecoder();
  const vectors = await vfs.getVectors(access, VOICE_EMBEDDING_TYPE, ids);
  if (vectors.size === 0) return null;
  let mean: number[] | null = null;
  for (const bytes of vectors.values()) {
    const unit = unitVector(JSON.parse(decoder.decode(bytes)) as number[]);
    mean = mean ? mean.map((v, i) => v + unit[i]) : unit;
  }
  const own = unitVector(JSON.parse(decoder.decode(vector)) as number[]);
  return unitVector(mean!).reduce((sum, v, i) => sum + v * own[i], 0);
};

/**
 * Decide a person for every undecided speaker of one recording, the one who spoke most first:
 * the clearest voice is the likeliest to find or found its person, and it claims that person
 * before a shorter voice of the same recording can.
 */
export const assignSpeakersForFile = async (
  vfs: Vfs,
  access: Access,
  filePath: string,
  options: Partial<SpeakerAssignOptions> = {},
): Promise<SpeakerAssignResult[]> => {
  const opts = { ...DEFAULT_SPEAKER_ASSIGN_OPTIONS, ...options };
  const speakersPath = speakersPathOf(filePath);

  let children;
  try {
    children = await vfs.children<SpeakerAttrs>(access, speakersPath);
  } catch {
    return []; // never voiceprinted
  }
  const speakers = children.filter((c) => c.node.attrs.embeddingType === VOICE_EMBEDDING_TYPE);
  const ownIds = new Set(speakers.map((c) => c.node.id));
  // People this recording's voices already are: the second voice to win one is left undecided.
  const taken = new Set(speakers.map((c) => c.node.attrs.personId).filter(occ));

  const candidates = speakers
    .filter((c) => {
      const a = c.node.attrs;
      if (occ(a.personId)) return opts.reassign && a.personSource === 'auto';
      return true;
    })
    .sort((x, y) => (y.node.attrs.talkSeconds ?? 0) - (x.node.attrs.talkSeconds ?? 0));

  const results: SpeakerAssignResult[] = [];

  for (const child of candidates) {
    const speakerPath = `${speakersPath}/${child.name}`;
    const speakerId = child.node.id;
    const attrs = child.node.attrs;
    const undecided = (reason: SpeakerAssignReason): SpeakerAssignResult => ({ speakerPath, speakerId, personId: null, created: false, confidence: 0, reason });

    if (attrs.assignLocked === true) {
      results.push(undecided('skipped-locked'));
      continue;
    }
    // A re-decision frees the person this speaker held, for itself or a sibling.
    if (occ(attrs.personId)) taken.delete(attrs.personId);

    const result = await withLock(async (): Promise<SpeakerAssignResult> => {
      const vector = await readVector(vfs, access, speakerPath);
      if (!vector) return undecided('skipped-no-vector');

      const matches = await vfs.findSimilar(access, VOICE_EMBEDDING_TYPE, vector, opts.k, opts.voteThreshold);
      const others = matches.filter((m) => !ownIds.has(m.id));
      const neighbours = others.length > 0 ? await vfs.getNodesByIds<SpeakerAttrs>(access, others.map((m) => m.id)) : new Map();

      // A face seen saying the words in this recording, and recognised, is direct evidence; a
      // voiceprint neighbour is only as good as whoever decided it. Against a confident lip-sync
      // match only the voices a person decided vote — automatic ones are what a run before this
      // one guessed, and a guess repeated over a few hundred recordings would outweigh any face.
      const asdScore = typeof attrs.asdScore === 'number' ? attrs.asdScore : 0;
      const asdUsed = occ(attrs.asdPersonId) && asdScore >= opts.asdMinScore;

      const labeled = new Map<string, string>();
      const edges: FaceEdge[] = [];
      for (const m of others) {
        const node = neighbours.get(m.id);
        if (!node || !occ(node.attrs.personId)) continue;
        // A speaker of this same recording is a different voice by the diarizer's word.
        if (node.attrs.fileId && node.attrs.fileId === attrs.fileId) continue;
        if (asdUsed && !isHeld(node.attrs)) continue;
        labeled.set(m.id, node.attrs.personId);
        edges.push({ a: m.id, b: speakerId, sim: m.similarity });
      }

      // The face as one more labelled neighbour, arbitrated by the same margin and minimum-vote
      // rules: voices a person decided can still outvote it.
      if (asdUsed) {
        const witness = `asd:${speakerId}`;
        labeled.set(witness, attrs.asdPersonId as string);
        edges.push({ a: witness, b: speakerId, sim: opts.asdVoteWeight });
      }

      const { assignments } = propagateLabels(edges, labeled, {
        threshold: opts.voteThreshold,
        minMargin: opts.margin,
        minVotes: opts.attachThreshold,
      });
      // propagateLabels speaks in face ids; the id is this speaker's either way.
      const winner = assignments.find((a) => a.faceId === speakerId);

      if (winner) {
        if (taken.has(winner.personId)) return undecided('skipped-taken');
        // A person who holds no voice yet passes: that is the cold start the face is there for.
        const bar = asdUsed && winner.personId === attrs.asdPersonId ? opts.asdPersonThreshold : opts.personThreshold;
        const likeness = await likenessToPerson(vfs, access, winner.personId, speakerId, vector);
        if (likeness !== null && likeness < bar) return undecided('skipped-unlike');
        if (!opts.dryRun) {
          await vfs.update(access, speakerPath, {
            attrs: {
              personId: winner.personId,
              personSource: 'auto',
              personConfidence: winner.confidence,
              personAssignedAt: nowIso(),
              ...(asdUsed ? { asdAssisted: true } : {}),
            },
          });
        }
        taken.add(winner.personId);
        return { speakerPath, speakerId, personId: winner.personId, created: false, confidence: winner.confidence, reason: 'attached' };
      }

      if (!opts.create) return undecided('skipped-no-match');
      // Evidence existed and did not agree: "one of these, unclear which" is not "somebody new",
      // and a third identity is harder to undo than a voice left undecided for a later pass.
      if (labeled.size > 0) return undecided('skipped-no-match');
      // Enough voice to recognise someone known can be far too little to declare someone new on.
      if ((attrs.talkSeconds ?? 0) < opts.minCreateSeconds) return undecided('skipped-gate');

      if (opts.dryRun) return { speakerPath, speakerId, personId: null, created: true, confidence: 0, reason: 'created' };

      const person = await createUnnamedPerson(vfs, access, { createdBy: 'assign-speakers', origin: 'voice' });
      await vfs.update(access, speakerPath, {
        attrs: { personId: person.id, personSource: 'auto', personConfidence: null, personAssignedAt: nowIso() },
      });
      taken.add(person.id);
      return { speakerPath, speakerId, personId: person.id, created: true, confidence: 0, reason: 'created' };
    });

    results.push(result);
  }

  return results;
};
