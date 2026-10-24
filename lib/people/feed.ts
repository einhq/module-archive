/**
 * What `person-timeline`, `location-timeline` and the device area's
 * `device-timeline` build their feeds from.
 *
 * Each answers "what happened here" for one subject, unpaged, in the core feed's
 * wire shape — so the UI draws them with the same card as the corpus-wide
 * `timeline`. The reads they share live here.
 */
import { type Command, shq } from '@ein/client';
import type { SearchGroupsResponse } from '@ein/api';
import { COVER_LINK_NAME } from '@ein/paths';
import type { TimelineCover, TimelineEntry } from '@archive/timeline/api';
import { toText } from '@std/streams/to-text';
import { basename } from '@std/path';

export type { TimelineCover, TimelineEntry };

const THUMBNAILS_DIR = 'thumbnails';
const EVENTS_DIR = 'events';
/** A body longer than this is cut; the card links to the page that has it all. */
const DESCRIPTION_LIMIT = 600;

export async function attrsOf(cmd: Command, path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await cmd.sys.vfs.get(cmd.access, path)).attrs as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const nameOf = async (cmd: Command, path: string): Promise<string> => ((await attrsOf(cmd, path))?.name as string | undefined) ?? basename(path);

/**
 * The `coverPhoto` softlink and whether derivatives exist, as the core feed
 * reports it.
 *
 * The link is fetched by name rather than found in a listing of the owner: every
 * album is asked once, and listing an album to find one child means aggregating
 * the several hundred files it holds.
 */
export async function coverOf(cmd: Command, path: string): Promise<TimelineCover | undefined> {
  let target: string | undefined;
  try {
    target = (await cmd.sys.vfs.get(cmd.access, `${path}/${COVER_LINK_NAME}`, { follow: false })).props.softlink;
  } catch {
    return undefined; // no cover, or not readable
  }
  if (!target) return undefined;

  try {
    return { path: target, thumb: await cmd.sys.vfs.exists(cmd.access, `${target}/${THUMBNAILS_DIR}`) };
  } catch {
    return { path: target, thumb: false };
  }
}

export async function readBody(cmd: Command, path: string): Promise<string | undefined> {
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      const text = (await toText(handle.readable)).trim();
      if (!text) return undefined;
      return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT)}…` : text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * How many VFS round trips a feed has in flight at once.
 *
 * Unbounded `Promise.all` over a well-photographed person fires hundreds of
 * lookups at the shared PostgreSQL pool in one go, which starves every other
 * shell on the instance (ein/core#40). Wide enough to hide the latency,
 * narrow enough to stay a guest.
 */
const CONCURRENCY = 12;

/** `Promise.all` with a ceiling on how much is in flight. Order is preserved. */
export async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * The albums holding media of a subject, given as `search --subject` takes it (`person:<path>`).
 *
 * `search --group-by album` walks the subject set the search command materializes
 * anyway and groups it by container, so this is one exec rather than a query
 * per album. Undated albums are dropped: a feed cannot place them.
 */
export async function albumEntries(cmd: Command, subject: string): Promise<TimelineEntry[]> {
  const result = await cmd.execute(`JSON_OUTPUT=1 search --subject ${shq(subject)} --group-by album`);
  if (result.code !== 0) return [];

  let albums: SearchGroupsResponse['groups'];
  try {
    albums = (JSON.parse(result.stdout) as SearchGroupsResponse).groups ?? [];
  } catch {
    return [];
  }

  // In parallel, bounded: a well-photographed person is in a hundred and sixty
  // albums, and a hundred and sixty round trips one after another is the
  // difference between a tab that opens and one that hangs.
  return await mapLimited(
    albums.filter((album) => album.from),
    async (album): Promise<TimelineEntry> => ({
      kind: 'album',
      key: `${album.path}#album`,
      date: album.from!,
      ...(album.to && album.to !== album.from ? { endDate: album.to } : {}),
      path: album.path,
      title: album.name,
      count: album.count,
      ...(await coverOf(cmd, album.path).then((cover) => cover ? { cover } : {})),
    }),
  );
}

/**
 * The dated stories under a location's or a device's own `events/`, written there with Add event
 * (`person-add-event`) or by the importer. Undated ones are dropped: a feed cannot place them.
 */
export async function ownEventEntries(cmd: Command, owner: string): Promise<TimelineEntry[]> {
  let children;
  try {
    children = await cmd.sys.vfs.children(cmd.access, `${owner}/${EVENTS_DIR}`);
  } catch {
    return [];
  }

  const dated = children.filter((child) => typeof (child.node.attrs as Record<string, unknown>).date === 'string');
  return await mapLimited(dated, async (child): Promise<TimelineEntry> => {
    const attrs = child.node.attrs as Record<string, unknown>;
    const path = `${owner}/${EVENTS_DIR}/${child.name}`;
    const description = typeof attrs.size === 'number' && attrs.size > 0 ? await readBody(cmd, path) : undefined;
    return {
      kind: 'event',
      key: `${path}#event`,
      date: attrs.date as string,
      path,
      title: (attrs.name as string | undefined) || child.name,
      ownerPath: owner,
      eventType: (attrs.eventType as string | undefined) ?? 'generic',
      ...(description ? { description } : {}),
    };
  });
}

/** Newest first, matching every other feed here. Ties break on the key so the order is stable between calls. */
export const newestFirst = (a: TimelineEntry, b: TimelineEntry): number => a.date === b.date ? a.key.localeCompare(b.key) : (a.date < b.date ? 1 : -1);

/** The feed as text, one line per entry, for a shell that did not ask for JSON. */
export async function writeFeed(cmd: Command, entries: TimelineEntry[]): Promise<void> {
  for (const entry of entries) {
    const date = entry.exactDate ?? entry.date;
    const span = entry.endDate && entry.endDate.slice(0, 10) !== date.slice(0, 10) ? ` .. ${entry.endDate.slice(0, 10)}` : '';
    await cmd.writeLn(`${date.slice(0, 10).padEnd(10)}${span.padEnd(14)} ${entry.kind.padEnd(8)} ${entry.title}`);
  }
}
