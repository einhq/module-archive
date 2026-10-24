import { LOCATIONS_ROOT } from '@archive/paths';
import { useCallback, useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { LocationEntry } from '@archive/location/api';
export type { LocationEntry } from '@archive/location/api';

type UseLocationsResult = {
  locations: LocationEntry[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * List location nodes under /locations, through `location-list`.
 */
export function useLocations(rootPath: string = LOCATIONS_ROOT, opts: { withCoordinates?: boolean } = {}): UseLocationsResult {
  const withCoordinates = opts.withCoordinates ?? true;
  const [locations, setLocations] = useState<LocationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchLocations = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      setLocations(await execCommand<LocationEntry[]>(`location-list${withCoordinates ? '' : ' --without-coordinates'} ${shq(rootPath)}`));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setLocations([]);
    } finally {
      setLoading(false);
    }
  }, [rootPath, withCoordinates]);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

  return { locations, loading, error, refetch: fetchLocations };
}
