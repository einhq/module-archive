import { DEV_PATH } from '@ein/paths';

/** The id of the tab archive gives a device's page with a track (`ui/nav.json`, `device.tabs`). */
const TRIPS_TAB = 'archive.trips';

/**
 * The page of the device at or above `path` (`/dev/<device>`, or a track of it): `/devices/<name>`,
 * on its Trips tab with `trips`. Undefined for a path under no device.
 */
export const deviceRoute = (path: string, opts: { trips?: boolean } = {}): string | undefined => {
  if (!path.startsWith(`${DEV_PATH}/`)) return undefined;
  const name = path.slice(DEV_PATH.length + 1).split('/')[0];
  return name ? `/devices/${encodeURIComponent(name)}${opts.trips ? `?tab=${TRIPS_TAB}` : ''}` : undefined;
};
