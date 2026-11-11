import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { RawScanReport } from '@archive/media/api';

/**
 * How many of an album's camera RAWs have a picture of the same name to be filed under
 * (`raw <album>`), files it links to included; 0 until read, and when it cannot be. Read only
 * when `enabled`, since only someone who may change the album can file them.
 */
export function useAlbumRaw(path: string, enabled: boolean): { sortable: number; refetch: () => void } {
  const [sortable, setSortable] = useState(0);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSortable(0);
    if (!path || !enabled) return;
    execCommand<RawScanReport>(`raw ${shq(path)}`)
      .then((report) => {
        if (!cancelled) setSortable(report.pairs.filter((pair) => pair.partners[0]?.reasons.includes('stem')).length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, enabled, version]);

  return { sortable, refetch: () => setVersion((value) => value + 1) };
}
