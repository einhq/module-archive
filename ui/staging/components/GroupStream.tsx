import type { AlbumAddResult, DuplicateResolveResult, DuplicateSeparateResult, DuplicateSet } from '@archive/media/api';
import type {
  MatchConfidence,
  StagingAcceptResult,
  StagingCategoryStatus,
  StagingDiscardResult,
  StagingEditResult,
  StagingLaterResult,
  StagingPromoteResult,
  StagingUndoResult,
} from '@archive/staging/api';
import { type Proposal, proposalInputOf, proposeDestination } from '@archive/staging/proposal';
import { EmptyState, PageLoader, SectionStream, type SectionStreamHandle, TablerIcon } from '@ein/ui/components';
import {
  type MediaSelection,
  type SectionOrder,
  type SectionSelection,
  useCommandQueue,
  useElementWidth,
  useHeaderHeight,
  useLasso,
  usePersistedState,
  usePhone,
  useSectionSelection,
  useShortcutHelp,
} from '@ein/ui/hooks';
import {
  forgetMediaSet,
  type GridKey,
  gridNeighbour,
  type LassoHits,
  lassoSelection,
  loadMediaSet,
  type MediaDragPayload,
  prefetchMediaSet,
  sameHits,
  shq,
  type TileBox,
  tileIndex,
} from '@ein/ui/lib';
import { dismissToast, execCommand, type MediaItem, notify, openMediaAt } from '@ein/ui/signals';
import { Alert, Box, Button, Group, Menu, SegmentedControl, Select, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { albumRoute } from '../../media/lib/album-path.ts';
import { type AlbumChoice, AlbumPickerDialog } from '../../media/components/AlbumPickerDialog.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { TimelineScrubber } from '../../components/TimelineScrubber.tsx';
import { railFacets, seekIndex } from '../lib/scrubber-facets.ts';
import { type GroupRow, useGroupIndex } from '../hooks/useGroupIndex.ts';
import { useGroupDetails } from '../hooks/useGroupDetails.ts';
import { useDuplicateSets } from '../hooks/useDuplicateSets.ts';
import { groupDuplicates, separateCommand } from '../lib/duplicate-sets.ts';
import { stepCandidate } from '../lib/compare.ts';
import * as commands from '../lib/decision-commands.ts';
import { type AlbumTarget, CONFIDENCE_WORDS, parseRecent, parseTarget, proposalLabel, stickyTarget, withRecent } from '../lib/destinations.ts';
import { inLane, isLane, isLaneGroup, laneCounts, LANES, type StagingLane } from '../lib/lanes.ts';
import { nameGiver } from '../lib/merge-name.ts';
import { type PartSection, stepPart } from '../lib/part-sections.ts';
import { nextAfterDecision, stepFrom, streamOrder } from '../lib/stream-order.ts';
import { TRIAGE_HELP, type TriageAction, type TriageScope } from '../lib/triage-keys.ts';
import { type StreamGeometry, streamHits } from '../lib/lasso-hits.ts';
import {
  acceptChunks,
  type Chunk,
  discardChunks,
  fileChunks,
  intoGroupChunks,
  laterChunks,
  newAlbumChunks,
  noParts,
  partsCount,
  type SelectionParts,
  selectionParts,
} from '../lib/selection-command.ts';
import { type BulkHandle, type BulkSpec, useBulkRun } from '../hooks/useBulkRun.ts';
import { useTriageKeys } from '../hooks/useTriageKeys.ts';
import { BulkConfirmDialog } from './BulkConfirmDialog.tsx';
import { CompareDialog } from './CompareDialog.tsx';
import { DeleteGroupDialog } from './DeleteGroupDialog.tsx';
import { DestinationColumn, type DropDestination } from './DestinationColumn.tsx';
import { DiscardGroupDialog } from './DiscardGroupDialog.tsx';
import { GroupPickerDialog } from './GroupPickerDialog.tsx';
import type { GroupActions, GroupDrop, GroupFailure, GroupSelected } from './GroupHeader.tsx';
import { closedSectionHeight, GroupSection, type PartMatch, SECTION_METRICS } from './GroupSection.tsx';
import { NameDialog } from './NameDialog.tsx';
import { StagingDock } from './StagingDock.tsx';

type Props = {
  /** The category whose suggested groups are sorted, and whose destination is the default target. */
  category: StagingCategoryStatus;
  /** Something was filed, merged or deleted, so the category's numbers changed; called once a run of decisions has rested. */
  onChanged: () => void;
  /** The Files tab, where the files without a group yet are. */
  onShowFiles: () => void;
  stillIndexing: number;
};

/**
 * A decision on a group, as the queue carries it out: the one command, what it is called while it
 * waits, what a failure and a success say, the journal entries its answer names, and whether the
 * whole group leaves the stream (rather than some of its pictures).
 */
type Decision<T> = {
  row: GroupRow;
  whole: boolean;
  command: string;
  label: string;
  failed: string;
  done: (answer: T) => string;
  journal: (answer: T) => string[];
  /** Refuse an answer that says the group changed under the reader, rather than file it. */
  check?: (answer: T) => void;
  /** Where the cursor goes; by default the next group still to decide. */
  cursorTo?: string | null;
  /** The album filed into, remembered among the recent ones. */
  filedInto?: (answer: T) => AlbumTarget | undefined;
  /** How to undo it when it changed no journaled files: `staging later` with `--off` (true) or without. */
  laterOff?: boolean;
  /** The group is still there once it is done, in another lane, as this says: it is changed so and read again, not dropped. */
  stays?: (row: GroupRow) => GroupRow;
  /** An edit of the groups: those it made or changed are read again, and those it removed leave. */
  regrouped?: (answer: T) => StagingEditResult;
};

/** A decision of this session, newest last: what Z takes back. A run over many groups is undone whole. */
type Taken =
  | { id: number; label: string; row: GroupRow; queued: number; journal: string[] | null; laterOff?: boolean; bulk?: undefined }
  | { id: number; label: string; bulk: BulkHandle };

/** Groups at least this large ask before X discards them. */
const DISCARD_ASKS = 200;
/** The destination column needs this much of the page's width; widened to compare (C), it takes this share of it. */
const COLUMN_MIN_WIDTH = 1100;
const COLUMN_WIDTH = 300;
const COMPARE_SHARE = 0.5;
/** The groups whose parts and candidates are read ahead: the cursor's and the next ones. */
const DETAILS_AHEAD = 2;

/** The groups after the cursor whose pictures are asked for ahead; one further away than this is given up. */
const PREFETCH_AHEAD = 2;
const PREFETCH_KEEP = 3;
/** The cursor goes into the URL once it has rested this long, so a held J does not write history. */
const URL_DEBOUNCE_MS = 400;
/** Below this many groups the stream is a few screens long, and a time rail has nothing to do. */
const RAIL_MIN_GROUPS = 30;
/** Room kept clear on the right for the rail, so no section's actions sit under it. */
const RAIL_GUTTER = 48;
/** The category's numbers are asked for again this long after the last decision, once for a run of them. */
const STATUS_AFTER_MS = 5000;

/** Groups the G picker offers on each side of the open one before a search. */
const PICKER_NEIGHBOURS = 5;
/** Room kept above a part brought to the reading line, under the open group's own header. */
const PART_MARGIN = 8;

/** A drop that is one group whole, which the decisions on one group take, with their own Undo. */
const oneGroup = (what: SelectionParts<GroupRow>): GroupRow | null => what.groups.length === 1 && what.partial.length === 0 && what.files.length === 0 ? what.groups[0] : null;

/** Two groups merge only when neither is a lane's. */
const mergeable = (a: GroupRow, b: GroupRow): boolean => !isLaneGroup(a) && !isLaneGroup(b);

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;
const groupCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'group' : 'groups'}`;
/** A selection as words: "3 groups · 412 photos", or the photos alone. */
const selectionWords = (count: { groups: number; files: number }) => count.groups > 0 ? `${groupCount(count.groups)} · ${photos(count.files)}` : photos(count.files);

/** A closed section's padding at either side, as `GroupSection` draws it (Mantine's `md`). */
const SECTION_INSET = 16;
const without = <T,>(set: ReadonlySet<T>, value: T) => {
  const next = new Set(set);
  next.delete(value);
  return next;
};
const withoutKey = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

/**
 * A closed section's outline — its two header lines and its two strip rows — as an image the
 * stream repeats under the sections, for a fling that mounts nothing until it slows.
 */
const skeletonImage = (phone: boolean): string => {
  const metrics = phone ? SECTION_METRICS.phone : SECTION_METRICS.desktop;
  const height = closedSectionHeight(phone);
  const fill = 'rgba(255,255,255,0.045)';
  const rows = [0, 1].map((row) => `<rect x='16' y='${metrics.header + row * (metrics.row + 3)}' width='968' height='${metrics.row}' fill='${fill}'/>`).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 ${height}' preserveAspectRatio='none'>` +
    `<rect x='16' y='${metrics.header / 2 - 14}' width='260' height='12' rx='3' fill='${fill}'/>` +
    `<rect x='16' y='${metrics.header / 2 + 6}' width='180' height='9' rx='3' fill='${fill}'/>${rows}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

/**
 * The Sort tab: a category's suggested albums (those in its groups directory) as one stream, oldest
 * first, the cursor's group open and the others closed to a strip of their pictures; on a wide page
 * the destination column beside it.
 *
 * J and K move the cursor; Enter applies the group's proposal; 1, 2 and 3 file it into its candidate
 * albums, `,` and `.` move the highlight among them, R says the highlighted one is not where it
 * goes, and C widens the column to compare that album's pictures with the group's; N and P make it
 * a new album, shared or private; A files it into any album; B into the sticky target (⇧B chooses
 * it); X discards it; L puts it aside for later; E renames it; M merges it into the group above and
 * ⇧M the group below into it; T sets the time of its pictures; Z undoes the last decision of the
 * session. An Everyday lane's proposal files the days that match an album, each into its album;
 * a part of it with a match goes there on Enter.
 *
 * Inside the open group, `[` and `]` step through its parts (a day each, or a month each in a long
 * group); with a part, or pictures of the group selected (Space on a picture, or a click once one
 * is), Enter, N, P, A, B and X act on those alone, S splits the group before them (in a lane it
 * makes them a group of their own), `<` and `>` move them into the group above or below, and G
 * into any group or a new one. With a picture under the arrows' cursor, S, `<`, `>` and G act on
 * it. Edits of the groups are journaled and undone as decisions are. A long open group has a time
 * rail of its own pictures in place of the stream's.
 *
 * A decision takes its group out of the stream at once and moves the cursor on; its one command
 * waits its turn in the page's serial queue, and a reload asks first while any is waiting. One
 * that fails brings the group back with why, and Retry. Each one done says so in a toast with
 * Undo, which runs `staging undo` on its journal entries — after a reload, the Done tab does.
 *
 * On a desktop a selection reaches across groups: a header's box (or a click on its name with
 * Ctrl or Cmd) selects a group whole, Shift selects on from where the selection started — the
 * rest of that group, the groups between whole, the head of the last — and so do Shift+J and
 * Shift+K; the Select menu takes a lane's groups, or those whose proposal is sure; a lasso drawn
 * from the background or an unselected picture takes the closed groups it covers and the open
 * group's pictures it touches. A selection past the open group is decided on as many groups:
 * Enter accepts their proposals after a plan, N, P, A and B file them, X discards them and L puts
 * them aside, each a run of calls within the verbs' caps with a progress toast, Cancel and Undo
 * all (`hooks/useBulkRun.ts`). Selected pictures, or a header's grip, drag onto the destination
 * column's rows and onto other groups' headers, as the same commands.
 */
export function GroupStream({ category, onChanged, onShowFiles, stillIndexing }: Props) {
  useSignals();
  const albumsPath = category.albumsPath;
  const phone = usePhone();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const readingLine = useHeaderHeight();
  const streamRef = useRef<SectionStreamHandle>(null);
  const [widthRef, width] = useElementWidth<HTMLDivElement>();
  useShortcutHelp('Staging', TRIAGE_HELP);
  const queue = useCommandQueue();
  const selection = useSectionSelection();
  const clearSelection = selection.clear;

  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [failures, setFailures] = useState<ReadonlyMap<string, GroupFailure>>(() => new Map());
  const [filed, setFiled] = useState(0);
  const [announce, setAnnounce] = useState('');
  const index = useGroupIndex(albumsPath, useCallback((name: string) => pendingRef.current.has(name), []));

  // The viewer's own: the target chosen for this category, and the albums filed into lately.
  const [chosenTarget, setChosenTarget] = usePersistedState<string>(`staging.target:${category.path}`, '');
  const [recentStored, setRecentStored] = usePersistedState<string>('staging.recent', '[]');
  const recent = useMemo(() => parseRecent(recentStored), [recentStored]);
  const target = useMemo(() => stickyTarget(parseTarget(chosenTarget), category.destination, recent), [chosenTarget, category.destination, recent]);
  const remember = useCallback((album: AlbumTarget) => setRecentStored(JSON.stringify(withRecent(parseRecent(recentStored), album))), [recentStored, setRecentStored]);

  const statusTimer = useRef<number | undefined>(undefined);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const changed = useCallback(() => {
    globalThis.clearTimeout(statusTimer.current);
    statusTimer.current = globalThis.setTimeout(() => onChangedRef.current(), STATUS_AFTER_MS);
  }, []);
  useEffect(() => () => globalThis.clearTimeout(statusTimer.current), []);

  const lane: StagingLane = isLane(searchParams.get('lane')) ? searchParams.get('lane') as StagingLane : 'sort';
  const newestFirst = searchParams.get('order') === 'new';
  const counts = useMemo(() => laneCounts(index.rows), [index.rows]);
  const lanesInUse = LANES.filter((each) => counts[each.id].groups > 0);
  const view = useMemo(
    () => streamOrder(inLane(index.rows, lane), { newestFirst }).filter((row) => !pending.has(row.name)),
    [index.rows, lane, newestFirst, pending],
  );
  const names = useMemo(() => view.map((row) => row.name), [view]);
  const byName = useMemo(() => new Map(view.map((row) => [row.name, row])), [view]);

  const setParam = useCallback((key: string, value: string | null) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true, state: location.state });
  }, [setSearchParams, location.state]);

  // The cursor: the URL's, else where this viewer last was in this category. One not loaded yet is
  // waited for until every page is in; then the stream starts at its first group.
  const [storedCursor, setStoredCursor] = usePersistedState<string>(`staging.cursor:${albumsPath}`, '');
  const [wanted, setWanted] = useState<string | null>(() => searchParams.get('g') || storedCursor || null);
  // A cursor whose group leaves the view without a decision here (the organizer deleted or merged
  // it, another session decided it) goes where a decision would send it, from the view it left.
  const [drawnNames, setDrawnNames] = useState<readonly string[]>(names);
  if (drawnNames !== names) {
    setDrawnNames(names);
    if (wanted !== null && !byName.has(wanted) && !pending.has(wanted) && drawnNames.includes(wanted)) {
      setWanted(nextAfterDecision(drawnNames, wanted, (name) => !byName.has(name) || failures.has(name)));
    }
  }
  const finding = wanted !== null && !byName.has(wanted) && !index.complete && !pending.has(wanted);
  const cursor = wanted !== null && byName.has(wanted) ? wanted : finding ? null : names[0] ?? null;
  const cursorIndex = cursor === null ? -1 : names.indexOf(cursor);
  const cursorRow = cursor === null ? undefined : byName.get(cursor);
  const previousRow = cursorIndex > 0 ? view[cursorIndex - 1] : undefined;
  const nextRow = cursorIndex >= 0 && cursorIndex < view.length - 1 ? view[cursorIndex + 1] : undefined;
  // The parts and candidates of the cursor's group and the next ones, read ahead.
  const detailRows = useMemo(() => cursorIndex < 0 ? [] : view.slice(cursorIndex, cursorIndex + DETAILS_AHEAD + 1), [view, cursorIndex]);
  const details = useGroupDetails(detailRows);
  // The open group's copies and look-alikes: its tiles' badges, its header's count, and its proposal.
  const openDuplicates = useDuplicateSets(cursorRow?.path ?? '', cursorRow?.staging.memberKey ?? '', cursorRow !== undefined);
  const duplicatesView = useMemo(() => {
    const sets = openDuplicates.page?.sets ?? [];
    return groupDuplicates(sets, new Set(sets.flatMap((set) => set.staged.filter((member) => member.inScope).map((member) => member.id))));
  }, [openDuplicates.page]);
  const [comparingSet, setComparingSet] = useState<DuplicateSet | null>(null);
  /** The candidate highlighted in the column (`,` and `.`), and whether the column is widened to compare (C). */
  const [highlight, setHighlight] = useState(0);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    if (cursor === null) return;
    const timer = setTimeout(() => {
      if (searchParams.get('g') !== cursor) setParam('g', cursor);
      setStoredCursor(cursor);
    }, URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cursor]);

  // A cursor given by the URL is brought into view once its group is loaded; so is one the URL
  // changes to while the page is open ("Sort in Staging" on an album page).
  const broughtIntoView = useRef(false);
  const urlCursor = searchParams.get('g');
  useEffect(() => {
    if (!urlCursor || urlCursor === cursor) return;
    setWanted(urlCursor);
    broughtIntoView.current = false;
  }, [urlCursor]);
  useEffect(() => {
    if (broughtIntoView.current || cursor === null) return;
    broughtIntoView.current = true;
    if (cursorIndex > 0) streamRef.current?.scrollToKey(cursor);
  }, [cursor, cursorIndex]);

  const [tileCursor, setTileCursor] = useState<string | null>(null);
  const tiles = useRef<{ items: MediaItem[]; boxes: TileBox[] }>({ items: [], boxes: [] });
  // The pictures of the open group, which its selection is over.
  const [openItems, setOpenItems] = useState<readonly MediaItem[]>([]);
  const onTiles = useCallback((items: MediaItem[], boxes: TileBox[]) => {
    tiles.current = { items, boxes };
    setOpenItems((previous) => previous === items ? previous : items);
  }, []);
  // The open group's parts, and the one the keys are on.
  const [parts, setParts] = useState<{ sections: PartSection<MediaItem>[]; byMonth: boolean }>({ sections: [], byMonth: false });
  const onParts = useCallback((sections: PartSection<MediaItem>[], byMonth: boolean) => setParts({ sections, byMonth }), []);
  const [partCursor, setPartCursor] = useState<string | null>(null);
  // What is held of the open group is of the group it was read from: once the cursor is on another,
  // however it got there, none of it is acted on until that one reports its own.
  const [insideOf, setInsideOf] = useState(cursor);
  if (insideOf !== cursor) {
    setInsideOf(cursor);
    setHighlight(0);
    setTileCursor(null);
    setPartCursor(null);
    setOpenItems([]);
    setParts({ sections: [], byMonth: false });
    tiles.current = { items: [], boxes: [] };
  }
  const part = partCursor === null ? undefined : parts.sections.find((section) => section.id === partCursor);

  // The group that takes the place of one just decided, and how far below the reading line it was:
  // it slides up from there.
  const [arrival, setArrival] = useState<{ name: string; from: number } | null>(null);
  const moveTo = useCallback((name: string | null, slideFrom?: number) => {
    if (name === null) return;
    setWanted(name);
    setArrival(slideFrom === undefined ? null : { name, from: slideFrom });
    setTileCursor(null);
    setPartCursor(null);
    tiles.current = { items: [], boxes: [] };
    setOpenItems([]);
    setParts({ sections: [], byMonth: false });
    streamRef.current?.scrollToKey(name);
  }, []);
  /** How far below the reading line the group `name` stands now, as far as the window shows; none when it is not below. */
  const belowReadingLine = useCallback((name: string): number | undefined => {
    const top = document.querySelector(`[data-group="${CSS.escape(name)}"]`)?.getBoundingClientRect().top ?? globalThis.innerHeight;
    const distance = Math.min(top, globalThis.innerHeight) - readingLine;
    return distance > 0 ? distance : undefined;
  }, [readingLine]);

  // The cursor's pictures and the next groups' are asked for ahead; those it has moved well away from are given up.
  const prefetches = useRef(new Map<string, AbortController>());
  useEffect(() => {
    if (cursorIndex < 0) return;
    const near = new Set(view.slice(Math.max(0, cursorIndex - PREFETCH_KEEP), cursorIndex + PREFETCH_KEEP + 1).map((row) => row.path));
    for (const [path, controller] of prefetches.current) {
      if (near.has(path)) continue;
      controller.abort();
      prefetches.current.delete(path);
    }
    for (const row of view.slice(cursorIndex, cursorIndex + PREFETCH_AHEAD + 1)) {
      if (prefetches.current.has(row.path)) continue;
      const controller = new AbortController();
      prefetches.current.set(row.path, controller);
      prefetchMediaSet(row.path, { signal: controller.signal });
    }
  }, [cursorIndex, view]);
  useEffect(() => () => {
    for (const controller of prefetches.current.values()) controller.abort();
  }, []);

  // The decisions of this session, newest last, and the toast of the latest.
  const taken = useRef<Taken[]>([]);
  const toast = useRef<number | null>(null);
  const takenIds = useRef(0);

  const say = useCallback((message: string, undo?: () => void, color?: 'red' | 'yellow' | 'green') => {
    if (toast.current !== null) dismissToast(toast.current);
    toast.current = notify({ message, ...(color ? { color } : {}), ...(undo ? { action: { label: 'Undo', onClick: undo } } : {}) });
  }, []);

  const undoTaken = useCallback((entry: Taken) => {
    taken.current = taken.current.filter((each) => each.id !== entry.id);
    if (entry.bulk) {
      entry.bulk.undoAll();
      return;
    }
    // One that has not run is not undone: it never runs.
    if (queue.cancel(entry.queued)) {
      setAnnounce(`${entry.label}: cancelled.`);
      return;
    }
    // Queued behind the decision when it is still running, so what it answers is known by then.
    queue.enqueue({
      label: `Undoing: ${entry.label}`,
      run: () => {
        if (entry.journal && entry.journal.length > 0) return execCommand<StagingUndoResult | StagingLaterResult>(commands.undoEntries(entry.journal));
        if (entry.laterOff !== undefined) return execCommand<StagingUndoResult | StagingLaterResult>(commands.later(entry.row, entry.laterOff));
        throw new Error('it changed nothing that can be put back');
      },
      onDone: (answer) => {
        index.reread([entry.row.path]);
        forgetMediaSet(entry.row.path);
        moveTo(entry.row.name);
        const failed = 'failed' in answer ? answer.failed : [];
        say(failed.length > 0 ? `Undone in part: ${failed[0].reason}` : `Undone: ${entry.label}`, undefined, failed.length > 0 ? 'yellow' : undefined);
        changed();
      },
      onFail: (error) => say(`Couldn't undo: ${error.message}`, undefined, 'red'),
    });
  }, [queue, index, say, changed, moveTo]);

  const undoLast = useCallback(() => {
    const last = taken.current.at(-1);
    if (last) undoTaken(last);
    else say('Nothing to undo from this visit; the Done tab lists every decision.');
  }, [undoTaken, say]);

  /**
   * Carry out a decision: a whole group leaves the stream at once and the cursor goes to
   * `cursorTo` (by default the next group still to decide), which slides up into its place; the
   * command waits its turn in the queue. On success the group is gone from the index (or, for some
   * of its pictures, read again) and a toast offers Undo; on failure it comes back with why, and
   * Retry runs it again.
   */
  const decide = useCallback(<T,>(decision: Decision<T>, retrying = false) => {
    const { row, whole } = decision;
    if (whole) {
      const cursorTo = decision.cursorTo !== undefined ? decision.cursorTo : nextAfterDecision(names, row.name, (name) => pendingRef.current.has(name) || failures.has(name));
      setPending((previous) => new Set(previous).add(row.name));
      if (cursor === row.name || (decision.cursorTo !== undefined && !retrying)) moveTo(cursorTo, cursorTo === null ? undefined : belowReadingLine(cursorTo));
      const nextTitle = cursorTo === null ? undefined : byName.get(cursorTo)?.title;
      setAnnounce(`${decision.label}.${nextTitle ? ` Next: ${nextTitle}.` : ''}`);
    } else setAnnounce(`${decision.label}.`);
    setFailures((previous) => withoutKey(previous, row.name));
    const entry: Taken = { id: ++takenIds.current, label: decision.label, row, queued: 0, journal: null, laterOff: decision.laterOff };
    entry.queued = queue.enqueue({
      label: decision.label,
      run: async () => {
        const answer = await execCommand<T>(decision.command);
        decision.check?.(answer);
        return answer;
      },
      onDone: (answer) => {
        if (whole && !decision.stays) {
          index.remove([row.name]);
          setPending((previous) => without(previous, row.name));
        } else {
          if (decision.stays) index.patch(row.name, decision.stays);
          if (whole) setPending((previous) => without(previous, row.name));
          forgetMediaSet(row.path);
          index.reread([row.path]);
        }
        const edit = decision.regrouped?.(answer);
        if (edit) {
          const name = (path: string) => path.slice(albumsPath.length + 1);
          const touched = [...edit.groupsCreated, ...edit.groupsChanged].filter((path) => !edit.groupsRemoved.includes(path));
          index.remove(edit.groupsRemoved.map(name));
          for (const path of touched) forgetMediaSet(path);
          if (touched.length > 0) index.reread(touched);
        }
        entry.journal = decision.journal(answer);
        // Putting a group aside is not journaled, but undone by bringing it back.
        const undoable = entry.journal.length > 0 || entry.laterOff !== undefined;
        if (!undoable) taken.current = taken.current.filter((each) => each.id !== entry.id);
        const album = decision.filedInto?.(answer);
        if (album) remember(album);
        say(decision.done(answer), undoable ? () => undoTaken(entry) : undefined, 'green');
        changed();
      },
      onFail: (error) => {
        taken.current = taken.current.filter((each) => each.id !== entry.id);
        if (whole) setPending((previous) => without(previous, row.name));
        forgetMediaSet(row.path);
        index.reread([row.path]);
        setFailures((previous) => new Map(previous).set(row.name, { message: `${decision.failed}: ${error.message}`, retry: () => decideRef.current(decision, true) }));
        changed();
      },
      onCancel: () => {
        if (whole) setPending((previous) => without(previous, row.name));
        if (whole) moveTo(row.name);
      },
    });
    taken.current = [...taken.current, entry];
  }, [names, failures, cursor, byName, moveTo, belowReadingLine, index, changed, queue, remember, say, undoTaken, albumsPath]);
  const decideRef = useRef(decide);
  decideRef.current = decide;

  /** An edit's answer that says a group changed is no edit: the reader must look again. */
  const editHeld = (answer: StagingEditResult) => {
    if (answer.changed.length > 0) throw new Error('it changed while you were deciding; look again');
  };

  const editJournal = (answer: StagingEditResult) => answer.journal ? [answer.journal] : [];

  /** Merge two neighbours: the one whose name the merged group takes (`lib/merge-name.ts`) keeps, and the cursor goes to it. */
  const mergeInto = useCallback((above: GroupRow, below: GroupRow) => {
    const kept = nameGiver(above, below);
    const gone = kept === above ? below : above;
    decide<StagingEditResult>({
      row: gone,
      whole: true,
      command: commands.merge(kept, gone),
      label: `Merging “${gone.title}” into “${kept.title}”`,
      failed: `Couldn't merge into “${kept.title}”`,
      done: () => `“${gone.title}” merged into “${kept.title}”`,
      journal: editJournal,
      check: editHeld,
      cursorTo: kept.name,
      regrouped: (answer) => answer,
    });
  }, [decide]);

  const removeGroup = useCallback((row: GroupRow) => {
    decide<StagingEditResult>({
      row,
      whole: true,
      command: commands.notAGroup(row),
      label: `“${row.title}” is not a group`,
      failed: "Couldn't put its pictures back in their lanes",
      done: () => `“${row.title}” is not a group; its pictures are back in their lanes`,
      journal: editJournal,
      check: editHeld,
      regrouped: (answer) => answer,
    });
  }, [decide]);

  /** Leave the open group's parts, pictures and selection, which an edit of it has made stale. */
  const leaveInside = useCallback(() => {
    clearSelection();
    setPartCursor(null);
    setTileCursor(null);
  }, [clearSelection]);

  /** An edit of the open group that leaves it in the stream, changed: it is read again once done. */
  const regroup = useCallback((row: GroupRow, edit: { command: string; label: string; failed: string; done: string }) => {
    decide<StagingEditResult>({
      row,
      whole: false,
      command: edit.command,
      label: edit.label,
      failed: edit.failed,
      done: () => edit.done,
      journal: editJournal,
      check: editHeld,
      regrouped: (answer) => answer,
    });
    leaveInside();
  }, [decide, leaveInside]);

  /** The group's pictures from `file` on become a group of their own. */
  const splitAt = useCallback((row: GroupRow, file: string) => {
    regroup(row, {
      command: commands.split(row, file),
      label: `Splitting “${row.title}” before ${file.slice(file.lastIndexOf('/') + 1)}`,
      failed: `Couldn't split “${row.title}”`,
      done: `“${row.title}” split in two`,
    });
  }, [regroup]);

  /** `files` of the group become a group of their own, named by their dates. */
  const newGroup = useCallback((row: GroupRow, files: readonly string[]) => {
    regroup(row, {
      command: commands.regroupNew(files),
      label: `Making a new group of ${photos(files.length)}`,
      failed: "Couldn't make them a group",
      done: `${photos(files.length)} are a new group`,
    });
  }, [regroup]);

  /** `files` of the group move into the group `to`. */
  const moveInto = useCallback((row: GroupRow, to: GroupRow, files: readonly string[]) => {
    regroup(row, {
      command: commands.regroupInto(to, files),
      label: `Moving ${photos(files.length)} to “${to.title}”`,
      failed: `Couldn't move them to “${to.title}”`,
      done: `${photos(files.length)} moved to “${to.title}”`,
    });
  }, [regroup]);

  /**
   * S: in a lane, `files` become a group of their own; elsewhere the group is split before the
   * first of them. Before the group's first picture there is nothing to split off.
   */
  const cut = useCallback((row: GroupRow, files: readonly string[]) => {
    if (files.length === 0) return;
    if (isLaneGroup(row)) newGroup(row, files);
    else if (files[0] === tiles.current.items[0]?.path) say('That is the first picture: split before a later one.');
    else splitAt(row, files[0]);
  }, [newGroup, splitAt, say]);

  const rename = useCallback((row: GroupRow, title: string) => {
    index.patch(row.name, (each) => ({ ...each, title }));
    execCommand(`staging rename ${shq(row.path)} ${shq(title)}`).catch((error) => {
      index.patch(row.name, (each) => ({ ...each, title: row.title }));
      notify({ message: `Couldn't rename “${row.title}”: ${error instanceof Error ? error.message : String(error)}`, color: 'red' });
    });
  }, [index]);

  /** A promote's answer that says the group changed is no filing: the reader must look again. */
  const unchanged = (answer: StagingPromoteResult | StagingDiscardResult) => {
    if (answer.changed.length > 0) throw new Error('it changed while you were deciding; look again');
  };

  // The pictures of the open group selected; a range from it runs across the groups of the view,
  // of which only the open one has its pictures laid out.
  const openPaths = useMemo(() => openItems.map((item) => item.path), [openItems]);
  const stream: SectionOrder = useMemo(() => ({ order: names, itemsOf: (section) => section === cursor ? openPaths : undefined }), [names, cursor, openPaths]);
  const picked: MediaSelection | undefined = cursor === null ? undefined : selection.gridSelection(cursor, openPaths, stream);
  /** The selection reaches past the open group's pictures: groups whole, or pictures of other groups. Then it is decided on as many groups. */
  const across = selection.selection.sections.size > 0 || [...selection.selection.items.values()].some((section) => section !== cursor);
  const selected = across ? [] : picked?.keys ?? [];
  /** The selection by what acts on it (`lib/selection-command.ts`). */
  const chosen = useMemo(() => selectionParts(selection.selection, (name) => byName.get(name)), [selection.selection, byName]);
  const chosenCount = useMemo(() => partsCount(chosen), [chosen]);
  /** Groups the selection holds, whole or but for some pictures: what Later and Enter act on. */
  const selectedGroups = useMemo(() => [...chosen.groups, ...chosen.partial.map(({ group }) => group)], [chosen]);
  const allLater = selectedGroups.length > 0 && selectedGroups.every((row) => row.staging.later !== undefined);
  // What is selected of groups that left the view (decided, gone, another lane) is let go.
  useEffect(() => selection.keep((section) => byName.has(section)), [byName]);
  const partPaths = useMemo(() => part?.items.map((item) => item.path) ?? [], [part]);
  /** What Enter, N, P, A, B and X act on inside the open group: the selection, else the part; none for the whole group. */
  const filing = selected.length > 0 ? selected : partPaths;
  /** What S, `<`, `>` and G act on: those, or the picture under the arrows' cursor. */
  const regrouping = filing.length > 0 ? filing : tileCursor !== null ? [tileCursor] : [];

  /** File the group, or the pictures selected in it, into the album `album`. */
  const fileInto = useCallback((row: GroupRow, album: AlbumTarget, files: readonly string[] = []) => {
    if (files.length > 0) {
      decide<AlbumAddResult>({
        row,
        whole: false,
        command: commands.addFiles(album.path, files),
        label: `Filing ${photos(files.length)} in “${album.title}”`,
        failed: `Couldn't file into “${album.title}”`,
        done: (answer) => `${photos(answer.moved.length)} filed in “${album.title}”`,
        journal: (answer) => answer.journal ?? [],
        filedInto: () => album,
      });
      leaveInside();
      return;
    }
    decide<StagingPromoteResult>({
      row,
      whole: true,
      command: commands.promoteInto(row, album.path),
      label: `Filing ${photos(row.memberCount ?? 0)} in “${album.title}”`,
      failed: `Couldn't file into “${album.title}”`,
      check: unchanged,
      done: (answer) => `${photos(answer.moved)} filed in “${album.title}”`,
      journal: (answer) => answer.journal ? [answer.journal] : [],
      filedInto: () => album,
    });
    setFiled((value) => value + (row.memberCount ?? 0));
  }, [decide, leaveInside]);

  /** Make the group, or the pictures selected in it, a new album titled `title`. */
  const fileNew = useCallback((row: GroupRow, title: string, privately: boolean, files: readonly string[] = []) => {
    const except = files.length > 0 ? openPaths.filter((path) => !files.includes(path)) : [];
    decide<StagingPromoteResult>({
      row,
      whole: files.length === 0,
      command: commands.promoteNew(row, title, { private: privately, except }),
      label: `Filing ${photos(files.length || (row.memberCount ?? 0))} in a new ${privately ? 'private ' : ''}album “${title}”`,
      failed: `Couldn't make “${title}”`,
      check: unchanged,
      done: (answer) => `${photos(answer.moved)} filed in “${answer.album?.title ?? title}”`,
      journal: (answer) => answer.journal ? [answer.journal] : [],
      filedInto: (answer) => answer.album ? { path: answer.album.path, title: answer.album.title } : undefined,
    });
    if (files.length > 0) leaveInside();
    else setFiled((value) => value + (row.memberCount ?? 0));
  }, [decide, leaveInside, openPaths]);

  const discard = useCallback((row: GroupRow, files: readonly string[] = []) => {
    decide<StagingDiscardResult>({
      row,
      whole: files.length === 0,
      command: files.length > 0 ? commands.discardFiles(files) : commands.discardGroup(row),
      label: `Discarding ${photos(files.length || (row.memberCount ?? 0))}`,
      failed: "Couldn't discard",
      check: unchanged,
      done: (answer) => `${photos(answer.files)} moved to the trash`,
      journal: (answer) => answer.journal ? [answer.journal] : [],
    });
    if (files.length > 0) leaveInside();
  }, [decide, leaveInside]);

  const later = useCallback((row: GroupRow) => {
    const off = row.staging.later !== undefined;
    decide<StagingLaterResult>({
      row,
      whole: true,
      command: commands.later(row, off),
      label: off ? `“${row.title}” back in its lane` : `“${row.title}” put aside for later`,
      failed: off ? "Couldn't bring it back" : "Couldn't put it aside",
      done: () => off ? `“${row.title}” is back in its lane` : `“${row.title}” is in Later`,
      journal: () => [],
      laterOff: !off,
      stays: (each) => ({ ...each, staging: off ? { ...each.staging, later: undefined } : { ...each.staging, later: new Date().toISOString() } }),
    });
  }, [decide]);

  const runBulk = useBulkRun({
    queue,
    hide: (gone) => setPending((previous) => new Set([...previous, ...gone])),
    show: (back) => setPending((previous) => new Set([...previous].filter((name) => !back.includes(name)))),
    remove: (gone) => index.remove(gone),
    reread: (paths) => {
      for (const path of paths) forgetMediaSet(path);
      if (paths.length > 0) index.reread(paths);
    },
    changed,
  });

  /**
   * Start a decision over many groups: the cursor leaves the groups it decides for the next one
   * that stays, the selection it was made from is let go, and Z holds the run whole.
   */
  const startRun = useCallback((spec: BulkSpec) => {
    const leaving = new Set(spec.chunks.flatMap((chunk) => chunk.groups.map((group) => group.name)));
    if (cursor !== null && leaving.has(cursor)) {
      const next = nextAfterDecision(names, cursor, (name) => leaving.has(name) || pendingRef.current.has(name));
      moveTo(next, next === null ? undefined : belowReadingLine(next));
    }
    clearSelection();
    const entry: Taken = { id: ++takenIds.current, label: spec.label, bulk: runBulk(spec) };
    taken.current = [...taken.current, entry];
    setAnnounce(`${spec.label}.`);
  }, [cursor, names, moveTo, belowReadingLine, clearSelection, runBulk]);

  /** File the selection into `album`: groups whole, groups but for some pictures, pictures one by one. */
  const fileParts = useCallback((what: SelectionParts<GroupRow>, album: AlbumTarget) => {
    const count = partsCount(what);
    startRun({
      verb: 'Filing',
      label: `Filing ${selectionWords(count)} in “${album.title}”`,
      chunks: fileChunks(what, album.path),
      total: count,
      undo: 'journal',
      done: (tally) => `${photos(tally.files)} filed in “${album.title}”`,
    });
    remember(album);
  }, [startRun, remember]);

  /** Make the selection one new album: the first call makes it, the rest file into it. */
  const newAlbumParts = useCallback((what: SelectionParts<GroupRow>, title: string, privately: boolean) => {
    const start = newAlbumChunks(what, title, privately);
    if (!start) {
      say('A new album starts from a group: select one whole, or file these pictures into an album with A or B.');
      return;
    }
    const count = partsCount(what);
    let made: AlbumTarget | undefined;
    startRun({
      verb: 'Filing',
      label: `Filing ${selectionWords(count)} in a new ${privately ? 'private ' : ''}album “${title}”`,
      chunks: [start.first],
      then: (answer) => {
        const album = (answer as StagingPromoteResult).album;
        if (!album) return [];
        made = { path: album.path, title: album.title };
        remember(made);
        return fileChunks(start.rest, album.path);
      },
      total: count,
      undo: 'journal',
      done: (tally) => `${photos(tally.files)} filed in “${made?.title ?? title}”`,
    });
  }, [startRun, remember, say]);

  const discardParts = useCallback((what: SelectionParts<GroupRow>) => {
    const count = partsCount(what);
    startRun({
      verb: 'Discarding',
      label: `Discarding ${selectionWords(count)}`,
      chunks: discardChunks(what),
      total: count,
      undo: 'journal',
      done: (tally) => `${photos(tally.files)} moved to the trash`,
    });
  }, [startRun]);

  /** Put the selection's groups aside, or when every one of them is, bring them back. Nothing moves, so it is undone the other way round. */
  const laterParts = useCallback((what: SelectionParts<GroupRow>) => {
    const groups = [...what.groups, ...what.partial.map(({ group }) => group)];
    if (groups.length === 0) {
      say('Later puts groups aside: select groups whole.');
      return;
    }
    const off = groups.every((row) => row.staging.later !== undefined);
    startRun({
      verb: off ? 'Bringing back' : 'Putting aside',
      label: off ? `${groupCount(groups.length)} back in their lanes` : `${groupCount(groups.length)} put aside for later`,
      chunks: laterChunks(groups, off),
      total: { groups: groups.length, files: 0 },
      stays: (group) => index.patch(group.name, (each) => ({ ...each, staging: { ...each.staging, later: off ? undefined : new Date().toISOString() } })),
      undo: { laterOff: !off },
      done: (tally) => off ? `${groupCount(tally.groups)} back in their lanes` : `${groupCount(tally.groups)} in Later`,
    });
  }, [startRun, say, index]);

  /** Accept the proposals of the groups confirmed in the plan dialog, at least as sure as `floor`. */
  const acceptGroups = useCallback((groups: GroupRow[], floor: MatchConfidence) => {
    const files = groups.reduce((sum, row) => sum + (row.memberCount ?? 0), 0);
    startRun({
      verb: 'Filing',
      label: `Accepting the proposals of ${groupCount(groups.length)}`,
      chunks: acceptChunks(groups, floor),
      total: { groups: groups.length, files },
      undo: 'journal',
      done: (tally) => `${groupCount(tally.groups)} filed, ${photos(tally.files)}`,
    });
  }, [startRun]);

  const [naming, setNaming] = useState<{ row: GroupRow; private: boolean; files: string[] } | null>(null);
  /** The decisions over many groups that ask first: their name, their album, the discard, the plan of their proposals. */
  const [bulkNaming, setBulkNaming] = useState<{ parts: SelectionParts<GroupRow>; private: boolean } | null>(null);
  const [bulkPicking, setBulkPicking] = useState<SelectionParts<GroupRow> | null>(null);
  const [bulkDiscarding, setBulkDiscarding] = useState<SelectionParts<GroupRow> | null>(null);
  const [accepting, setAccepting] = useState<GroupRow[] | null>(null);
  /** The album picker: for whom, and whether what is picked becomes the target, is filed into, or both. */
  const [picking, setPicking] = useState<{ row: GroupRow; files: string[]; setTarget: boolean; file: boolean } | null>(null);
  const [discarding, setDiscarding] = useState<GroupRow | null>(null);
  const [deleting, setDeleting] = useState<GroupRow | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The G picker: pictures of which group are moved. */
  const [moving, setMoving] = useState<{ row: GroupRow; files: string[] } | null>(null);
  /** T: the pictures whose time is being set, of which group. */
  const [dating, setDating] = useState<{ row: GroupRow; items: MediaItem[] } | null>(null);
  const modalOpen = useRef<boolean>(false);
  modalOpen.current = naming !== null || picking !== null || discarding !== null || deleting !== null || moving !== null || dating !== null ||
    bulkNaming !== null || bulkPicking !== null || bulkDiscarding !== null || accepting !== null || comparingSet !== null;

  /** T: set the time of `files` of the group, or of every picture in it; its pictures are read first when it is not the open one. */
  const dateGroup = useCallback((row: GroupRow, files: readonly string[]) => {
    if (row.name === cursor && openItems.length > 0) {
      const chosen = new Set(files);
      setDating({ row, items: files.length > 0 ? openItems.filter((item) => chosen.has(item.path)) : [...openItems] });
      return;
    }
    loadMediaSet(row.path).then((set) => {
      if (set.truncated) say(`“${row.title}” is too large to set the time of at once; select some of its pictures.`, undefined, 'red');
      else setDating({ row, items: set.items });
    }).catch((error) => say(`Couldn't read “${row.title}”: ${error instanceof Error ? error.message : String(error)}`, undefined, 'red'));
  }, [cursor, openItems, say]);

  const askDiscard = useCallback((row: GroupRow, files: string[]) => {
    if (files.length === 0 && (row.memberCount ?? 0) >= DISCARD_ASKS) setDiscarding(row);
    else discard(row, files);
  }, [discard]);

  const proposalFor = useCallback(
    (row: GroupRow): Proposal =>
      proposeDestination(
        proposalInputOf(
          row.title,
          row.staging,
          category.destination,
          row.name === cursor && openDuplicates.page ? { members: row.memberCount ?? 0, libraryDuplicates: duplicatesView.library.files } : undefined,
        ),
      ),
    [category.destination, cursor, openDuplicates.page, duplicatesView],
  );

  /** An Everyday lane's matched days, each into the album it matches: the rest of the lane stays. */
  const acceptParts = useCallback((row: GroupRow, proposal: Extract<Proposal, { action: 'parts' }>) => {
    decide<StagingAcceptResult>({
      row,
      whole: false,
      command: commands.accept([row], 'low'),
      label: `Filing ${proposal.parts} matched ${proposal.parts === 1 ? 'day' : 'days'} of “${row.title}”`,
      failed: `Couldn't file the matched days of “${row.title}”`,
      check: (answer) => {
        if (answer.skipped.some((skip) => skip.reason === 'changed')) throw new Error('it changed while you were deciding; look again');
      },
      done: () => `${photos(proposal.files)} of “${row.title}” filed into the albums they match`,
      journal: (answer) => answer.journal,
    });
    leaveInside();
  }, [decide, leaveInside]);

  /**
   * Resolve duplicate sets of the group's members (`keys`): the files they drop go to the trash,
   * the rest stay in the group. With `keep`, the one set named keeps that staged file.
   */
  const resolveSets = useCallback((row: GroupRow, keys: string[], label: string, keep?: string) => {
    if (keys.length === 0) return;
    decide<DuplicateResolveResult>({
      row,
      whole: false,
      command: commands.dedupe(row, keys, keep),
      label,
      failed: `Couldn't remove the duplicates in “${row.title}”`,
      check: (answer) => {
        if (answer.resolved === 0) throw new Error(`it changed (${answer.skipped[0]?.reason ?? 'look again'})`);
      },
      done: (answer) => `${photos(answer.discarded)} of “${row.title}” removed`,
      journal: (answer) => answer.journal ? [answer.journal] : [],
    });
  }, [decide]);

  /** The look-alikes of a set are not duplicates: kept apart on every staged one. */
  const separateSet = useCallback((row: GroupRow, set: DuplicateSet) => {
    const command = separateCommand(set);
    if (!command) return;
    decide<DuplicateSeparateResult>({
      row,
      whole: false,
      command,
      label: `Keeping ${photos(set.staged.length + set.existing.length)} of “${row.title}” apart`,
      failed: `Couldn't keep them apart`,
      done: () => 'Kept apart: not duplicates',
      journal: () => [],
    });
  }, [decide]);

  /**
   * What Enter does with `files` of `row` (none: the whole group), in the words of its button;
   * undefined when nothing is proposed. On a part of a lane whose day matches an album, that album;
   * otherwise the group's proposal, where a new album asks for its name first. Filing the matched
   * days and keeping the library copies are the whole group's, so for some of its pictures they
   * propose nothing.
   */
  const enterFor = useCallback((row: GroupRow, files: string[]): { label: string; run: () => void } | undefined => {
    const dayMatch = files.length > 0 && part && files === partPaths ? details.get(row.path)?.parts.find((each) => each.day === part.key)?.match : undefined;
    if (dayMatch?.album.writable) {
      const album = { path: dayMatch.album.path, title: dayMatch.album.title };
      return { label: `Add to “${album.title}”`, run: () => fileInto(row, album, files) };
    }
    const proposal = proposalFor(row);
    const label = proposalLabel(proposal);
    if (label === undefined) return undefined;
    if (proposal.action === 'existing') return { label, run: () => fileInto(row, { path: proposal.album.path, title: proposal.album.title }, files) };
    if (proposal.action === 'new') return { label, run: () => setNaming({ row, private: false, files }) };
    if (proposal.action === 'discard') return { label, run: () => askDiscard(row, files) };
    if (files.length > 0) return undefined;
    if (proposal.action === 'parts') return { label, run: () => acceptParts(row, proposal) };
    if (proposal.action === 'dedupe') {
      return { label, run: () => resolveSets(row, duplicatesView.library.keys, `Keeping the library copies of ${photos(proposal.files)} in “${row.title}”`) };
    }
    return undefined;
  }, [proposalFor, fileInto, askDiscard, acceptParts, resolveSets, duplicatesView, details, part, partPaths]);

  /** Enter: what `enterFor` proposes, or saying that nothing is. */
  const apply = useCallback((row: GroupRow, files: string[]) => {
    const enter = enterFor(row, files);
    if (enter) enter.run();
    else say('No proposal: N, A, B or X.');
  }, [enterFor, say]);

  /** The album each day of `row` is matched to, and filing the day there. */
  const partMatchOf = useCallback((row: GroupRow): PartMatch => (key: string) => {
    const match = details.get(row.path)?.parts.find((each) => each.day === key)?.match;
    if (!match) return undefined;
    return {
      title: match.album.title,
      p: match.p,
      writable: match.album.writable,
      run: (section) => fileInto(row, { path: match.album.path, title: match.album.title }, section.items.map((item) => item.path)),
    };
  }, [details, fileInto]);

  /** The candidate albums of `row` as the column shows them. */
  const candidatesOf = useCallback((row: GroupRow) => details.get(row.path)?.candidates ?? [], [details]);

  /** 1–3: into the candidate of that rank, when the reader may file into it. */
  const toCandidate = useCallback((row: GroupRow, index: number, files: string[]) => {
    const candidate = candidatesOf(row)[index];
    if (!candidate) return;
    if (!candidate.album.writable) {
      say(`You can't add to “${candidate.album.title}”.`);
      return;
    }
    fileInto(row, { path: candidate.album.path, title: candidate.album.title }, files);
  }, [candidatesOf, fileInto, say]);

  /** R: the highlighted candidate is not where the group goes; it is matched again without it. */
  const rejectCandidate = useCallback((row: GroupRow, index: number) => {
    const candidate = candidatesOf(row)[index];
    if (!candidate) return;
    decide<StagingEditResult>({
      row,
      whole: false,
      command: commands.reject(row, candidate.album.path),
      label: `“${row.title}” is not for “${candidate.album.title}”`,
      failed: `Couldn't set “${candidate.album.title}” aside`,
      done: () => `“${candidate.album.title}” is no longer offered for “${row.title}”`,
      journal: editJournal,
    });
    setHighlight(0);
  }, [candidatesOf, decide]);

  const toTarget = useCallback((row: GroupRow, files: string[]) => {
    if (target) fileInto(row, target, files);
    else setPicking({ row, files, setTarget: true, file: true });
  }, [target, fileInto]);

  const actionsFor = useCallback((row: GroupRow, at: number): GroupActions => {
    const proposal = proposalFor(row);
    const label = proposalLabel(proposal);
    const hint = proposal.action === 'existing'
      ? `→ ${proposal.album.title} ${CONFIDENCE_WORDS[proposal.confidence]}`
      : proposal.action === 'parts'
      ? `→ ${proposal.parts} ${proposal.parts === 1 ? 'day matches' : 'days match'} an album`
      : undefined;
    return {
      ...(label ? { proposal: { label, run: () => apply(row, []) } } : {}),
      ...(hint ? { hint } : {}),
      newAlbum: () => setNaming({ row, private: false, files: [] }),
      privateAlbum: () => setNaming({ row, private: true, files: [] }),
      addTo: () => setPicking({ row, files: [], setTarget: false, file: true }),
      later: () => later(row),
      discard: () => askDiscard(row, []),
      rename: (title) => rename(row, title),
      mergeUp: at > 0 && mergeable(view[at - 1], row) ? () => mergeInto(view[at - 1], row) : undefined,
      mergeDown: at < view.length - 1 && mergeable(row, view[at + 1]) ? () => mergeInto(row, view[at + 1]) : undefined,
      openPage: () => navigate(albumRoute(row.path)),
      date: () => dateGroup(row, []),
      ...(isLaneGroup(row) ? {} : { remove: () => setDeleting(row) }),
    };
  }, [view, proposalFor, apply, later, askDiscard, rename, mergeInto, navigate, dateGroup]);

  /** Bring the open group's part `id` up under its header. */
  const showPart = useCallback((id: string) => {
    if (cursor === null) return;
    const node = document.querySelector(`[data-group="${CSS.escape(cursor)}"] [data-part="${CSS.escape(id)}"]`);
    if (!node) return;
    const top = node.getBoundingClientRect().top + globalThis.scrollY - readingLine - SECTION_METRICS.desktop.header - PART_MARGIN;
    globalThis.scrollTo({ top, behavior: 'auto' });
  }, [cursor, readingLine]);

  /** The groups the G picker offers before a search: those around the open one, nearest first. */
  const neighbours = useMemo(() => {
    if (cursorIndex < 0) return [];
    const around: GroupRow[] = [];
    for (let step = 1; step <= PICKER_NEIGHBOURS; step++) {
      if (cursorIndex - step >= 0) around.push(view[cursorIndex - step]);
      if (cursorIndex + step < view.length) around.push(view[cursorIndex + step]);
    }
    return around;
  }, [view, cursorIndex]);
  const pickable = useMemo(() => cursor === null ? [] : streamOrder(index.rows).filter((row) => row.name !== cursor && !pending.has(row.name)), [index.rows, cursor, pending]);

  const scope: TriageScope = across ? 'groups' : selected.length > 0 ? 'selection' : part ? 'part' : tileCursor !== null ? 'tile' : 'group';

  /** Decide on a selection across groups: what Enter, N, P, A, B, X and L do in the `groups` scope, and what a drop of it does. */
  const actOnParts = useCallback((what: SelectionParts<GroupRow>, action: TriageAction): boolean => {
    switch (action) {
      case 'apply':
        if (what.groups.length === 0) say('Accepting proposals takes groups selected whole.');
        else setAccepting(what.groups);
        return true;
      case 'new':
      case 'private':
        setBulkNaming({ parts: what, private: action === 'private' });
        return true;
      case 'add-to':
        setBulkPicking(what);
        return true;
      case 'target':
        if (target) fileParts(what, target);
        else setBulkPicking(what);
        return true;
      case 'discard':
        setBulkDiscarding(what);
        return true;
      case 'later':
        laterParts(what);
        return true;
      default:
        return false;
    }
  }, [say, target, fileParts, laterParts]);
  const act = useCallback((action: TriageAction) => {
    const items = tiles.current.items;
    const files = filing;
    if (scope === 'groups' && actOnParts(chosen, action)) return;
    switch (action) {
      case 'next':
      case 'previous':
        moveTo(stepFrom(names, cursor, action === 'next' ? 1 : -1));
        return;
      case 'extend-next':
      case 'extend-previous': {
        // From where the selection started, else from the picture or the group the cursor is on.
        const to = stepFrom(names, cursor, action === 'extend-next' ? 1 : -1);
        if (cursor === null || to === null || to === cursor) return;
        selection.extend(stream, { section: to }, tileCursor !== null ? { section: cursor, path: tileCursor } : { section: cursor });
        moveTo(to);
        return;
      }
      case 'apply':
        if (cursorRow) apply(cursorRow, files);
        return;
      case 'new':
      case 'private':
        if (cursorRow) setNaming({ row: cursorRow, private: action === 'private', files });
        return;
      case 'add-to':
        if (cursorRow) setPicking({ row: cursorRow, files, setTarget: false, file: true });
        return;
      case 'target':
        if (cursorRow) toTarget(cursorRow, files);
        return;
      case 'set-target':
        if (cursorRow) setPicking({ row: cursorRow, files: [], setTarget: true, file: false });
        return;
      case 'discard':
        if (cursorRow) askDiscard(cursorRow, files);
        return;
      case 'later':
        if (cursorRow) later(cursorRow);
        return;
      case 'undo':
        undoLast();
        return;
      case 'rename':
        if (cursorRow) setRenaming(cursorRow.name);
        return;
      case 'merge-up':
        if (cursorRow && previousRow && mergeable(previousRow, cursorRow)) mergeInto(previousRow, cursorRow);
        return;
      case 'merge-down':
        if (cursorRow && nextRow && mergeable(cursorRow, nextRow)) mergeInto(cursorRow, nextRow);
        return;
      case 'part-next':
      case 'part-previous': {
        const id = stepPart(parts.sections, partCursor, action === 'part-next' ? 1 : -1);
        if (id === null || parts.sections.length < 2) return;
        setPartCursor(id);
        setTileCursor(null);
        showPart(id);
        return;
      }
      case 'split':
        if (cursorRow) cut(cursorRow, regrouping);
        return;
      case 'move-up':
      case 'move-down': {
        const to = action === 'move-up' ? previousRow : nextRow;
        if (cursorRow && to && regrouping.length > 0) moveInto(cursorRow, to, regrouping);
        return;
      }
      case 'move-to':
        if (cursorRow && regrouping.length > 0) setMoving({ row: cursorRow, files: regrouping });
        return;
      case 'date':
        if (cursorRow) dateGroup(cursorRow, files);
        return;
      case 'candidate-1':
      case 'candidate-2':
      case 'candidate-3':
        if (cursorRow && scope !== 'groups') toCandidate(cursorRow, Number(action.slice(-1)) - 1, files);
        return;
      case 'candidate-previous':
      case 'candidate-next':
        if (cursorRow) setHighlight((at) => stepCandidate(at, action === 'candidate-next' ? 1 : -1, candidatesOf(cursorRow).length));
        return;
      case 'reject':
        if (cursorRow && scope !== 'groups') rejectCandidate(cursorRow, highlight);
        return;
      case 'compare':
        setComparing((on) => !on);
        return;
      case 'open': {
        const from = tileCursor ?? part?.items[0]?.path;
        const at = from === undefined ? 0 : items.findIndex((item) => item.path === from);
        if (at >= 0 && items[at]) openMediaAt(at, items);
        return;
      }
      case 'select':
        if (scope === 'part') picked?.setKeys(partPaths, true);
        else if (tileCursor !== null) picked?.toggle(tileCursor);
        return;
      case 'clear-selection':
        selection.clear();
        return;
      case 'leave':
        setTileCursor(null);
        setPartCursor(null);
        return;
      default: {
        if (items.length === 0) return;
        if (tileCursor === null) {
          setTileCursor(part?.items[0]?.path ?? items[0].path);
          setPartCursor(null);
          return;
        }
        const keys: Record<string, GridKey> = { 'tile-left': 'ArrowLeft', 'tile-right': 'ArrowRight', 'tile-up': 'ArrowUp', 'tile-down': 'ArrowDown' };
        const to = gridNeighbour(tiles.current.boxes, items.findIndex((item) => item.path === tileCursor), keys[action]);
        if (to !== null) setTileCursor(items[to].path);
      }
    }
  }, [
    actOnParts,
    chosen,
    stream,
    names,
    cursor,
    cursorRow,
    previousRow,
    nextRow,
    tileCursor,
    filing,
    regrouping,
    scope,
    part,
    partPaths,
    partCursor,
    parts,
    picked,
    selection,
    moveTo,
    mergeInto,
    apply,
    toTarget,
    askDiscard,
    later,
    undoLast,
    showPart,
    cut,
    moveInto,
    dateGroup,
    toCandidate,
    candidatesOf,
    rejectCandidate,
    highlight,
  ]);

  useTriageKeys(!phone, scope, act, modalOpen);

  // Dragging: a selected picture carries the selection, a header's grip its group (or the
  // selection it is in); either drops on the destination column's rows and on group headers. What
  // a selection's drag carries is kept beside it, so the drop acts on that selection as it was.
  const dragged = useRef(new WeakMap<MediaDragPayload, SelectionParts<GroupRow>>());
  const selectionPayload = useMemo<MediaDragPayload | undefined>(() => {
    if (noParts(chosen)) return undefined;
    const payload = {
      label: selectionWords(chosenCount),
      count: chosenCount.files,
      groups: selectedGroups.map((row) => row.path),
      files: chosen.files.flatMap(({ paths }) => paths),
      except: chosen.partial.flatMap(({ except }) => except),
    };
    dragged.current.set(payload, chosen);
    return payload;
  }, [chosen, chosenCount, selectedGroups]);
  const byPath = useMemo(() => new Map(view.map((row) => [row.path, row])), [view]);
  /** What a drop carries, by what acts on it: the selection it was dragged from, else the groups it names whole. */
  const partsOf = useCallback(
    (payload: MediaDragPayload): SelectionParts<GroupRow> =>
      dragged.current.get(payload) ??
        { groups: payload.groups.map((path) => byPath.get(path)).filter((row): row is GroupRow => row !== undefined), partial: [], files: [] },
    [byPath],
  );
  const dragPicture = useCallback((item: MediaItem) => picked?.isSelected(item.path) ? selectionPayload : undefined, [picked, selectionPayload]);
  const gripOf = useCallback(
    (row: GroupRow) => (): MediaDragPayload =>
      selection.selection.sections.has(row.name) && selectionPayload
        ? selectionPayload
        : { label: row.title, count: row.memberCount ?? 0, groups: [row.path], files: [], except: [] },
    [selection.selection, selectionPayload],
  );

  /** A drop that is pictures of the open group alone, which the decisions inside it take. */
  const openFiles = useCallback(
    (what: SelectionParts<GroupRow>): string[] | null =>
      what.groups.length === 0 && what.partial.length === 0 && what.files.length === 1 && what.files[0].group.name === cursor ? what.files[0].paths : null,
    [cursor],
  );

  /** What a drop on a row of the destination column does: what its key would do to what is dropped. */
  const destinationDrop = useCallback((destination: DropDestination): GroupDrop | undefined => {
    if (phone || !cursorRow) return undefined;
    const describe = (payload: MediaDragPayload): string | null => {
      const what = partsOf(payload);
      if (noParts(what)) return null;
      const one = oneGroup(what);
      const files = openFiles(what);
      const words = files ? photos(files.length) : one ? `“${one.title}”` : selectionWords(partsCount(what));
      const groups = what.groups.length + what.partial.length;
      switch (destination.kind) {
        case 'proposal': {
          const proposal = one ? proposalFor(one) : files ? proposalFor(cursorRow) : undefined;
          if (proposal?.action === 'existing') return `${words} into “${proposal.album.title}”`;
          if (proposal?.action === 'new') return `New album of ${words}…`;
          return !one && !files && what.groups.length > 0 ? `Accept the proposals of ${groupCount(what.groups.length)}…` : null;
        }
        case 'new':
          return files || one || newAlbumChunks(what, '', false) ? `New ${destination.private ? 'private ' : ''}album of ${words}…` : null;
        case 'target':
          return target ? `${words} into “${target.title}”` : null;
        case 'recent':
          return `${words} into “${destination.album.title}”`;
        case 'add-to':
          return `Add ${words} to an album…`;
        case 'later':
          return groups > 0 ? `Later, ${one ? words : groupCount(groups)}` : null;
        case 'discard':
          return `Discard ${words}${files ? '' : '…'}`;
      }
    };
    const run = (payload: MediaDragPayload) => {
      const what = partsOf(payload);
      const row = oneGroup(what) ?? (openFiles(what) ? cursorRow : null);
      const files = openFiles(what) ?? [];
      if (row) {
        if (destination.kind === 'proposal') apply(row, files);
        else if (destination.kind === 'new') setNaming({ row, private: destination.private, files });
        else if (destination.kind === 'target') target && fileInto(row, target, files);
        else if (destination.kind === 'recent') fileInto(row, destination.album, files);
        else if (destination.kind === 'add-to') setPicking({ row, files, setTarget: false, file: true });
        else if (destination.kind === 'later') files.length === 0 && later(row);
        else askDiscard(row, files);
        return;
      }
      if (destination.kind === 'recent') fileParts(what, destination.album);
      else actOnParts(what, destination.kind === 'proposal' ? 'apply' : destination.kind === 'new' ? (destination.private ? 'private' : 'new') : destination.kind);
    };
    return { accept: describe, onDrop: run };
  }, [phone, cursorRow, partsOf, openFiles, proposalFor, target, apply, fileInto, later, askDiscard, fileParts, actOnParts]);

  /**
   * What a drop on a group's header does: groups dropped whole merge into it, pictures move into
   * it; a lane's group is not merged.
   */
  const headerDrop = useCallback((row: GroupRow): GroupDrop | undefined => {
    if (phone) return undefined;
    const plan = (payload: MediaDragPayload): Chunk | null => {
      const what = partsOf(payload);
      const merging = what.groups.filter((each) => each.name !== row.name);
      if (merging.some((each) => !mergeable(row, each))) return null;
      const result = intoGroupChunks(what, row, (group) => group.name === cursor ? openPaths : undefined);
      return 'refused' in result ? null : result.chunk;
    };
    return {
      accept: (payload) => {
        const chunk = plan(payload);
        if (!chunk) return null;
        return chunk.groups.length > 0 ? `Merge ${groupCount(chunk.groups.length)} into “${row.title}”` : `Move ${photos(chunk.files)} into “${row.title}”`;
      },
      onDrop: (payload) => {
        const chunk = plan(payload);
        if (!chunk) return;
        const merging = chunk.groups.length > 0;
        startRun({
          verb: merging ? 'Merging' : 'Moving',
          label: merging ? `Merging ${groupCount(chunk.groups.length)} into “${row.title}”` : `Moving ${photos(chunk.files)} into “${row.title}”`,
          chunks: [chunk],
          total: { groups: chunk.decides, files: chunk.files },
          undo: 'journal',
          done: (tally) => merging ? `${groupCount(tally.groups)} merged into “${row.title}”` : `${photos(tally.files)} moved into “${row.title}”`,
        });
      },
    };
  }, [phone, partsOf, cursor, openPaths, startRun]);

  /** How much of a group is selected, for its header's box. */
  const selectedIn = useMemo(() => {
    const some = new Set([...selection.selection.items.values(), ...selection.selection.excluded.values()]);
    return (name: string): GroupSelected =>
      selection.selection.sections.has(name) && !some.has(name) ? 'all' : some.has(name) || selection.selection.sections.has(name) ? 'some' : 'none';
  }, [selection.selection]);
  const selectGroup = useCallback(
    (row: GroupRow) => ({ range }: { range: boolean }) =>
      range ? selection.extend(stream, { section: row.name }, cursor === null ? undefined : { section: cursor }) : selection.toggleSection(row.name),
    [selection, stream, cursor],
  );

  /** Select a lane's groups whole: all of them, or those whose proposal is sure. */
  const sure = useMemo(() =>
    view.filter((row) => {
      const proposal = proposalFor(row);
      return proposal.action !== 'none' && proposal.confidence === 'high';
    }), [view, proposalFor]);

  // The time rail: groups counted by the day they start, the stream's place by the group at the
  // reading line, and a date on it brings the first group from then up to that line.
  const [streamNode, setStreamNode] = useState<HTMLDivElement | null>(null);
  const [atLine, setAtLine] = useState<string | undefined>(undefined);
  const facets = useMemo(() => railFacets(view), [view]);
  // Only over the whole index: its counts and its seek would shift as pages land.
  const groupRail = !phone && index.complete && view.length >= RAIL_MIN_GROUPS && facets.days.length >= 2;
  const seek = useCallback((date: string) => {
    const at = seekIndex(view, date, !newestFirst);
    if (at >= 0) streamRef.current?.scrollToKey(view[at].name);
  }, [view, newestFirst]);

  // A long open group (shown by month) has a rail of its own pictures instead: a date on it brings
  // its first picture from then up under the group's header, and it follows the part at that line.
  const memberRail = !phone && parts.byMonth && openItems.length > 0;
  const memberDates = useMemo(() => openItems.map((item) => ({ timeStart: item.takenAt })), [openItems]);
  const memberFacets = useMemo(() => memberRail ? railFacets(memberDates) : null, [memberRail, memberDates]);
  const [memberAt, setMemberAt] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!memberRail || cursor === null) return;
    let frame = 0;
    const follow = () => {
      frame = 0;
      const line = readingLine + SECTION_METRICS.desktop.header + PART_MARGIN + 1;
      let key: string | undefined;
      for (const node of document.querySelectorAll<HTMLElement>(`[data-group="${CSS.escape(cursor)}"] [data-part-key]`)) {
        if (node.getBoundingClientRect().top > line) break;
        key = node.dataset.partKey || undefined;
      }
      setMemberAt(key);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(follow);
    };
    follow();
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      globalThis.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [memberRail, cursor, readingLine]);
  const seekMember = useCallback((date: string) => {
    const at = seekIndex(memberDates, date, true);
    const box = at < 0 ? undefined : tiles.current.boxes[at];
    const grids = cursor === null ? null : document.querySelector(`[data-group="${CSS.escape(cursor)}"] [data-parts]`);
    if (!box || !grids) return;
    const top = grids.getBoundingClientRect().top + globalThis.scrollY + box.top - readingLine - SECTION_METRICS.desktop.header - PART_MARGIN;
    globalThis.scrollTo({ top, behavior: 'auto' });
  }, [memberDates, cursor, readingLine]);
  const rail = memberRail || groupRail;

  // The lasso: what was selected as it started, where the stream and the open group's pictures
  // were then (read once), and what the last frame took, so a frame that takes nothing new
  // selects nothing anew.
  const lassoBase = useRef<SectionSelection>(selection.selection);
  const lassoGeometry = useRef<StreamGeometry | null>(null);
  const lassoLast = useRef<LassoHits | null>(null);
  useLasso({
    enabled: !phone && view.length > 0,
    root: streamNode,
    topInset: readingLine,
    onStart: () => {
      lassoBase.current = selection.selection;
      lassoLast.current = null;
      const box = streamNode?.getBoundingClientRect();
      if (!box) {
        lassoGeometry.current = null;
        return;
      }
      const metrics = SECTION_METRICS.desktop;
      const grids = cursor === null ? undefined : streamNode?.querySelector(`[data-group="${CSS.escape(cursor)}"] [data-parts]`)?.getBoundingClientRect();
      const { items, boxes } = tiles.current;
      lassoGeometry.current = {
        left: box.left + globalThis.scrollX,
        right: box.right + globalThis.scrollX - (rail ? RAIL_GUTTER : 0),
        top: box.top + globalThis.scrollY,
        inset: SECTION_INSET,
        header: metrics.header,
        strip: closedSectionHeight(false) - metrics.header - metrics.foot,
        open: cursor !== null && grids && items.length > 0 && boxes.length === items.length
          ? {
            key: cursor,
            left: grids.left + globalThis.scrollX,
            top: grids.top + globalThis.scrollY,
            index: tileIndex(boxes.map((tile) => ({ ...tile, height: tile.height ?? 0 }))),
            paths: items.map((item) => item.path),
          }
          : undefined,
      };
    },
    onBand: (band, mode) => {
      const geometry = lassoGeometry.current;
      if (!geometry) return;
      const crossed = streamRef.current?.sectionsIn(band.top - geometry.top, band.bottom - geometry.top) ?? [];
      const hits = streamHits(band, crossed, geometry);
      if (lassoLast.current && sameHits(lassoLast.current, hits)) return;
      lassoLast.current = hits;
      selection.set(lassoSelection(lassoBase.current, hits, mode));
    },
    onCancel: () => selection.set(lassoBase.current),
  });

  const openKeys = useMemo(() => new Set(cursor === null ? [] : [cursor]), [cursor]);
  const skeleton = useMemo(() => skeletonImage(phone), [phone]);
  const cursorProposal = cursorRow ? proposalFor(cursorRow) : undefined;
  /** What Enter does where the keys are: on the open day or the selected pictures, or the whole group. */
  const cursorEnter = cursorRow ? enterFor(cursorRow, filing) : undefined;
  const canEnter = cursorEnter !== undefined;
  const cursorCandidates = useMemo(() => cursorRow ? candidatesOf(cursorRow) : [], [cursorRow, candidatesOf]);
  const legendContext = useMemo(() => ({
    candidates: cursorCandidates.map((candidate) => candidate.album.title),
    candidate: cursorCandidates[highlight]?.album.title,
    comparing,
    title: cursorRow?.title,
    previous: previousRow?.title,
    next: nextRow?.title,
    proposal: cursorEnter?.label,
    target: target?.title,
    selected: regrouping.length,
    later: across ? allLater : cursorRow?.staging.later !== undefined,
    lane: cursorRow !== undefined && isLaneGroup(cursorRow),
    groups: chosenCount.groups,
  }), [cursorRow, previousRow, nextRow, cursorEnter?.label, target, regrouping.length, across, allLater, chosenCount.groups, cursorCandidates, highlight, comparing]);
  /** S can cut here: in a lane anything, elsewhere not before the group's first picture. */
  const canCut = cursorRow !== undefined && regrouping.length > 0 && (isLaneGroup(cursorRow) || regrouping[0] !== openItems[0]?.path);
  const available = useCallback((action: TriageAction) => {
    if (scope === 'groups') {
      if (action === 'apply') return chosen.groups.length > 0;
      if (action === 'new' || action === 'private' || action === 'later') return selectedGroups.length > 0;
    }
    if (action === 'candidate-1' || action === 'candidate-2' || action === 'candidate-3') return cursorCandidates[Number(action.slice(-1)) - 1]?.album.writable === true;
    if (action === 'reject' || action === 'compare' || action === 'candidate-next' || action === 'candidate-previous') return cursorCandidates.length > 0;
    if (action === 'merge-up') return previousRow !== undefined && cursorRow !== undefined && mergeable(previousRow, cursorRow);
    if (action === 'merge-down') return nextRow !== undefined && cursorRow !== undefined && mergeable(cursorRow, nextRow);
    if (action === 'apply') return canEnter;
    if (action === 'part-next' || action === 'part-previous') return parts.sections.length > 1;
    if (action === 'split') return canCut;
    if (action === 'move-up') return previousRow !== undefined && regrouping.length > 0;
    if (action === 'move-down') return nextRow !== undefined && regrouping.length > 0;
    if (action === 'move-to') return regrouping.length > 0;
    return cursorRow !== undefined;
  }, [scope, chosen, selectedGroups, cursorRow, previousRow, nextRow, canEnter, parts.sections.length, canCut, regrouping.length, cursorCandidates]);
  const backlog = queue.items.filter((item) => item.state !== 'failed');
  const column = !phone && width >= COLUMN_MIN_WIDTH && cursorRow !== undefined && cursorProposal !== undefined;

  if (index.error) return <Alert color='red' m='md'>{index.error.message}</Alert>;
  if (!index.complete && index.rows.length === 0) return <PageLoader label='Loading the suggested albums…' />;
  if (index.rows.length === 0) {
    return (
      <EmptyState title='No groups yet' actions={<Button variant='light' onClick={onShowFiles}>Show the files</Button>}>
        {stillIndexing > 0
          ? `Groups appear as your files are prepared: ${stillIndexing.toLocaleString()} still to go.`
          : 'Groups appear here once uploaded files have been prepared and organized, within minutes of their arrival.'}
      </EmptyState>
    );
  }

  return (
    <Box ref={widthRef}>
      <Group justify='space-between' px='md' pb='xs' gap='xs'>
        {lanesInUse.length > 1
          ? (
            <SegmentedControl
              size='xs'
              value={lane}
              onChange={(value) => setParam('lane', value === 'sort' ? null : value)}
              data={lanesInUse.map((each) => ({ value: each.id, label: `${each.label} ${counts[each.id].groups.toLocaleString()}` }))}
            />
          )
          : (
            <Text size='sm' c='dimmed'>
              {index.complete ? '' : '≥ '}
              {photos(view.reduce((sum, row) => sum + (row.memberCount ?? 0), 0))} to decide in {view.length.toLocaleString()} {view.length === 1 ? 'group' : 'groups'}
            </Text>
          )}
        <Group gap='xs'>
          {backlog.length > 0 && <Text size='xs' c='dimmed'>◌ {backlog.length.toLocaleString()} applying</Text>}
          {!phone && selection.active && (
            <Text size='xs' c='dimmed' aria-live='polite'>
              {selectionWords(chosenCount)} selected
            </Text>
          )}
          {!phone && (
            <Menu position='bottom-end' withinPortal>
              <Menu.Target>
                <Button size='xs' variant='default' leftSection={<TablerIcon name='checkbox' size={14} />}>Select</Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => selection.setSections(names, true)} disabled={view.length === 0}>
                  All in {LANES.find((each) => each.id === lane)?.label ?? 'this lane'} · {view.length.toLocaleString()}
                </Menu.Item>
                <Menu.Item onClick={() => selection.setSections(sure.map((row) => row.name), true)} disabled={sure.length === 0}>
                  Those with a sure proposal · {sure.length.toLocaleString()}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item onClick={() => selection.clear()} disabled={!selection.active} rightSection={<Text size='xs' c='dimmed'>Esc</Text>}>
                  None
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
          <Select
            size='xs'
            w={150}
            aria-label='Order'
            value={newestFirst ? 'new' : 'old'}
            onChange={(value) => setParam('order', value === 'new' ? 'new' : null)}
            data={[{ value: 'old', label: 'Oldest first' }, { value: 'new', label: 'Newest first' }]}
            allowDeselect={false}
          />
        </Group>
      </Group>

      {finding && <Text size='sm' c='dimmed' px='md' pb='xs'>Finding where you were…</Text>}

      <Group align='flex-start' gap='md' wrap='nowrap'>
        <Box style={{ flex: 1, minWidth: 0 }}>
          {view.length === 0
            ? (
              <EmptyState title={`Everything in ${LANES.find((each) => each.id === lane)?.label ?? 'this lane'} is decided`}>
                {filed > 0 ? `${photos(filed)} filed today.` : 'Nothing is left to decide here.'}
              </EmptyState>
            )
            : (
              <Box ref={setStreamNode} pr={rail ? RAIL_GUTTER : 0}>
                <SectionStream
                  ref={streamRef}
                  items={view}
                  itemKey={(row) => row.name}
                  openKeys={openKeys}
                  closedHeight={closedSectionHeight(phone)}
                  readingLine={readingLine}
                  skeleton={skeleton}
                  onReadingLine={setAtLine}
                >
                  {(row, at, open) => (
                    <GroupSection
                      row={row}
                      open={open}
                      phone={phone}
                      renaming={renaming === row.name}
                      onRenamingChange={(on) => setRenaming(on ? row.name : null)}
                      previous={at > 0 ? view[at - 1].title : undefined}
                      next={at < view.length - 1 ? view[at + 1].title : undefined}
                      failure={failures.get(row.name)}
                      onDismissFailure={() => setFailures((previous) => withoutKey(previous, row.name))}
                      onActivate={() => moveTo(row.name)}
                      actions={actionsFor(row, at)}
                      tileCursor={open ? tileCursor : null}
                      onTiles={open ? onTiles : undefined}
                      selection={open && !phone ? picked : undefined}
                      partCursor={open ? partCursor : null}
                      onParts={open ? onParts : undefined}
                      partCut={open
                        ? isLaneGroup(row)
                          ? { label: 'New group', fromFirst: true, run: (section) => newGroup(row, section.items.map((item) => item.path)) }
                          : { label: 'Split here', fromFirst: false, run: (section) => splitAt(row, section.items[0].path) }
                        : undefined}
                      partMatch={open ? partMatchOf(row) : undefined}
                      newGroup={open && !phone && filing.length > 0 ? { count: filing.length, run: () => newGroup(row, filing) } : undefined}
                      arriveFrom={open && arrival?.name === row.name ? arrival.from : undefined}
                      selected={selectedIn(row.name)}
                      onSelect={phone ? undefined : selectGroup(row)}
                      grip={phone ? undefined : gripOf(row)}
                      drop={headerDrop(row)}
                      dragPayload={open && !phone ? dragPicture : undefined}
                      duplicates={open && duplicatesView.badges.size > 0
                        ? {
                          badges: duplicatesView.badges,
                          compare: (id) => setComparingSet(duplicatesView.setOf.get(id) ?? null),
                          keepLibrary: duplicatesView.library.files > 0
                            ? () => resolveSets(row, duplicatesView.library.keys, `Keeping the library copies of ${photos(duplicatesView.library.files)} in “${row.title}”`)
                            : undefined,
                        }
                        : undefined}
                    />
                  )}
                </SectionStream>
              </Box>
            )}
        </Box>
        {column && (
          <Box w={comparing ? Math.round(width * COMPARE_SHARE) : COLUMN_WIDTH} style={{ position: 'sticky', top: readingLine + 8, flexShrink: 0 }} pr='md'>
            <DestinationColumn
              subject={across ? `${selectionWords(chosenCount)} selected` : cursorRow.title}
              groups={across ? { count: chosenCount.groups, files: chosenCount.files } : undefined}
              drop={destinationDrop}
              selected={filing.length}
              part={selected.length === 0 ? part?.label : undefined}
              proposal={cursorProposal}
              target={target}
              recent={recent}
              previous={previousRow?.title}
              next={nextRow?.title}
              later={across ? allLater : cursorRow.staging.later !== undefined}
              onApply={() => act('apply')}
              onNew={() => act('new')}
              onPrivate={() => act('private')}
              onAddTo={() => act('add-to')}
              onTarget={() => act('target')}
              onSetTarget={() => act('set-target')}
              onRecent={(album) => across ? fileParts(chosen, album) : fileInto(cursorRow, album, selected)}
              onLater={() => act('later')}
              onDiscard={() => act('discard')}
              onMergeUp={previousRow && cursorRow && mergeable(previousRow, cursorRow) ? () => act('merge-up') : undefined}
              onMergeDown={nextRow && cursorRow && mergeable(cursorRow, nextRow) ? () => act('merge-down') : undefined}
              split={canCut ? { label: isLaneGroup(cursorRow) ? 'New group' : 'Split the group here', run: () => act('split') } : undefined}
              onMoveUp={() => act('move-up')}
              onMoveDown={() => act('move-down')}
              onMoveTo={() => act('move-to')}
              onDate={() => act('date')}
              onNotAGroup={isLaneGroup(cursorRow) ? undefined : () => setDeleting(cursorRow)}
              candidates={cursorCandidates}
              highlighted={highlight}
              onCandidate={(index) => toCandidate(cursorRow, index, across ? [] : selected)}
              onHighlight={setHighlight}
              onReject={(index) => rejectCandidate(cursorRow, index)}
              unmatched={cursorRow.staging.matchedAt !== undefined && !isLaneGroup(cursorRow)}
              strip={{ timeStart: cursorRow.timeStart, timeEnd: cursorRow.timeEnd }}
              comparing={comparing}
              onCompare={() => setComparing((on) => !on)}
            />
          </Box>
        )}
      </Group>

      {memberRail ? <TimelineScrubber facets={memberFacets} currentDate={memberAt} onSeek={seekMember} below={streamNode} ascending /> : groupRail && (
        <TimelineScrubber
          facets={facets}
          currentDate={atLine === undefined ? undefined : byName.get(atLine)?.timeStart?.slice(0, 10)}
          onSeek={seek}
          below={streamNode}
          ascending={!newestFirst}
        />
      )}

      {!phone && view.length > 0 && (
        <Box style={{ position: 'sticky', bottom: 0, zIndex: 4 }}>
          <StagingDock scope={scope} context={legendContext} available={available} act={act} announce={announce} />
        </Box>
      )}

      <NameDialog
        group={naming && { title: naming.row.title, count: naming.files.length || naming.row.memberCount }}
        private={naming?.private}
        onClose={() => setNaming(null)}
        onConfirm={(title) => {
          const asked = naming;
          setNaming(null);
          if (asked) fileNew(asked.row, title, asked.private, asked.files);
        }}
      />
      <AlbumPickerDialog
        opened={picking !== null}
        title={picking?.setTarget ? 'Choose the target' : 'Add to an album'}
        allowNew={!picking?.setTarget || picking.file}
        subtitle={picking ? (picking.file ? `${photos(picking.files.length || (picking.row.memberCount ?? 0))} from “${picking.row.title}”` : 'B files into it') : undefined}
        suggested={recent}
        onClose={() => setPicking(null)}
        onPick={(choice: AlbumChoice) => {
          const asked = picking;
          setPicking(null);
          if (!asked) return;
          if (choice.create) {
            fileNew(asked.row, choice.title, false, asked.files);
            return;
          }
          const album = { path: choice.path, title: choice.title };
          if (asked.setTarget) {
            setChosenTarget(JSON.stringify(album));
            say(`B now files into “${album.title}”`);
          }
          if (asked.file) fileInto(asked.row, album, asked.files);
        }}
      />
      <DiscardGroupDialog
        group={discarding && { title: discarding.title, count: discarding.memberCount ?? 0 }}
        onClose={() => setDiscarding(null)}
        onConfirm={() => {
          const row = discarding;
          setDiscarding(null);
          if (row) discard(row);
        }}
      />
      <GroupPickerDialog
        moving={moving && { from: moving.row.title, count: moving.files.length }}
        neighbours={neighbours}
        all={pickable}
        onClose={() => setMoving(null)}
        onPick={(to) => {
          const asked = moving;
          setMoving(null);
          if (!asked) return;
          if (to === 'new') newGroup(asked.row, asked.files);
          else moveInto(asked.row, to, asked.files);
        }}
      />
      <SetTimeAction
        opened={dating !== null}
        onClose={() => setDating(null)}
        items={dating?.items ?? []}
        onApplied={() => {
          const asked = dating;
          if (!asked) return;
          forgetMediaSet(asked.row.path);
          index.reread([asked.row.path]);
          leaveInside();
          say(`The time is set on ${photos(asked.items.length)} of “${asked.row.title}”`, undefined, 'green');
          changed();
        }}
      />
      <NameDialog
        group={bulkNaming && { title: selectedGroups[0]?.title ?? '', count: partsCount(bulkNaming.parts).files }}
        private={bulkNaming?.private}
        onClose={() => setBulkNaming(null)}
        onConfirm={(title) => {
          const asked = bulkNaming;
          setBulkNaming(null);
          if (asked) newAlbumParts(asked.parts, title, asked.private);
        }}
      />
      <AlbumPickerDialog
        opened={bulkPicking !== null}
        title='Add to an album'
        allowNew
        subtitle={bulkPicking ? selectionWords(partsCount(bulkPicking)) : undefined}
        suggested={recent}
        onClose={() => setBulkPicking(null)}
        onPick={(choice: AlbumChoice) => {
          const asked = bulkPicking;
          setBulkPicking(null);
          if (!asked) return;
          if (choice.create) newAlbumParts(asked, choice.title, false);
          else fileParts(asked, { path: choice.path, title: choice.title });
        }}
      />
      <DiscardGroupDialog
        group={bulkDiscarding && { title: selectionWords(partsCount(bulkDiscarding)), count: partsCount(bulkDiscarding).files }}
        onClose={() => setBulkDiscarding(null)}
        onConfirm={() => {
          const asked = bulkDiscarding;
          setBulkDiscarding(null);
          if (asked) discardParts(asked);
        }}
      />
      <CompareDialog
        set={comparingSet}
        onClose={() => setComparingSet(null)}
        onResolve={(set, keep) => {
          setComparingSet(null);
          if (cursorRow) resolveSets(cursorRow, [set.key], `Removing what duplicates the kept one in “${cursorRow.title}”`, keep === set.keep ? undefined : keep);
        }}
        onSeparate={(set) => {
          setComparingSet(null);
          if (cursorRow) separateSet(cursorRow, set);
        }}
      />
      <BulkConfirmDialog
        groups={accepting}
        onClose={() => setAccepting(null)}
        onConfirm={(groups, floor) => {
          setAccepting(null);
          acceptGroups(groups, floor);
        }}
      />
      <DeleteGroupDialog
        group={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) removeGroup(row);
        }}
      />
    </Box>
  );
}
