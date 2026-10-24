import { useCallback, useEffect, useRef, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { PersonFace } from './usePersonFaces.ts';
import type { UnknownFaceThumb, UnknownListResult, UnknownPerson } from '@archive/people/api';
export type { UnknownPerson } from '@archive/people/api';

/** A paged face row as the overview's preview thumb. */
const thumbOf = (face: PersonFace): UnknownFaceThumb => ({
  facePath: face.facePath,
  fileId: face.fileId,
  confidence: face.confidence,
});

type UseUnknownPersonResult = {
  person: UnknownPerson | null;
  loading: boolean;
  refetch: () => void;
};

export type UnknownPeopleFaceChange = {
  sourcePath: string;
  /** The loaded faces that stayed; the dialog pages, so there may be more. */
  remainingFaces: PersonFace[];
  /** How many faces the source has left, loaded or not. */
  remainingCount: number;
  created: Array<{
    person: { id: string; path: string; name: string };
    faces: PersonFace[];
  }>;
};

export type UnknownPeopleMergeChange = {
  sources: UnknownPerson[];
  destination: UnknownPerson;
};

export type UnknownSort = 'faces' | 'created';

type UseUnknownPeopleOptions = {
  /** Crops per person; 0 asks for none. */
  faces?: number;
  /** People per page; 0 fetches only the total. */
  pageSize?: number;
  sort?: UnknownSort;
  /** Leave out clusters with fewer faces than this. */
  minFaces?: number;
};

type UseUnknownPeopleResult = {
  /** The people loaded so far, in the requested order. */
  people: UnknownPerson[];
  /** Every unidentified person that passes the filter, loaded or not. */
  total: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** Append the next page; a no-op while one is in flight or when all are loaded. */
  loadMore: () => void;
  error: Error | null;
  /** Reload as many people as are loaded now, from the first. */
  refetch: () => void;
  /** Name a person and move them into /people. Returns the new path. */
  namePerson: (path: string, name: string, gender?: string) => Promise<string>;
  /** Fold this person into an existing one. */
  mergeInto: (srcPath: string, dstPath: string) => Promise<void>;
  /** Say these people are not a person at all, and drop them from the list. */
  discard: (paths: string[]) => Promise<void>;
  /** Apply a successful face move without replacing the whole unidentified grid. */
  reconcileFaces: (change: UnknownPeopleFaceChange) => void;
  /** Apply a successful multi-cluster merge without replacing the whole grid. */
  reconcileMerge: (change: UnknownPeopleMergeChange) => void;
};

/**
 * People that face recognition created but nobody has named yet, a page at a time.
 *
 * One exec per page — `person-unknown` returns each person's face count and a few crops, so
 * nothing is fetched per card. `loadMore` appends the next page and `total` says how many
 * there are while only some are loaded.
 */
export function useUnknownPeople({ faces = 4, pageSize = 200, sort = 'faces', minFaces = 0 }: UseUnknownPeopleOptions = {}): UseUnknownPeopleResult {
  const [people, setPeople] = useState<UnknownPerson[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const query = `--faces ${faces} --sort ${sort} --min-faces ${minFaces}`;
  const loadedQueryRef = useRef<string | null>(null);
  const loadedCountRef = useRef(0);
  // Bumped by every first-page load, so a page that lands after the query changed is dropped.
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    loadedCountRef.current = people.length;
  }, [people]);

  const fetchPeople = useCallback(async () => {
    const generation = ++generationRef.current;
    const initial = loadedQueryRef.current !== query;
    // A refresh after a mutation keeps as many people as are on screen, so the grid does not
    // shrink back to one page under the reader.
    const limit = initial ? pageSize : Math.max(pageSize, loadedCountRef.current);
    try {
      if (initial) setLoading(true);
      setError(null);
      const result = await execCommand<UnknownListResult>(`person-unknown ${query} -l ${limit}`);
      if (generation !== generationRef.current) return;
      setPeople(result.people ?? []);
      setTotal(result.total ?? 0);
      setNextOffset(result.nextOffset ?? null);
      loadedQueryRef.current = query;
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // A refresh after a partial mutation is a reconciliation attempt. Keep
      // the current grid mounted if that attempt fails so scroll/focus survive.
      if (initial) {
        setPeople([]);
        setTotal(0);
        setNextOffset(null);
      }
    } finally {
      if (initial && generation === generationRef.current) setLoading(false);
    }
  }, [query, pageSize]);

  useEffect(() => {
    fetchPeople();
  }, [fetchPeople]);

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMoreRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await execCommand<UnknownListResult>(`person-unknown ${query} -l ${pageSize} --offset ${nextOffset}`);
      if (generation !== generationRef.current) return;
      setPeople((current) => {
        // A person created or grown since the last page can shift across the page edge.
        const have = new Set(current.map((person) => person.id));
        return [...current, ...(page.people ?? []).filter((person) => !have.has(person.id))];
      });
      setTotal(page.total ?? 0);
      setNextOffset(page.nextOffset ?? null);
    } catch (err) {
      if (generation === generationRef.current) setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [query, pageSize, nextOffset]);

  /** People removed from the loaded pages: everything after them moves up by as many. */
  const dropped = useCallback((count: number) => {
    setTotal((current) => Math.max(0, current - count));
    setNextOffset((current) => current === null ? null : Math.max(0, current - count));
  }, []);

  const namePerson = useCallback(async (path: string, name: string, gender?: string) => {
    const genderArg = gender ? ` --gender ${shq(gender)}` : '';
    const result = await execCommand<{ path: string }>(`person-name ${shq(path)} --name ${shq(name)}${genderArg}`);
    setPeople((current) => current.filter((person) => person.path !== path));
    dropped(1);
    return result.path;
  }, [dropped]);

  const mergeInto = useCallback(async (srcPath: string, dstPath: string) => {
    await execCommand(`person-merge ${shq(srcPath)} ${shq(dstPath)}`);
    setPeople((current) => {
      const source = current.find((person) => person.path === srcPath);
      return current
        .filter((person) => person.path !== srcPath)
        .map((person) =>
          person.path === dstPath && source
            ? {
              ...person,
              faceCount: person.faceCount + source.faceCount,
              faces: [...person.faces, ...source.faces].sort((a, b) => b.confidence - a.confidence).slice(0, faces),
            }
            : person
        );
    });
    dropped(1);
  }, [faces, dropped]);

  const discard = useCallback(async (paths: string[]) => {
    try {
      await execCommand(`person-discard ${paths.map(shq).join(' ')}`);
    } catch (err) {
      // One refused does not stop the rest, so which ones went is read back.
      void fetchPeople();
      throw err;
    }
    const gone = new Set(paths);
    setPeople((current) => current.filter((person) => !gone.has(person.path)));
    dropped(paths.length);
  }, [fetchPeople, dropped]);

  const reconcileFaces = useCallback((change: UnknownPeopleFaceChange) => {
    // A new cluster smaller than the filter allows exists, but not in this list.
    const created = change.created.filter(({ faces: moved }) => moved.length >= minFaces);
    setPeople((current) => {
      const next = current.map((person) =>
        person.path === change.sourcePath
          ? {
            ...person,
            faceCount: change.remainingCount,
            faces: change.remainingFaces.toSorted((a, b) => b.confidence - a.confidence).slice(0, faces).map(thumbOf),
          }
          : person
      );
      const sourceIndex = next.findIndex((person) => person.path === change.sourcePath);
      const insertAt = sourceIndex < 0 ? next.length : sourceIndex + 1;
      next.splice(
        insertAt,
        0,
        ...created.map(({ person, faces: moved }) => ({
          ...person,
          faceCount: moved.length,
          // Split off from faces: a person made from moved faces holds no voice yet.
          voiceCount: 0,
          createdAt: new Date().toISOString(),
          faces: moved.toSorted((a, b) => b.confidence - a.confidence).slice(0, faces).map(thumbOf),
          voices: [],
        })),
      );
      return next;
    });
    setTotal((current) => current + created.length);
  }, [faces, minFaces]);

  const reconcileMerge = useCallback(({ sources, destination }: UnknownPeopleMergeChange) => {
    const sourcePaths = new Set(sources.map((person) => person.path));
    const addedFaces = sources.reduce((sum, person) => sum + person.faceCount, 0);
    const previews = sources.flatMap((person) => person.faces);
    setPeople((current) =>
      current
        .filter((person) => !sourcePaths.has(person.path))
        .map((person) =>
          person.path === destination.path
            ? {
              ...person,
              faceCount: person.faceCount + addedFaces,
              faces: [...person.faces, ...previews].sort((a, b) => b.confidence - a.confidence).slice(0, faces),
            }
            : person
        )
    );
    dropped(sources.length);
  }, [faces, dropped]);

  return {
    people,
    total,
    loading,
    loadingMore,
    hasMore: nextOffset !== null,
    loadMore,
    error,
    refetch: fetchPeople,
    namePerson,
    mergeInto,
    discard,
    reconcileFaces,
    reconcileMerge,
  };
}

/** Fetch one URL-addressed cluster even when it is outside the overview page. */
export function useUnknownPerson(id: string | undefined, enabled = true): UseUnknownPersonResult {
  const [person, setPerson] = useState<UnknownPerson | null>(null);
  const [loading, setLoading] = useState(Boolean(id && enabled));
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id || !enabled) {
      setPerson(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    execCommand<UnknownListResult>(`person-unknown --person ${shq(id)} --faces 4 -l 1`)
      .then((result) => {
        if (!cancelled) setPerson(result.people?.[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setPerson(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, id, reloadKey]);

  return { person, loading, refetch: useCallback(() => setReloadKey((key) => key + 1), []) };
}
