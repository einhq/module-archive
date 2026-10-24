import type { TimelineEntry } from '@archive/timeline/api';
export type { RecurrenceMode, TimelineEntry, TimelineKind } from '@archive/timeline/api';

export type TimelineGroup = {
  /** `YYYY-MM`, or a bare `YYYY` for entries dated only to the year. */
  key: string;
  label: string;
  entries: TimelineEntry[];
};

/** One page of the `timeline` command. */
export type TimelinePage = { cursor: string | null; entries: TimelineEntry[] };

/**
 * What the feed is narrowed to, beyond its kinds.
 *
 * Named after the command's own flags. A person or a location matches two ways —
 * an entry *about* them, and an album *holding* their media — which the command
 * resolves; nothing here has to know the difference.
 */
export type TimelineFilters = {
  /** Free text over an entry's title and description. */
  query?: string;
  /** Person slug or path. */
  person?: string;
  /** Location slug or path. */
  location?: string;
  /** Label; matches the albums holding media carrying it. */
  tag?: string;
};
