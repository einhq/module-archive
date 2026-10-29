import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { FaceListResult, FacePerson, PersonFace } from '@archive/people/api';
export type { PersonFace } from '@archive/people/api';

type UsePersonFacesResult = {
  person: FacePerson | null;
  /** The faces loaded so far: in date order, or the clearest doubts first. */
  faces: PersonFace[];
  /** Every face in the list asked for, loaded or not. */
  total: number;
  /** The person's faces an audit doubts, whichever list was asked for. */
  doubtful: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** Append the next page; a no-op while one is in flight or when all are loaded. */
  loadMore: () => void;
  error: Error | null;
  /** Reload from the first page. */
  refetch: () => void;
  /** Remove faces after a confirmed mutation without replacing the scroll box. */
  removeFaces: (paths: string[]) => void;
};

/**
 * The faces assigned to one person, a page at a time in date order.
 *
 * Judging whether a cluster really is one person needs all of them, not the overview's
 * four-crop preview, but a person with thousands of faces is more than the API shell will
 * carry in one answer. So `person-faces` pages and `loadMore` appends, and `total` says how
 * many there are while only some are loaded. A null path is the idle state and runs nothing,
 * so a modal driven by this only reads while it is open. `doubtful` lists only the faces that
 * look like somebody else, clearest first.
 */
export function usePersonFaces(personPath: string | null, { doubtful: onlyDoubtful = false }: { doubtful?: boolean } = {}): UsePersonFacesResult {
  const [person, setPerson] = useState<FacePerson | null>(null);
  const [faces, setFaces] = useState<PersonFace[]>([]);
  const [total, setTotal] = useState(0);
  const [doubtful, setDoubtful] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Which list is on screen, so switching lists shows a loader rather than the old one.
  const loadedListRef = useRef<string | null>(null);
  const facesRef = useRef<PersonFace[]>([]);
  facesRef.current = faces;
  // Bumped by every first-page load, so a page that lands after the person changed is dropped.
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const command = useCallback(
    (offset: number) => `person-faces ${shq(personPath ?? '')} ${onlyDoubtful ? '--doubtful --sort doubt' : '--sort date'} --offset ${offset}`,
    [personPath, onlyDoubtful],
  );

  const fetchFaces = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!personPath) {
      setPerson(null);
      setFaces([]);
      setTotal(0);
      setDoubtful(0);
      setNextOffset(null);
      setError(null);
      loadedListRef.current = null;
      return;
    }
    const list = command(0);
    const initial = loadedListRef.current !== list;
    try {
      if (initial) setLoading(true);
      setError(null);
      const result = await execCommand<FaceListResult>(list);
      if (generation !== generationRef.current) return;
      setPerson(result.person ?? null);
      setFaces(result.faces ?? []);
      setTotal(result.total ?? 0);
      setDoubtful(result.doubtful ?? 0);
      setNextOffset(result.nextOffset ?? null);
      loadedListRef.current = list;
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      if (initial) {
        setFaces([]);
        setTotal(0);
        setNextOffset(null);
      }
    } finally {
      if (initial && generation === generationRef.current) setLoading(false);
    }
  }, [personPath, command]);

  useEffect(() => {
    fetchFaces();
  }, [fetchFaces]);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMoreRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await execCommand<FaceListResult>(command(nextOffset));
      if (generation !== generationRef.current) return;
      setFaces((current) => {
        // A face can shift across a page edge if another tab moved faces in the meantime.
        const have = new Set(current.map((face) => face.facePath));
        return [...current, ...(page.faces ?? []).filter((face) => !have.has(face.facePath))];
      });
      setTotal(page.total ?? 0);
      setDoubtful(page.doubtful ?? 0);
      setNextOffset(page.nextOffset ?? null);
    } catch (err) {
      if (generation === generationRef.current) setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [command, nextOffset]);

  const removeFaces = useCallback((paths: string[]) => {
    const removed = new Set(paths);
    const doubts = facesRef.current.filter((face) => removed.has(face.facePath) && face.doubt).length;
    if (doubts > 0) setDoubtful((current) => Math.max(0, current - doubts));
    setFaces((current) => current.filter((face) => !removed.has(face.facePath)));
    setTotal((current) => Math.max(0, current - removed.size));
    // Removed faces were all loaded, so everything after them moves up by as many.
    setNextOffset((current) => current === null ? null : Math.max(0, current - removed.size));
    setPerson((value) => value ? { ...value, faceCount: Math.max(0, value.faceCount - removed.size) } : value);
  }, []);

  return { person, faces, total, doubtful, loading, loadingMore, hasMore: nextOffset !== null, loadMore, error, refetch: fetchFaces, removeFaces };
}
