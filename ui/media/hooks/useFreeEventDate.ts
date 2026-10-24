import { useEffect, useMemo, useState } from 'react';
import { type NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { firstFreeDay } from '../../lib/free-event-day.ts';

/**
 * The date to offer a new event in `album`, from the `days` its media were taken on (its
 * `search --facets` days): the first with no event in its `events/` yet (see `firstFreeDay`).
 * The events are read each time `enabled` turns on, so it counts those added since; undefined
 * until they are in and `days` is known, or when the album holds nothing dated.
 */
export function useFreeEventDate(album: string, days: readonly string[] | undefined, enabled: boolean): string | undefined {
  const [eventDates, setEventDates] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    setEventDates(undefined);
    if (!enabled) return;
    let current = true;
    // Most albums have no events directory: no events, not an error.
    void execCommand<NodeChildEntry[]>(`ls -l ${shq(`${album}/events`)}`).catch(() => []).then((entries) => {
      if (!current) return;
      setEventDates(entries.flatMap((entry) => {
        const value = (entry.node.attrs as Record<string, unknown>).date;
        return typeof value === 'string' && value ? [value] : [];
      }));
    });
    return () => {
      current = false;
    };
  }, [album, enabled]);

  return useMemo(() => days && eventDates ? firstFreeDay(days, eventDates) : undefined, [days, eventDates]);
}
