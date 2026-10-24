import type { DuplicatePage } from '@archive/media/api';
import { execCommand } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import { setsCommand } from '../lib/duplicate-sets.ts';

/**
 * The duplicate sets of a suggested group's members, or of one staged file (`staging duplicates
 * <path>`), read once `wanted` and again when `version` — which members a group has — changes or
 * `reread` is called. A read no longer wanted is given up; until the first answer, and when it
 * cannot be read, there are none.
 */
export function useDuplicateSets(path: string, version: string, wanted: boolean): { page: DuplicatePage | null; reread: () => void } {
  const key = `${path}\n${version}`;
  const [state, setState] = useState<{ key: string; page: DuplicatePage | null }>({ key, page: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    execCommand<DuplicatePage>(setsCommand(path), { signal: controller.signal })
      .then((page) => setState({ key, page }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, page: null });
      });
    return () => controller.abort();
  }, [key, wanted, attempt]);

  return { page: state.key === key ? state.page : null, reread: () => setAttempt((value) => value + 1) };
}
