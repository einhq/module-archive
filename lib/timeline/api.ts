/**
 * What the timeline commands answer with (`@archive/timeline/api`): what an entry is. How a page
 * boundary is encoded is `paging.ts`. Import-free, like every command API.
 *
 * Every source produces entries keyed on the same two fields — an ISO date
 * string and a key unique across the whole feed — because that pair is what
 * lets several unrelated sources be merged and paged as one list.
 */

export const TIMELINE_KINDS = ['album', 'auto-album', 'anniversary', 'birth', 'death', 'birthday', 'event', 'move', 'track'] as const;
export type TimelineKind = typeof TIMELINE_KINDS[number];

export const isTimelineKind = (value: string): value is TimelineKind => (TIMELINE_KINDS as readonly string[]).includes(value);

/**
 * How many occurrences of a recurring thing to synthesize.
 *
 * The same three settings answer for birthdays and for wedding anniversaries,
 * because it is the same question about both: every year, only the round
 * numbers, or none. They are separate flags all the same — an archive whose
 * every birthday is wanted does not necessarily want every anniversary.
 */
export const RECURRENCE_MODES = ['all', 'milestone', 'none'] as const;
export type RecurrenceMode = typeof RECURRENCE_MODES[number];

export type TimelineCover = {
  path: string;
  /** A `thumbnails/` rendition exists, so the UI can ask for one. */
  thumb: boolean;
};

export type TimelineEntry = {
  kind: TimelineKind;
  /** Unique across the feed and stable across pages; see `entryKey`. */
  key: string;
  /** ISO date, possibly partial (`YYYY`, `YYYY-MM`). Orders the feed. */
  date: string;
  /**
   * A more precise form of `date` found while enriching — `1815` turning out to
   * be `1815-03-04`. Display only: ordering and paging stay on `date`, which is
   * the indexed value.
   */
  exactDate?: string;
  /** The far end of a span, for albums and tracks. */
  endDate?: string;
  /** The node this entry is about. */
  path: string;
  /** Composed by the command — never read from a stored name, except `generic` events. */
  title: string;
  /** The person, album or location an event hangs off. */
  ownerPath?: string;
  /** Everyone the entry is about, so a card can link each of them. */
  people?: string[];
  description?: string;
  /** Path of the event's `position` node. */
  location?: string;
  count?: number;
  points?: number;
  age?: number;
  /** Which occurrence this is: the age, or the years a couple has been together. */
  years?: number;
  eventType?: string;
  cover?: TimelineCover;
};
