/**
 * Per-page enrichment: the parts of an entry that cannot come from the indexed
 * query that produced it.
 *
 * All of it is bounded to the page the command is about to emit — a few reads
 * per entry, issued together — never per album or per person in the corpus.
 *
 * The big one is birth and death. Those entries are ordered by `person.born` /
 * `person.died`, because that is what is indexed and what everyone has; but the
 * story — the body, the location — lives in an event file next to the person. So
 * the query gives the ordering and this gives the content.
 */

import { toText } from '@std/streams/to-text';
import type { Command } from '@ein/client';
import type { TimelineCover, TimelineEntry } from '@archive/timeline/api';
import { partnershipYears } from './partnerships.ts';
import { titleFromBody } from '@archive/people/events';
import { COVER_LINK_NAME } from '@ein/paths';

const EVENTS_DIR = 'events';
const PARTNERS_DIR = 'partners';
const THUMBNAILS_DIR = 'thumbnails';
/** A body longer than this is cut; the entry links to the page that has it all. */
const DESCRIPTION_LIMIT = 600;

/** Caches one round of enrichment so a person contributing birth *and* death is read once. */
type Cache = Map<string, Promise<unknown>>;

const once = <T>(cache: Cache, key: string, fn: () => Promise<T>): Promise<T> => {
  const existing = cache.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const created = fn();
  cache.set(key, created);
  return created;
};

const childrenOf = (cmd: Command, cache: Cache, path: string) =>
  once(cache, `children:${path}`, async () => {
    try {
      return await cmd.sys.vfs.children(cmd.access, path);
    } catch {
      return [];
    }
  });

/**
 * A node's display name, cached. Exported because the landing page's
 * anniversaries need names and nothing else enrichment does.
 */
export const nameOf = (cmd: Command, cache: Cache, path: string) =>
  once(cache, `name:${path}`, async () => {
    try {
      const node = await cmd.sys.vfs.get(cmd.access, path);
      return (node.attrs.name as string | undefined) ?? path.split('/').pop() ?? path;
    } catch {
      return path.split('/').pop() ?? path;
    }
  });

/**
 * The `coverPhoto` softlink of an album or a person, and whether it has
 * derivatives — so the UI can ask for a thumbnail rather than the original.
 */
const coverOf = async (cmd: Command, cache: Cache, path: string): Promise<TimelineCover | undefined> => {
  const children = await childrenOf(cmd, cache, path);
  const link = children.find((child) => child.name === COVER_LINK_NAME);
  const target = link?.node.props.softlink;
  if (!target) return undefined;

  const thumb = await once(cache, `thumb:${target}`, async () => {
    try {
      return await cmd.sys.vfs.exists(cmd.access, `${target}/${THUMBNAILS_DIR}`);
    } catch {
      return false;
    }
  });
  return { path: target, thumb };
};

const readBody = async (cmd: Command, path: string): Promise<string | undefined> => {
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
};

/** The `position` child an event carries when it happened somewhere. */
const locationOf = async (cmd: Command, path: string): Promise<string | undefined> => {
  try {
    return await cmd.sys.vfs.exists(cmd.access, `${path}/position`) ? `${path}/position` : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The body, location and exact date of the event backing a birth or a death.
 *
 * The event's slug is not assumed to be `birth`/`death` — only `attrs.eventType`
 * is authoritative — and its stored `name` is deliberately ignored: those are
 * formulaic ("Födelse", "Död"), so the title is composed from the person
 * instead. `size` gates the read, which is what keeps this nearly free: almost
 * no birth event has a body.
 */
const lifeEventDetail = async (
  cmd: Command,
  cache: Cache,
  personPath: string,
  eventType: 'birth' | 'death',
  orderingDate: string,
): Promise<Pick<TimelineEntry, 'description' | 'location' | 'exactDate'>> => {
  // Listed directly rather than checking the person's own children first: that
  // pre-check is a second listing, and a missing directory already comes back
  // as an empty one.
  const events = await childrenOf(cmd, cache, `${personPath}/${EVENTS_DIR}`);
  const event = events.find((child) => (child.node.attrs as Record<string, unknown>).eventType === eventType);
  if (!event) return {};

  const eventPath = `${personPath}/${EVENTS_DIR}/${event.name}`;
  const attrs = event.node.attrs as Record<string, unknown>;
  const size = typeof attrs.size === 'number' ? attrs.size : 0;

  const [description, location] = await Promise.all([
    size > 0 ? readBody(cmd, eventPath) : Promise.resolve(undefined),
    locationOf(cmd, eventPath),
  ]);

  // Only ever a refinement of the date the feed is ordered by — `1815` becoming
  // `1815-03-04`. A date that disagrees is data to fix, not a display to switch.
  const eventDate = typeof attrs.date === 'string' ? attrs.date : undefined;
  const exactDate = eventDate && eventDate !== orderingDate && eventDate.startsWith(orderingDate) ? eventDate : undefined;

  return { description, location, exactDate };
};

/** The single partner of a person, when there is exactly one to name. */
const solePartner = async (cmd: Command, cache: Cache, personPath: string): Promise<string | undefined> => {
  const partners = await childrenOf(cmd, cache, `${personPath}/${PARTNERS_DIR}`);
  const targets = partners.map((child) => child.node.props.softlink).filter((target): target is string => Boolean(target));
  // Several partners and no date on the relation to choose between them: naming
  // one would be a guess, so the title names nobody.
  return targets.length === 1 ? targets[0] : undefined;
};

const MARRIAGE_TITLES: Record<string, (couple: string) => string> = {
  marriage: (couple) => `${couple} married`,
  engagement: (couple) => `${couple} got engaged`,
};

/**
 * The couple a partnership event is about, as paths and as names.
 *
 * The event node names only its owner, so the second half comes from the
 * owner's partner relation. An anniversary needs no such lookup — it is read
 * from that relation and already carries both paths (`partnerships.ts`).
 */
const coupleOf = async (cmd: Command, ownerPath: string, cache: Cache = new Map()): Promise<{ names: string; paths: string[] }> => {
  const [ownerName, partner] = await Promise.all([
    nameOf(cmd, cache, ownerPath),
    solePartner(cmd, cache, ownerPath),
  ]);
  const partnerName = partner ? await nameOf(cmd, cache, partner) : undefined;

  return {
    names: partnerName ? `${ownerName} and ${partnerName}` : ownerName,
    paths: partner ? [ownerPath, partner] : [ownerPath],
  };
};

/**
 * Fill in everything a card needs beyond the ordering query. Mutates in place:
 * the entries are already merged and ordered, and nothing here can change that.
 */
export const enrichPage = async (cmd: Command, entries: TimelineEntry[], opts: { covers: boolean }): Promise<void> => {
  const cache: Cache = new Map();

  await Promise.all(entries.map(async (entry) => {
    switch (entry.kind) {
      case 'album':
      case 'auto-album': {
        if (opts.covers) entry.cover = await coverOf(cmd, cache, entry.path);
        return;
      }

      case 'birth':
      case 'death': {
        const [detail, cover] = await Promise.all([
          lifeEventDetail(cmd, cache, entry.path, entry.kind, entry.date),
          opts.covers ? coverOf(cmd, cache, entry.path) : Promise.resolve(undefined),
        ]);
        Object.assign(entry, detail);
        if (cover) entry.cover = cover;
        return;
      }

      case 'birthday': {
        if (opts.covers) entry.cover = await coverOf(cmd, cache, entry.path);
        return;
      }

      case 'anniversary': {
        // Both people are already in `people` — the relation the entry came
        // from names them — so this is the two names and nothing else. The
        // picture is the half the card points at: a couple has no face of its
        // own, and one of theirs is better than the kind's icon.
        const [names, cover] = await Promise.all([
          Promise.all((entry.people ?? []).map((path) => nameOf(cmd, cache, path))),
          opts.covers ? coverOf(cmd, cache, entry.path) : Promise.resolve(undefined),
        ]);
        entry.title = partnershipYears(entry.eventType, names.join(' and '), entry.years ?? 0);
        if (cover) entry.cover = cover;
        return;
      }

      case 'event': {
        const owner = entry.ownerPath;
        const compose = entry.eventType ? MARRIAGE_TITLES[entry.eventType] : undefined;

        const [body, location] = await Promise.all([
          readBody(cmd, entry.path),
          locationOf(cmd, entry.path),
        ]);
        let description = body;
        if (location) entry.location = location;

        // Marriage and engagement name both people; the event itself names only
        // its owner, so the second comes from the owner's partner relation.
        if (compose && owner) {
          const couple = await coupleOf(cmd, owner, cache);
          entry.title = compose(couple.names);
          entry.people = couple.paths;
        } else if (description && !entry.title.endsWith('…') && titleFromBody(description) === entry.title) {
          // An event added without a name is titled with its body's first line (`titleFromBody`); the card says it once.
          // A title cut short leaves the line in the text, where the rest of it is.
          description = description.slice(description.indexOf('\n') + 1 || description.length).trim() || undefined;
        }
        if (description) entry.description = description;

        if (opts.covers && owner) entry.cover = await coverOf(cmd, cache, owner);
        return;
      }

      case 'move': {
        // The link carries neither name, so both are read here — the person it
        // belongs to and the location it points at — and the title says which way
        // the move went. The picture is the person's: a move is something
        // somebody did, and a location rarely has a cover of its own.
        const person = entry.ownerPath;
        if (!person) return;

        const [personName, locationName, cover] = await Promise.all([
          nameOf(cmd, cache, person),
          nameOf(cmd, cache, entry.path),
          opts.covers ? coverOf(cmd, cache, person) : Promise.resolve(undefined),
        ]);
        entry.title = entry.eventType === 'moved-out' ? `${personName} left ${locationName}` : `${personName} moved to ${locationName}`;
        if (cover) entry.cover = cover;
        return;
      }

      case 'track': {
        // A track is its device's route, named by the device.
        const device = entry.path.slice(0, entry.path.lastIndexOf('/'));
        entry.ownerPath = device;
        entry.title = await nameOf(cmd, cache, device);
        return;
      }
    }
  }));
};
