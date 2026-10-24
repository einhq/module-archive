/**
 * Events as files. An event is a `file` node on the `db` storage tier under
 * `<owner>/events/<name>` whose content is the event body (markdown). Metadata
 * lives in attrs {name, eventType, date, legacy}; geo lives in a child
 * `position` node, not an attr, and the person who wrote the text, when one is
 * named, is a child `writer` softlink to them.
 *
 * Shared by person-add-event and the legacy import bins. Imported via the
 * `@archive/people/events` alias (bins are copied to /tmp and cannot use relative
 * imports, but the import map resolves the alias to this file).
 */
import type { Command } from '@ein/client';
import { slugifyName, uniqueSlug } from '@archive/people/person';

// Concrete vfs/access types derived from the Command surface (no core imports).
type Vfs = Command['sys']['vfs'];
type Access = Command['access'];
/** Create-time props (ownership/mode/acl/birthtime), as accepted by vfs.create. */
type CreateProps = NonNullable<Parameters<Vfs['create']>[4]>['props'];

const NODE_TYPE_FILE = 'file';
/** Event bodies live on the db storage tier (PostgreSQL LOB). */
const DB_TIER = 'db';
const EVENT_MIMETYPE = 'text/markdown';

export type EventType = 'birth' | 'death' | 'marriage' | 'engagement' | 'generic';

export const EVENTS_DIR = 'events';

/** The event file's child softlink to the person who wrote its text. */
const WRITER_LINK = 'writer';

/** The person attr a dated birth or death event is mirrored onto. */
export const LIFE_ATTRS: Partial<Record<string, 'born' | 'died'>> = { birth: 'born', death: 'died' };

type LatLng = { lat: number; lng: number };

type EventSpec = {
  /** display name (attrs.name); defaults to the node slug */
  displayName?: string;
  eventType?: string;
  /** ISO date YYYY[-MM[-DD]] */
  date?: string;
  /** markdown body -> file content */
  body?: string;
  /** geo -> child position node */
  latlng?: LatLng;
  /** path of the person who wrote the text -> child `writer` softlink */
  writer?: string;
  legacy?: unknown;
  /** ownership props (uid/gid/mode/acl/birthtime) for created nodes */
  props?: CreateProps;
};

const enc = new TextEncoder();

/** The longest title `titleFromBody` takes from a body's first line. */
const TITLE_MAX = 80;

/**
 * A name for a new event under `<owner>/events/`, made of its type and date:
 * `marriage-1972-05-20`, `event-1998-06` for a generic one, `birth` with no date.
 * Numbered (`-2`, `-3`, …) when the owner already has one by that name, so a new
 * event never lands on an existing one.
 */
export const newEventName = async (
  vfs: Vfs,
  access: Access,
  ownerPath: string,
  eventType: string | undefined,
  date: string | undefined,
): Promise<string> => {
  const kind = (eventType && eventType !== 'generic' && slugifyName(eventType)) || 'event';
  const day = date ? /^\d{4}(-\d{2}){0,2}/.exec(date)?.[0] : undefined;
  return await uniqueSlug(vfs, access, `${ownerPath}/${EVENTS_DIR}`, day ? `${kind}-${day}` : kind);
};

/** A line of Markdown as plain text: a heading's, quote's or list item's marker and the inline marks taken off, a link reduced to its text. */
const plainLine = (line: string): string =>
  line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])([*_])(\S(?:.*?\S)?)\2(?![\w*])/g, '$1$3')
    .trim();

/** A title for an event that was given none: its body's first line as plain text, cut at a word near TITLE_MAX. */
export const titleFromBody = (body: string | undefined): string | undefined => {
  const first = body?.trim().split('\n', 1)[0];
  const line = first ? plainLine(first) : undefined;
  if (!line) return undefined;
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX).replace(/\s+\S*$/, '')}…`;
};

const clean = <T extends Record<string, unknown>>(obj: T): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
};

const writeAll = async (vfs: Vfs, access: Access, path: string, bytes: Uint8Array): Promise<void> => {
  const handle = await vfs.open(access, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
};

/**
 * Create or update an event file under `<owner>/events/<name>`. Body becomes the
 * file content; latlng (when present) becomes a child `position` node, and writer
 * (when present) a child `writer` link, replacing the one there. Existing events
 * have their attrs/body updated in place.
 */
export const createEvent = async (
  vfs: Vfs,
  access: Access,
  ownerPath: string,
  name: string,
  spec: EventSpec,
): Promise<void> => {
  await vfs.ensure(access, 'directory', ownerPath, EVENTS_DIR, {
    props: spec.props,
  });

  const eventsDir = `${ownerPath}/${EVENTS_DIR}`;
  const path = `${eventsDir}/${name}`;
  const bytes = enc.encode(spec.body ?? '');
  const attrs = clean({
    name: spec.displayName ?? name,
    eventType: spec.eventType ?? 'generic',
    date: spec.date,
    mimetype: EVENT_MIMETYPE,
    size: bytes.length,
    legacy: spec.legacy,
  });

  if (await vfs.exists(access, path)) {
    // tier is immutable and set at creation, so it is not sent on update.
    await vfs.update(access, path, { attrs });
  } else {
    await vfs.create(access, NODE_TYPE_FILE, eventsDir, name, { props: { ...spec.props, tier: DB_TIER }, attrs });
  }
  await writeAll(vfs, access, path, bytes);

  if (spec.latlng) {
    await vfs.ensure(access, 'position', path, 'position', { props: spec.props });
    await writeAll(vfs, access, `${path}/position`, enc.encode(JSON.stringify(spec.latlng)));
  }

  if (spec.writer) {
    const linkPath = `${path}/${WRITER_LINK}`;
    if (await vfs.exists(access, linkPath, { follow: false })) await vfs.unlink(access, linkPath, path, { follow: false });
    await vfs.create(access, 'softlink', path, WRITER_LINK, { props: { uid: access.uid, gid: access.gid, mode: 0o777, softlink: spec.writer } });
  }
};

/**
 * Set the person's `born` / `died` from a dated birth or death event; the timeline,
 * search and the profile read the attr, not the event. `fillOnly` leaves an attr
 * that is already set alone. Anything other than a dated birth or death on a person
 * is ignored.
 */
export const mirrorLifeDate = async (
  vfs: Vfs,
  access: Access,
  ownerPath: string,
  eventType: string | undefined,
  date: string | undefined,
  fillOnly = false,
): Promise<void> => {
  const lifeAttr = eventType ? LIFE_ATTRS[eventType] : undefined;
  if (!lifeAttr || !date) return;
  const node = await vfs.get(access, ownerPath);
  if (node.type !== 'person') return;
  if (fillOnly && (node.attrs as Record<string, unknown>)[lifeAttr]) return;
  await vfs.update(access, ownerPath, { attrs: { [lifeAttr]: date } });
};
