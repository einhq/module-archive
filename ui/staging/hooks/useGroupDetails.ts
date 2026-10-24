import type { AlbumInfoAnswer } from '@archive/media/api';
import type { StagingGroupDetail } from '@archive/staging/api';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GroupRow } from './useGroupIndex.ts';

/** Details kept at most; the oldest go first. */
const KEPT = 60;

/** What a row's details were read for: its members and its matches as they were then. */
const versionOf = (row: GroupRow): string => `${row.staging.memberKey}:${row.staging.matchedAt ?? ''}`;

/**
 * The parts and candidates of `rows` (the cursor's group and the next ones), from one
 * `album info` of those not read yet or changed since — their members or their matches — by path.
 * A read under way is given up when the rows it was for change.
 */
export function useGroupDetails(rows: readonly GroupRow[]): ReadonlyMap<string, StagingGroupDetail> {
  const [details, setDetails] = useState<ReadonlyMap<string, { version: string; detail: StagingGroupDetail }>>(() => new Map());
  const held = useRef(details);
  held.current = details;
  const wanted = rows.map((row) => `${row.path}\n${versionOf(row)}`).join('\n');

  useEffect(() => {
    const due = rows.filter((row) => held.current.get(row.path)?.version !== versionOf(row));
    if (due.length === 0) return;
    const controller = new AbortController();
    execCommand<AlbumInfoAnswer>(`album info ${due.map((row) => shq(row.path)).join(' ')}`, { signal: controller.signal })
      .then((answer) => {
        if (controller.signal.aborted) return;
        setDetails((previous) => {
          const next = new Map(previous);
          for (const album of answer.albums) {
            const row = due.find((each) => each.path === album.path);
            if (!row || !album.suggested) continue;
            next.delete(album.path);
            next.set(album.path, { version: versionOf(row), detail: album.suggested });
          }
          while (next.size > KEPT) next.delete(next.keys().next().value!);
          return next;
        });
      })
      .catch(() => {
        // Read again when the rows change; until then the column shows the row's own summary.
      });
    return () => controller.abort();
  }, [wanted]);

  return useMemo(() => new Map([...details].map(([path, { detail }]) => [path, detail])), [details]);
}
