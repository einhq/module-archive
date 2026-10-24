import { bucketLabel, monthLabel } from '@ein/ui/lib';

type TimeFacetBucket = { key: string; count: number };

export type ScrubberFacets = {
  years: { year: number; count: number }[];
  months: TimeFacetBucket[];
  days: TimeFacetBucket[];
};

type ScrubberMode = 'year' | 'subyear';

export type ScrubberTarget = {
  /** The truncated ISO date sent to `--at`. */
  key: string;
  /** A year in year mode, or `YYYY-MM` in subyear mode. */
  majorKey: string;
};

type ScrubberModel = { mode: ScrubberMode; targets: ScrubberTarget[] };

export type ScrubberSelection = {
  /**
   * Fractional index through the occupied targets: 1.5 is halfway from 1 to 2.
   * Integer `i` is the top of target `i`'s slice of the rail; `targets.length`
   * is the rail's bottom.
   */
  position: number;
  /** Interpolated calendar date sent to a paged source when local scrolling is impossible. */
  date: string;
};

type ScrubberScrollAnchor = { position: number; offset: number };
type ScrubberScrollSection = { key: string; offset: number; size: number };

const YEAR = /^\d{4}$/;
const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const positiveKeys = (buckets: TimeFacetBucket[], pattern: RegExp): string[] =>
  buckets.filter((bucket) => bucket.count > 0 && pattern.test(bucket.key)).map((bucket) => bucket.key);

const ordinal = (key: string): number => {
  const [year, month = '01', day = '01'] = key.split('-');
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
};

/** Whether the occupied dates fit before the same calendar date next year. */
const underOneYear = (keys: string[]): boolean => {
  if (keys.length === 0) return false;
  const ordered = [...keys].sort();
  const first = new Date(ordinal(ordered[0]));
  const boundary = Date.UTC(first.getUTCFullYear() + 1, first.getUTCMonth(), first.getUTCDate());
  return ordinal(ordered[ordered.length - 1]) < boundary;
};

/**
 * The occupied dates exposed by the rail, independent of its pixel height.
 *
 * Long spans expose one equal target per occupied month. A short span exposes
 * each occupied day; if a source only knew a date to the month, that month is a
 * real fallback target rather than a made-up first day. Empty calendar periods
 * never become targets, which keeps a sparse archive usable.
 */
export function buildScrubberModel(facets: ScrubberFacets, ascending = false): ScrubberModel {
  const monthKeys = positiveKeys(facets.months, MONTH);
  const yearOnly = positiveKeys(facets.months, YEAR);
  const dayKeys = positiveKeys(facets.days, DAY);

  const daysByMonth = new Map<string, number>();
  for (const day of facets.days) {
    if (day.count <= 0 || !DAY.test(day.key)) continue;
    const month = day.key.slice(0, 7);
    daysByMonth.set(month, (daysByMonth.get(month) ?? 0) + day.count);
  }

  // A month count larger than its exact-day sum carries content whose day is
  // genuinely unknown. Keep that precision instead of inventing one.
  const partialMonths = facets.months
    .filter((month) => month.count > (daysByMonth.get(month.key) ?? 0) && MONTH.test(month.key))
    .map((month) => month.key);

  const spanKeys = [...dayKeys, ...partialMonths];
  const mode: ScrubberMode = yearOnly.length === 0 && underOneYear(spanKeys.length > 0 ? spanKeys : monthKeys) ? 'subyear' : 'year';

  let keys: string[];
  if (mode === 'subyear') {
    keys = [...dayKeys, ...partialMonths];
  } else {
    keys = [...monthKeys, ...yearOnly];
    // A response may have years without months. It still gets a reachable
    // target, at exactly the precision the facet supplied.
    if (keys.length === 0) keys = facets.years.filter((year) => year.count > 0).map((year) => String(year.year));
  }

  keys = [...new Set(keys)].sort((a, b) => ascending ? a.localeCompare(b) : b.localeCompare(a));
  return {
    mode,
    targets: keys.map((key) => ({ key, majorKey: mode === 'year' ? key.slice(0, 4) : key.slice(0, 7) })),
  };
}

/**
 * Continuous position under a rail pixel.
 *
 * Occupied targets own equal slices of the rail, each starting at its integer
 * position, and the space inside a slice is a real fractional position that a
 * complete layout can map onto the media between two headers. The rail's top
 * pixel is the first target, not a half-slice above it: with a page's own
 * header or an album's lead-in scrolled through in the first slice, one drag
 * moves at one rate from the page top into the first date.
 */
export function positionAtY(model: ScrubberModel, y: number, height: number): number | undefined {
  if (model.targets.length === 0 || height <= 0) return undefined;
  const raw = (Math.max(0, Math.min(height, y)) / height) * model.targets.length;
  return Math.max(0, Math.min(model.targets.length, raw));
}

/** Calendar date between two occupied targets; exact targets keep their original precision. */
export function dateAtPosition(model: ScrubberModel, position: number): string | undefined {
  if (model.targets.length === 0 || !Number.isFinite(position)) return undefined;
  const clamped = Math.max(0, Math.min(model.targets.length - 1, position));
  const before = Math.floor(clamped);
  const after = Math.ceil(clamped);
  if (before === after || clamped - before < 1e-9) return model.targets[before].key;

  const start = ordinal(model.targets[before].key);
  const end = ordinal(model.targets[after].key);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return model.targets[before].key;
  const day = 24 * 60 * 60 * 1000;
  const value = start + Math.round(((end - start) * (clamped - before)) / day) * day;
  return new Date(value).toISOString().slice(0, 10);
}

/** Continuous rail selection used by pointer dragging. */
export function selectionAtY(model: ScrubberModel, y: number, height: number): ScrubberSelection | undefined {
  const position = positionAtY(model, y, height);
  if (position === undefined) return undefined;
  const date = dateAtPosition(model, position);
  return date === undefined ? undefined : { position, date };
}

/** Rail pixel at a fractional occupied-target position. */
export function yAtPosition(model: ScrubberModel, position: number, height: number): number | undefined {
  if (model.targets.length === 0 || height <= 0 || !Number.isFinite(position)) return undefined;
  const clamped = Math.max(0, Math.min(model.targets.length, position));
  return (clamped / model.targets.length) * height;
}

/**
 * Scroll offset between loaded date landmarks.
 *
 * Returning undefined outside the loaded span is intentional: paged callers
 * must fetch that range instead of extrapolating into DOM geometry that does
 * not exist.
 */
export function offsetAtPosition(anchors: readonly ScrubberScrollAnchor[], position: number): number | undefined {
  if (!Number.isFinite(position)) return undefined;
  const ordered = anchors.filter((anchor) => Number.isFinite(anchor.position) && Number.isFinite(anchor.offset)).toSorted((a, b) => a.position - b.position);
  if (ordered.length === 0 || position < ordered[0].position || position > ordered[ordered.length - 1].position) return undefined;

  const afterIndex = ordered.findIndex((anchor) => anchor.position >= position);
  const after = ordered[afterIndex];
  const before = ordered[Math.max(0, afterIndex - 1)];
  if (after.position === before.position) return after.offset;
  const fraction = (position - before.position) / (after.position - before.position);
  return before.offset + (after.offset - before.offset) * fraction;
}

/**
 * Map every loaded date landmark into its section's scroll geometry.
 * Multiple day landmarks inside one month section are spread through its
 * height, so coarser headings do not reintroduce snapping. A section with the
 * target's own key wins over one that only shares its prefix, so a year-only
 * `1975` lands on its own section rather than on `1975-06`.
 */
export function scrollAnchorsForSections(model: ScrubberModel, sections: readonly ScrubberScrollSection[]): ScrubberScrollAnchor[] {
  const mapped = model.targets.flatMap((target, position) => {
    const section = sections.find(({ key }) => key === target.key) ??
      sections.find(({ key }) => key.startsWith(target.key) || target.key.startsWith(key));
    return section ? [{ position, section }] : [];
  });
  const bySection = new Map<ScrubberScrollSection, typeof mapped>();
  for (const anchor of mapped) bySection.set(anchor.section, [...(bySection.get(anchor.section) ?? []), anchor]);

  return mapped.map((anchor) => {
    const peers = bySection.get(anchor.section)!;
    return {
      position: anchor.position,
      offset: anchor.section.offset + (peers.indexOf(anchor) / peers.length) * anchor.section.size,
    };
  });
}

/**
 * Tie the rail's ends to the true scroll bounds.
 *
 * The first date's slice starts at the scroll start rather than at its own
 * header, so whatever a page puts above its first dated section — a title, an
 * album's description or folder grid — is scrolled through at the same rate as
 * the media that follows; the last slice runs on to the true bottom. An end is
 * only tied when that end of the complete model is present in the loaded DOM;
 * paged callers must still fetch unloaded ranges instead of treating their
 * current edge as the archive edge.
 */
export function scrollAnchorsWithBounds(
  anchors: readonly ScrubberScrollAnchor[],
  targetCount: number,
  startOffset: number,
  endOffset: number,
): ScrubberScrollAnchor[] {
  if (targetCount <= 0 || anchors.length === 0) return [...anchors];
  const bounded = anchors.toSorted((a, b) => a.position - b.position);
  if (bounded[0].position === 0 && Number.isFinite(startOffset)) {
    bounded[0] = { position: 0, offset: Math.min(startOffset, bounded[0].offset) };
  }
  if (bounded[bounded.length - 1].position === targetCount - 1 && Number.isFinite(endOffset)) {
    bounded.push({ position: targetCount, offset: endOffset });
  }
  return bounded;
}

/** Top of the slice of the occupied target nearest a truncated ISO date. */
export function yAtDate(model: ScrubberModel, date: string, height: number): number | undefined {
  if (model.targets.length === 0 || height <= 0) return undefined;

  let index = model.targets.findIndex((target) => target.key === date);
  if (index < 0 && model.mode === 'year' && date.length >= 7) {
    index = model.targets.findIndex((target) => target.key === date.slice(0, 7));
  }
  if (index < 0 && model.mode === 'subyear' && date.length >= 7) {
    index = model.targets.findIndex((target) => target.key === date.slice(0, 7));
  }
  if (index < 0) {
    const wanted = ordinal(date);
    if (!Number.isFinite(wanted)) return undefined;
    let distance = Infinity;
    model.targets.forEach((target, candidate) => {
      const next = Math.abs(ordinal(target.key) - wanted);
      if (next < distance) {
        distance = next;
        index = candidate;
      }
    });
  }

  return yAtPosition(model, index, height);
}

export const targetLabel = (mode: ScrubberMode, key: string): string => mode === 'year' ? monthLabel(key) : bucketLabel(key);
export const majorLabel = (mode: ScrubberMode, key: string): string => mode === 'year' ? key : monthLabel(key);

type SeekScheduler = {
  push: (date: string) => void;
  flush: (date?: string) => void;
  cancel: () => void;
};

type TimerApi = {
  set: (callback: () => void, delay: number) => number;
  clear: (id: number) => void;
};

const browserTimers: TimerApi = {
  set: (callback, delay) => setTimeout(callback, delay) as unknown as number,
  clear: (id) => clearTimeout(id),
};

/** Leading-and-trailing throttle used by pointer drags. */
export function createSeekScheduler(emit: (date: string) => void, wait = 125, timers: TimerApi = browserTimers): SeekScheduler {
  let timer: number | undefined;
  let last: string | undefined;
  let pending: string | undefined;

  const send = (date: string): void => {
    last = date;
    emit(date);
  };

  const tick = (): void => {
    timer = undefined;
    if (pending === undefined || pending === last) {
      pending = undefined;
      return;
    }
    const date = pending;
    pending = undefined;
    send(date);
    timer = timers.set(tick, wait);
  };

  return {
    push(date) {
      if (date === last && pending === undefined) return;
      if (timer === undefined) {
        send(date);
        timer = timers.set(tick, wait);
      } else {
        pending = date;
      }
    },
    flush(date) {
      if (date !== undefined && date !== last) pending = date;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      if (pending !== undefined && pending !== last) send(pending);
      pending = undefined;
    },
    cancel() {
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
