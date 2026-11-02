/**
 * The answers place names were looked up from, kept so a place is asked of a service once
 * (`@archive/location/place-cache`).
 *
 * One JSON file per map tile (`tileOf`) under `PLACES_CACHE`, on the db tier: the named features
 * Overpass has in and around the tile, and the points Nominatim was asked about there with the
 * town it gave, or none. A point is named from the files whenever they can: from the features
 * always, from a Nominatim answer within `TOWN_REUSE_M`, in its tile or the one beside it. Only a
 * tile never fetched, or a point with no answer near it, goes to the network; `refresh` asks again,
 * once per tile and point.
 */

import { basename, dirname } from '@std/path';
import { toText } from '@std/streams';
import { type Command, haversineMeters } from '@ein/client';
import { SOURCES_ROOT } from '@archive/paths';
import { fetchOverpassTile, nominatimTown, type OverpassElement, pickPlace, type PlaceName, tileOf } from '@archive/location/place-name';

/** Where the answers are kept. */
const PLACES_CACHE = `${SOURCES_ROOT}/places`;

/** A town Nominatim gave for a point holds for the points this close to it. */
const TOWN_REUSE_M = 500;

/** One tile's file. */
type TileCache = {
  /** When Overpass was asked for the tile, ISO, and what it answered; absent until it is. */
  fetchedAt?: string;
  elements?: OverpassElement[];
  /** The points Nominatim was asked about, when, and the town it gave; no `name` where it gave none. */
  towns: { lat: number; lng: number; at: string; name?: string }[];
};

type Vfs = Command['sys']['vfs'];
type Access = Command['access'];

/** `path` and every folder above it that is missing. */
const ensureFolder = async (vfs: Vfs, access: Access, path: string): Promise<void> => {
  if (path === '/' || await vfs.exists(access, path)) return;
  await ensureFolder(vfs, access, dirname(path));
  await vfs.ensure(access, 'directory', dirname(path), basename(path));
};

type PlaceNamerOptions = {
  /** Overpass endpoints, tried in turn. */
  overpass: string[];
  /** Nominatim's reverse endpoint. */
  nominatimReverse?: string;
  /** Ask the services again rather than answer from the files, once per tile and point. */
  refresh?: boolean;
  /** Keep what the services answer; off for a dry run. */
  write: boolean;
};

/** Names points from the files, and from the services where the files have no answer. */
export class PlaceNamer {
  /** How many requests went to Overpass and Nominatim. */
  requests = 0;
  private tiles = new Map<string, TileCache>();
  private refreshed = new Set<string>();

  constructor(private cmd: Command, private opts: PlaceNamerOptions) {}

  /**
   * The name of the place at a point (see `@archive/location/place-name`); undefined where nothing
   * names it. Throws when a service it had to ask failed, so that a failure is not taken for a
   * place without a name.
   */
  async name(lat: number, lng: number): Promise<PlaceName | undefined> {
    const tile = tileOf(lat, lng);
    const cache = await this.read(tile.key);
    if (!cache.elements || (this.opts.refresh && !this.refreshed.has(tile.key))) {
      this.requests++;
      cache.elements = await fetchOverpassTile(this.opts.overpass, tile);
      cache.fetchedAt = new Date().toISOString();
      this.refreshed.add(tile.key);
      await this.write(tile.key, cache);
    }
    const place = pickPlace(lat, lng, cache.elements);
    if (place) return place;

    const known = this.opts.refresh ? undefined : await this.townNear(lat, lng);
    if (known) return known.name ? { name: known.name, kind: 'town', source: 'nominatim' } : undefined;
    this.requests++;
    const name = await nominatimTown(lat, lng, this.opts.nominatimReverse);
    cache.towns = [
      ...cache.towns.filter((town) => haversineMeters(lat, lng, town.lat, town.lng) > TOWN_REUSE_M),
      { lat, lng, at: new Date().toISOString(), ...(name ? { name } : {}) },
    ];
    await this.write(tile.key, cache);
    return name ? { name, kind: 'town', source: 'nominatim' } : undefined;
  }

  /** A town answer within `TOWN_REUSE_M` of a point, in its tile or one beside it. */
  private async townNear(lat: number, lng: number): Promise<TileCache['towns'][number] | undefined> {
    const dLat = TOWN_REUSE_M / 111_320;
    const dLng = dLat / Math.max(Math.cos(lat * Math.PI / 180), 0.01);
    const keys = new Set([-1, 1].flatMap((i) => [-1, 1].map((j) => tileOf(lat + i * dLat, lng + j * dLng).key)));
    for (const key of keys) {
      const town = (await this.read(key)).towns.find((town) => haversineMeters(lat, lng, town.lat, town.lng) <= TOWN_REUSE_M);
      if (town) return town;
    }
    return undefined;
  }

  /** A tile's file, read once per run; empty when there is none or it cannot be read. */
  private async read(key: string): Promise<TileCache> {
    let cache = this.tiles.get(key);
    if (cache) return cache;
    cache = { towns: [] };
    const path = `${PLACES_CACHE}/${key}.json`;
    try {
      if (await this.cmd.sys.vfs.exists(this.cmd.access, path)) {
        const handle = await this.cmd.sys.vfs.open(this.cmd.access, path, { mode: 'r' });
        try {
          const kept = JSON.parse(await toText(handle.readable)) as Partial<TileCache>;
          cache = { ...kept, towns: Array.isArray(kept.towns) ? kept.towns : [] };
        } finally {
          await handle.close();
        }
      }
    } catch {
      // A file that cannot be read is asked again and written over.
    }
    this.tiles.set(key, cache);
    return cache;
  }

  /**
   * Write a tile's file, made with its folders when missing. Whoever names a place writes it: the
   * folders take `/archive/sources`'s group, so the next person can write them too.
   */
  private async write(key: string, cache: TileCache): Promise<void> {
    if (!this.opts.write) return;
    const { vfs } = this.cmd.sys;
    const { access } = this.cmd;
    await ensureFolder(vfs, access, PLACES_CACHE);
    await vfs.ensure(access, 'file', PLACES_CACHE, `${key}.json`, { props: { tier: 'db' }, attrs: { mimetype: 'application/json' } });
    const handle = await vfs.open(access, `${PLACES_CACHE}/${key}.json`, { mode: 'w' });
    try {
      await handle.write(new TextEncoder().encode(JSON.stringify(cache)));
    } finally {
      await handle.close();
    }
  }
}
