import { shq } from '@ein/ui/lib';

/**
 * Paths per `person-detach`: a nine-hundred-path command line is a lot to put
 * through the shell parser, and one failure stays local.
 */
export const DETACH_CHUNK = 100;

/** The three things `person-detach` can do with a detection, in the reviewer's words. */
export type DetachDestination =
  /** Somebody else, not yet named — mint one unnamed person for the whole batch. */
  | { kind: 'new-person' }
  /** That person over there. */
  | { kind: 'person'; path: string }
  /** Not a person at all — unassign and lock, so no later pass puts it back. */
  | { kind: 'unassign' };

/** Person a detach landed on. New people also report identity fields for an incremental card. */
type DetachTarget = { path: string; id?: string; name?: string };

/** `execCommand`, taken as a parameter so this module stays importable without the socket. */
type Exec = <T>(command: string) => Promise<T>;

/**
 * Move a batch of detections off whoever holds them.
 *
 * Faces or voices: `person-detach` requires only an embedding node carrying the person
 * contract, and this never looks at what kind it is.
 *
 * Chunked, and the new-person case is why this is worth having in one place: only the
 * *first* chunk may mint, and every chunk after it is sent to the person that one created.
 * Minting per chunk would turn one detached group into as many people as it took commands
 * to move it.
 *
 * Returns the person they landed on, or null when they were unassigned.
 */
export async function detachFromPerson(exec: Exec, paths: string[], destination: DetachDestination): Promise<DetachTarget | null> {
  let target: DetachTarget | null = destination.kind === 'person' ? { path: destination.path } : null;

  for (let i = 0; i < paths.length; i += DETACH_CHUNK) {
    const chunk = paths.slice(i, i + DETACH_CHUNK).map(shq).join(' ');

    if (destination.kind === 'unassign') {
      await exec(`person-detach ${chunk}`);
      continue;
    }
    if (target) {
      await exec(`person-detach --to ${shq(target.path)} ${chunk}`);
      continue;
    }

    const result = await exec<{ person: DetachTarget | null }>(`person-detach --to-new-person ${chunk}`);
    target = result.person;
    if (!target) throw new Error('person-detach did not report the person it created');
  }

  return target;
}

/** Where `person-detach --rematch` placed one face; `person` is null when it stayed unassigned. */
export type RematchedFace = {
  facePath: string;
  person: { id: string; path: string; name: string; unnamed: boolean } | null;
};

/**
 * "Not this person": let recognition place each face again, never back on the person it left.
 *
 * Unlike the other destinations the faces are decided one by one, so there is no single target
 * to report — the answer is where each of them went.
 */
export async function rematchFaces(exec: Exec, paths: string[]): Promise<RematchedFace[]> {
  const out: RematchedFace[] = [];
  for (let i = 0; i < paths.length; i += DETACH_CHUNK) {
    const chunk = paths.slice(i, i + DETACH_CHUNK).map(shq).join(' ');
    const result = await exec<{ rematched?: RematchedFace[] }>(`person-detach --rematch ${chunk}`);
    out.push(...(result.rematched ?? []));
  }
  return out;
}
