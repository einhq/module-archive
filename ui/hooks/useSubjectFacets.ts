import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { buildSearchCommand } from '@ein/ui/hooks';
import type { SearchFilters, SearchKind } from '@ein/ui/lib';

/** Per-year and per-month counts for one subject — what its rail is sized from — and what it is made of. */
type SubjectFacets = {
  total: number;
  range: { min: number; max: number } | null;
  days: { key: string; count: number }[];
  months: { key: string; count: number }[];
  years: { year: number; count: number }[];
  /**
   * What the set is made of, biggest first. Counted over undated media too — a
   * type filter must offer a kind the container holds whether or not anything
   * dated it. Nodes outside the classified media kinds appear only in `total`.
   */
  kinds: { kind: SearchKind; count: number }[];
  /** The labels the set's members carry, the most carried first: the commonest few, not all. */
  labels: { label: string; count: number }[];
  /**
   * The command stopped at its scan limit, so `total` is a floor rather than a
   * count. A caller showing the number to a reader has to say so — "5,000" and
   * "5,000+" are different claims.
   */
  truncated: boolean;
};

/** One command's answer, shared by the hooks asking it. `facets` is set once it has arrived. */
type Entry = { users: number; answer: Promise<SubjectFacets | null>; facets?: SubjectFacets | null };

// Answers keyed by command, kept while a mounted hook uses them: a person page's
// header and its media tab's rail ask the same question, and each asking walks
// the whole subject. The last user leaving drops the answer, so returning to a
// page asks again.
const entries = new Map<string, Entry>();

// Mounted hooks, so `forgetSubjectFacets` can make them ask again.
const watchers = new Set<() => void>();

/**
 * Drop every answer and make each mounted `useSubjectFacets` ask again. Called
 * after a change to which media a subject holds or when they were taken.
 */
export function forgetSubjectFacets(): void {
  entries.clear();
  for (const askAgain of watchers) askAgain();
}

function acquire(command: string): Entry {
  let entry = entries.get(command);
  if (!entry) {
    const created: Entry = { users: 0, answer: fetchFacets(command) };
    void created.answer.then((facets) => {
      created.facets = facets;
    });
    entries.set(command, created);
    entry = created;
  }
  entry.users++;
  return entry;
}

function release(command: string, entry: Entry): void {
  entry.users--;
  if (entry.users === 0 && entries.get(command) === entry) entries.delete(command);
}

async function fetchFacets(command: string): Promise<SubjectFacets | null> {
  try {
    const resp = await execCommand<SubjectFacets>(command);
    return {
      total: resp.total ?? 0,
      range: resp.range ?? null,
      days: resp.days ?? [],
      months: resp.months ?? [],
      years: resp.years ?? [],
      kinds: resp.kinds ?? [],
      labels: resp.labels ?? [],
      truncated: resp.truncated ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * How much of each year a person, location or album holds.
 *
 * Keyed on the filters but never on the anchor or the scroll position: the rail
 * draws its geometry from these numbers, and refetching them as the list is
 * seeked would resize the rail under the finger dragging it. Hooks asking the
 * same filters share one answer.
 *
 * `search --facets` walks the same ordered set a page comes from and buckets the
 * dates — no enrichment, no path resolution, one pass over a list that the
 * command has materialized anyway.
 */
export function useSubjectFacets(filters: SearchFilters, enabled = true): { facets: SubjectFacets | null } {
  // The command is the key: filters arrive as a fresh object every render, and
  // two callers may build the same question with their fields in another order.
  const command = enabled ? `${buildSearchCommand(filters, 1)} --facets` : null;
  const [facets, setFacets] = useState<SubjectFacets | null>(() => command === null ? null : entries.get(command)?.facets ?? null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!command) {
      setFacets(null);
      return;
    }

    let current = true;
    const entry = acquire(command);
    void entry.answer.then((answer) => {
      if (current) setFacets(answer);
    });
    const askAgain = () => setAsked((n) => n + 1);
    watchers.add(askAgain);

    return () => {
      current = false;
      watchers.delete(askAgain);
      release(command, entry);
    };
  }, [command, asked]);

  return { facets };
}
