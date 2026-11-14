import { useEffect, useState } from 'react';
import type { SearchGroupsResponse } from '@ein/api';
import { execCommand } from '@ein/ui/signals';
import { type Mention, shq } from '@ein/ui/lib';

/**
 * The people in an album's pictures, as `@` picks: the most pictured first. Whoever is in none of
 * them is not offered, since picking them would find nothing here.
 */
export function useAlbumPeople(path: string): Mention[] {
  const [people, setPeople] = useState<Mention[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPeople([]);
    execCommand<SearchGroupsResponse>(`search --under ${shq(path)} --group-by person`)
      .then((answer) => {
        if (cancelled) return;
        setPeople(
          [...answer.groups]
            .sort((a, b) => b.count - a.count)
            .map((group) => ({ kind: 'person', label: group.name, value: group.path.split('/').pop() ?? group.path })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  return people;
}
