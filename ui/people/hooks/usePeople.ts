import { PEOPLE_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand, onOutsideEdit } from '@ein/ui/signals';
import { NodeChildEntry, shq } from '@ein/ui/lib';
import type { PersonInfo as PersonInfoAnswer } from '@archive/people/api';
export type { PersonContact, PersonHome } from '@archive/people/api';

/** What `person-info` answers, with the route id the page asked for it by. */
export type PersonInfo = PersonInfoAnswer & { id: string };

export type PersonEntry = {
  id: string; // node/directory name, used as the route param
  name: string;
  fullname?: string;
  gender?: string;
};

type UsePeopleResult = {
  people: PersonEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * List person nodes under /people
 */
export function usePeople(rootPath: string = PEOPLE_ROOT, enabled = true): UsePeopleResult {
  const [people, setPeople] = useState<PersonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchPeople = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const children = await execCommand<NodeChildEntry[]>(`ls -l ${shq(rootPath)}`);
      const entries = children
        .filter((entry) => entry.node.type === 'person')
        .map((entry): PersonEntry => {
          const attrs = entry.node.attrs as Record<string, unknown>;
          return {
            id: entry.name,
            name: (attrs.name as string) || entry.name,
            fullname: attrs.fullname as string | undefined,
            gender: attrs.gender as string | undefined,
          };
        });

      setPeople(entries);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    fetchPeople();
  }, [enabled, fetchPeople]);

  return { people, loading, error, refetch: fetchPeople };
}

type UsePersonResult = {
  person: PersonInfo | null;
  loading: boolean;
  error: Error | null;
  /** Re-read the person — after an edit that changes the header. */
  refetch: () => void;
};

/**
 * One person, by their directory name under `/people`.
 *
 * A single `person-info` exec, rather than a listing of everyone to answer a question about one.
 */
export function usePerson(id: string | undefined): UsePersonResult {
  const [person, setPerson] = useState<PersonInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // The chat drawer may change this person while the page shows them.
  useEffect(() => onOutsideEdit(() => setReloadKey((key) => key + 1)), []);

  useEffect(() => {
    if (!id) {
      setPerson(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const info = await execCommand<PersonInfoAnswer>(`person-info ${shq(`${PEOPLE_ROOT}/${id}`)}`);
        if (cancelled) return;
        setPerson({
          ...info,
          id,
          relations: info.relations ?? [],
          homes: info.homes ?? [],
          events: info.events ?? [],
        });
      } catch (err) {
        if (cancelled) return;
        // A person who is not there is not an error to shout about — the page
        // renders its "not found" state from a null person.
        setError(err instanceof Error ? err : new Error(String(err)));
        setPerson(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  return { person, loading, error, refetch: useCallback(() => setReloadKey((key) => key + 1), []) };
}
