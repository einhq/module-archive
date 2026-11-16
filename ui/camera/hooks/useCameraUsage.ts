import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { CameraUsage } from '@archive/camera/api';

/**
 * What the maker notes of a camera's pictures say about it (`camera-usage`), null while it is read
 * or when it cannot be: the page draws the rest of the camera without it.
 */
export function useCameraUsage(path: string | null): { usage: CameraUsage | null; refetch: () => void } {
  const [usage, setUsage] = useState<CameraUsage | null>(null);

  const fetchUsage = useCallback(async () => {
    if (!path) return;
    setUsage(await execCommand<CameraUsage>(`camera-usage ${shq(path)}`).catch(() => null));
  }, [path]);

  useEffect(() => {
    setUsage(null);
    fetchUsage();
  }, [fetchUsage]);

  return { usage, refetch: fetchUsage };
}
