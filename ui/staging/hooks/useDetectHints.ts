import type { StagingDetectAnswer } from '@archive/staging/api';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type DetectHint, detectHints } from '../lib/detect-hint.ts';

/**
 * The hints of the folders newly arrived in the reader's default category (`staging detect`),
 * when `enabled`; read again when `reloadToken` changes. A failed read gives no hints: they are an
 * aid, never in the way. `dismiss` marks a folder `detectDismissed` (by
 * `attrs`), so it is no longer offered, and hides its hint at once.
 */
export function useDetectHints(enabled: boolean, defaultCategory: string, reloadToken = 0) {
  const [answer, setAnswer] = useState<StagingDetectAnswer | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const dismiss = useCallback(async (path: string) => {
    setDismissed((before) => new Set(before).add(path));
    try {
      await execCommand(`attrs -J detectDismissed=true ${shq(path)}`);
    } catch (error) {
      setDismissed((before) => new Set([...before].filter((each) => each !== path)));
      notify({ message: `Could not dismiss the hint: ${error instanceof Error ? error.message : String(error)}`, color: 'red' });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const run = new AbortController();
    execCommand<StagingDetectAnswer>('staging detect', { signal: run.signal }).then(
      (next) => !run.signal.aborted && setAnswer(next),
      () => !run.signal.aborted && setAnswer(null),
    );
    return () => run.abort();
  }, [enabled, reloadToken]);

  const hints = useMemo<DetectHint[]>(
    () => enabled && answer ? detectHints(answer.detections, defaultCategory).filter((hint) => !dismissed.has(hint.path)) : [],
    [enabled, answer, defaultCategory, dismissed],
  );
  return { hints, dismiss };
}
