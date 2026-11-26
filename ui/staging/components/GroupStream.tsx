import type { AlbumAddResult, DuplicateResolveResult, DuplicateSet } from '@archive/media/api';
import type {
  MatchConfidence,
  StagingAcceptResult,
  StagingCandidate,
  StagingCategoryStatus,
  StagingDiscardResult,
  StagingEditResult,
  StagingPromoteResult,
  StagingUndoResult,
} from '@archive/staging/api';
import { type Proposal, proposalInputOf, proposeDestination } from '@archive/staging/proposal';
import { EmptyState, PageLoader, ScrollBox, SectionStream, type SectionStreamHandle } from '@ein/ui/components';
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
import { Alert, Box, Button, Text, VisuallyHidden } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { albumRoute } from '../../media/lib/album-path.ts';
import { type AlbumChoice, AlbumPickerDialog } from '../../media/components/AlbumPickerDialog.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { TimelineScrubber } from '../../components/TimelineScrubber.tsx';
import { railFacets, seekIndex } from '../lib/scrubber-facets.ts';
import { type GroupRow, useGroupIndex } from '../hooks/useGroupIndex.ts';
import { useGroupDetails } from '../hooks/useGroupDetails.ts';
import { useDuplicateSets } from '../hooks/useDuplicateSets.ts';
import { useFileDuplicates } from '../hooks/useFileDuplicates.ts';
import { useSetActions } from '../hooks/useSetActions.ts';
import { groupDuplicates } from '../lib/duplicate-sets.ts';
import { cardTitle } from '../lib/group-title.ts';
import * as commands from '../lib/decision-commands.ts';
import { type AlbumTarget, CONFIDENCE_WORDS, proposalLabel } from '../lib/destinations.ts';
import { inLane, isLaneGroup, laneCounts, LANES, shownLane, type StagingLane } from '../lib/lanes.ts';
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
  newAlbumChunks,
  noParts,
  ownAlbumChunks,
  partsCount,
  type SelectionParts,
  selectionParts,
} from '../lib/selection-command.ts';
import { type BulkHandle, type BulkSpec, useBulkRun } from '../hooks/useBulkRun.ts';
import { useTriageKeys } from '../hooks/useTriageKeys.ts';
import { BulkConfirmDialog } from './BulkConfirmDialog.tsx';
import { CompareDialog } from './CompareDialog.tsx';
import { duplicateBadge } from './DuplicateBadge.tsx';
import { DeleteGroupDialog } from './DeleteGroupDialog.tsx';
import { GroupSelectionBar } from './GroupSelectionBar.tsx';
import { DiscardGroupDialog } from './DiscardGroupDialog.tsx';
import { GroupPickerDialog } from './GroupPickerDialog.tsx';
import type { GroupActions, GroupDrop, GroupFailure, GroupSelected } from './GroupHeader.tsx';
import { closedSectionEstimate, closedSectionHeight, gridEstimate, GroupSection, type PartMatch, SECTION_INSET, SECTION_METRICS } from './GroupSection.tsx';
import { NameDialog } from './NameDialog.tsx';
import { AddToExistingDialog } from './AddToExistingDialog.tsx';
import './sort-panes.css';

type Props = {
  /** The category whose suggested groups are sorted. */
  category: StagingCategoryStatus;
  /** Something was filed, merged or deleted, so the category's numbers changed; called once a run of decisions has rested. */
  onChanged: () => void;
  /** The Files tab, where the files without a group yet are. */
  onShowFiles: () => void;
  stillIndexing: number;
  /** What the page's header says of the stream, and offers, whenever it changes: nothing until there are groups. */
  onBar?: (bar: SortBar | null) => void;
  /** What heads the stream, above its groups and whatever stands in for them: the cards of files waiting outside every group. */
  lead?: ReactNode;
};

/**
 * What the page's header shows for the Sort tab: the lanes in use with their groups, to switch
 * between when there are two or more, else how much the one lane holds; and how many decisions are
 * still being applied.
 */
export type SortBar = {
  /** The lane the stream shows. */
  lane: StagingLane;
  lanes: readonly { id: StagingLane; label: string; groups: number }[];
  summary: string;
  applying: number;
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
  /** An edit of the groups: those it made or changed are read again, and those it removed leave. */
  regrouped?: (answer: T) => StagingEditResult;
};

/** A decision of this session, newest last: what Z takes back. A run over many groups is undone whole. */
type Taken =
  | { id: number; label: string; row: GroupRow; queued: number; journal: string[] | null; bulk?: undefined }
  | { id: number; label: string; bulk: BulkHandle };

/** Groups at least this large ask before X discards them. */
const DISCARD_ASKS = 200;
/** The groups whose parts and candidates are read ahead: the cursor's and the next ones. */
const DETAILS_AHEAD = 2;

/** The groups after the cursor whose pictures are asked for ahead; one further away than this is given up. */
const PREFETCH_AHEAD = 2;
const PREFETCH_KEEP = 3;
/** The cursor goes into the URL once it has rested this long, so a held J does not write history. */
const URL_DEBOUNCE_MS = 400;
/** Below this many groups the stream is a few screens long, and a time rail has nothing to do. */
const RAIL_MIN_GROUPS = 30;
/** The category's numbers are asked for again this long after the last decision, once for a run of them. */
const STATUS_AFTER_MS = 5000;

/** Groups the G picker offers on each side of the open one before a search. */
const PICKER_NEIGHBOURS = 5;
/** Room kept above a part brought to the reading line, under the open group's own header. */
const PART_MARGIN = 8;

/** The name a new album of the group is offered, or made under unasked: the proposed one, else the group's, without the dates it ends with. */
const suggestedTitle = (row: GroupRow, proposal: Proposal): string => cardTitle(proposal.action === 'new' ? proposal.title : row.title);

/** Two groups merge only when neither is a lane's. */
const mergeable = (a: GroupRow, b: GroupRow): boolean => !isLaneGroup(a) && !isLaneGroup(b);

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;
const groupCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'group' : 'groups'}`;
/** A selection as words: "3 groups · 412 photos", or the photos alone. */
const selectionWords = (count: { groups: number; files: number }) => count.groups > 0 ? `${groupCount(count.groups)} · ${photos(count.files)}` : photos(count.files);

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
 * The Sort tab: a category's suggested albums (those in its groups directory) as one stream, oldest
 * first, the cursor's group open and the others closed to a strip of their pictures. Past a phone it
 * fills the window below the page's header and scrolls in its own box; a phone's scrolls with the
 * page.
 *
 * J and K move the cursor; Enter applies the group's proposal; 1, 2 and 3 file it into the albums
 * it is suggested for; N makes it a new album, named first; A opens Add to existing, which files it
 * into any album; X discards it; E renames it; T sets the time of its pictures; Z undoes the last
 * decision of the session. An Everyday lane's proposal files the days
 * that match an album, each into its album; a part of it with a match goes there on Enter. The keys
 * are listed by the page's keyboard shortcuts (`?`), from `lib/triage-keys.ts`. Each card has
 * Create, Add to existing — the albums it is matched to with some of their pictures, and a search for
 * any other, in a dialog (`AddToExistingDialog.tsx`) — and a menu, which on the cursor's group act on
 * what the keys act on.
 *
 * Inside the open group, `[` and `]` step through its parts (a day each, or a month each in a long
 * group); with a part, or pictures of the group selected (Space on a picture, or a click once one
 * is), Enter, N, A and X act on those alone, S splits the group before them (in a lane it makes
 * them a group of their own), `<` and `>` move them into the group above or below, and G into any
 * group or a new one. With a picture under the arrows' cursor, S, `<`, `>` and G act on it. Edits
 * of the groups are journaled and undone as decisions are. A long open group has a time rail of its
 * own pictures in place of the stream's.
 *
 * A decision takes its group out of the stream at once and moves the cursor on; its one command
 * waits its turn in the page's serial queue, and a reload asks first while any is waiting. One
 * that fails brings the group back with why, and Retry. Each one done says so in a toast with
 * Undo, which runs `staging undo` on its journal entries — after a reload, the Done tab does.
 *
 * On a desktop a selection reaches across groups: a header's box (or a click on its name with
 * Ctrl or Cmd) selects a group whole, Shift selects on from where the selection started — the
 * rest of that group, the groups between whole, the head of the last — and so do Shift+J and
 * Shift+K; a lasso drawn
 * from the background or an unselected picture takes the closed groups it covers and the open
 * group's pictures it touches. A selection past the open group is decided on as many groups:
 * Enter accepts their proposals after a plan, N and A file them, X discards them, and the selection
 * bar merges two or more selected whole into the first of them, each a run of calls within the
 * verbs' caps with a progress toast, Cancel and Undo all (`hooks/useBulkRun.ts`). With pictures of
 * the open group selected, the bar splits the group before them and moves them to another group.
 * Selected pictures drag onto other groups' headers, which merge or move them there.
 */
export function GroupStream({ category, onChanged, onShowFiles, stillIndexing, onBar, lead }: Props) {
  useSignals();
  const albumsPath = category.albumsPath;
  const phone = usePhone();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Past a phone the stream scrolls in a pane of its own, whose top is its reading line; a phone's
  // scrolls with the page, under the page's headers.
  const pane = !phone;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [paneTop, setPaneTop] = useState(0);
  useLayoutEffect(() => {
    if (!scroller) return;
    // It fills the window below what is over it, so a change there resizes it; and should the page
    // scroll after all, it moves.
    const measure = () => setPaneTop(Math.round(scroller.getBoundingClientRect().top));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    globalThis.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      globalThis.removeEventListener('scroll', measure);
    };
  }, [scroller]);
  const headerLine = useHeaderHeight();
  const readingLine = pane ? paneTop : headerLine;
  /** Scroll the stream by `top` px: its pane, or the page. */
  const scrollStream = useCallback((top: number) => (scroller ?? globalThis).scrollBy({ top, behavior: 'auto' }), [scroller]);
  /** Where what shows of the stream ends, in px from the top of the window. */
  const streamBottom = useCallback(() => scroller ? scroller.getBoundingClientRect().bottom : globalThis.innerHeight, [scroller]);
  const streamRef = useRef<SectionStreamHandle>(null);
  const [widthRef, width] = useElementWidth<HTMLDivElement>();
  // One call per section, always the same number of them.
  useShortcutHelp(TRIAGE_HELP[0].group, TRIAGE_HELP[0].entries);
  useShortcutHelp(TRIAGE_HELP[1].group, TRIAGE_HELP[1].entries);
  useShortcutHelp(TRIAGE_HELP[2].group, TRIAGE_HELP[2].entries);
  useShortcutHelp(TRIAGE_HELP[3].group, TRIAGE_HELP[3].entries);
  useShortcutHelp(TRIAGE_HELP[4].group, TRIAGE_HELP[4].entries);
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

  const statusTimer = useRef<number | undefined>(undefined);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const changed = useCallback(() => {
    globalThis.clearTimeout(statusTimer.current);
    statusTimer.current = globalThis.setTimeout(() => onChangedRef.current(), STATUS_AFTER_MS);
  }, []);
  useEffect(() => () => globalThis.clearTimeout(statusTimer.current), []);

  const newestFirst = searchParams.get('order') === 'new';
  const counts = useMemo(() => laneCounts(index.rows), [index.rows]);
  const lane = shownLane(searchParams.get('lane'), counts, index.complete);
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
  // The open group's copies and look-alikes of library photos: its header's count, and its proposal.
  const openDuplicates = useDuplicateSets(cursorRow?.path ?? '', cursorRow?.staging.memberKey ?? '', cursorRow !== undefined);
  const duplicatesView = useMemo(() => {
    const sets = openDuplicates.page?.sets ?? [];
    return groupDuplicates(sets, new Set(sets.flatMap((set) => set.staged.filter((member) => member.inScope).map((member) => member.id))));
  }, [openDuplicates.page]);

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
  // In its pane, the stream is drawn once the pane is there to scroll.
  const streamReady = !pane || scroller !== null;
  useEffect(() => {
    if (broughtIntoView.current || cursor === null || !streamReady) return;
    broughtIntoView.current = true;
    if (cursorIndex > 0) streamRef.current?.scrollToKey(cursor);
  }, [cursor, cursorIndex, streamReady]);

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
    setTileCursor(null);
    setPartCursor(null);
    setOpenItems([]);
    setParts({ sections: [], byMonth: false });
    tiles.current = { items: [], boxes: [] };
  }
  const part = partCursor === null ? undefined : parts.sections.find((section) => section.id === partCursor);

  // The group whose pictures are shown in full: only the cursor's can be, and only when asked
  // (its header's button, Space), so that moving the cursor changes nothing in the stream's layout.
  const [expanded, setExpanded] = useState<string | null>(null);
  const cursorOpen = cursor !== null && expanded === cursor;
  const openRef = useRef(cursorOpen);
  openRef.current = cursorOpen;

  // The group that takes the place of one just decided, and how far below the reading line it was:
  // it slides up from there.
  const [arrival, setArrival] = useState<{ name: string; from: number } | null>(null);
  /**
   * Put the cursor on `name`, closing the group expanded. Unless it was clicked (`scroll` false),
   * the stream scrolls when the group is not wholly in view: just far enough to show it, or, when
   * the group closing changes the layout or it is taller than the pane, to bring it to the reading
   * line.
   */
  const moveTo = useCallback((name: string | null, slideFrom?: number, scroll = true) => {
    if (name === null) return;
    const collapsing = openRef.current;
    setWanted(name);
    setExpanded(null);
    setArrival(slideFrom === undefined ? null : { name, from: slideFrom });
    setTileCursor(null);
    setPartCursor(null);
    tiles.current = { items: [], boxes: [] };
    setOpenItems([]);
    setParts({ sections: [], byMonth: false });
    if (!scroll && !collapsing) return;
    const box = collapsing ? undefined : document.querySelector(`[data-group="${CSS.escape(name)}"]`)?.getBoundingClientRect();
    const bottom = streamBottom();
    if (box && box.top >= readingLine && box.bottom <= bottom) return;
    if (box && box.top > readingLine && box.height <= bottom - readingLine) scrollStream(box.bottom - bottom);
    else streamRef.current?.scrollToKey(name);
  }, [readingLine, streamBottom, scrollStream]);
  /** Show all of the group's pictures, putting the cursor on it, or its strip again. */
  const toggleExpanded = useCallback((name: string) => {
    if (openRef.current && expanded === name) {
      setExpanded(null);
      setTileCursor(null);
      setPartCursor(null);
      return;
    }
    if (name !== cursor) moveTo(name);
    setExpanded(name);
  }, [expanded, cursor, moveTo]);
  /** How far below the reading line the group `name` stands now, as far as the stream shows; none when it is not below. */
  const belowReadingLine = useCallback((name: string): number | undefined => {
    const bottom = streamBottom();
    const top = document.querySelector(`[data-group="${CSS.escape(name)}"]`)?.getBoundingClientRect().top ?? bottom;
    const distance = Math.min(top, bottom) - readingLine;
    return distance > 0 ? distance : undefined;
  }, [readingLine, streamBottom]);

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
        if (entry.journal && entry.journal.length > 0) return execCommand<StagingUndoResult>(commands.undoEntries(entry.journal));
        throw new Error('it changed nothing that can be put back');
      },
      onDone: (answer) => {
        index.reread([entry.row.path]);
        forgetMediaSet(entry.row.path);
        moveTo(entry.row.name);
        const failed = answer.failed;
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
    const entry: Taken = { id: ++takenIds.current, label: decision.label, row, queued: 0, journal: null };
    entry.queued = queue.enqueue({
      label: decision.label,
      run: async () => {
        const answer = await execCommand<T>(decision.command);
        decision.check?.(answer);
        return answer;
      },
      onDone: (answer) => {
        if (whole) {
          index.remove([row.name]);
          setPending((previous) => without(previous, row.name));
        } else {
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
        const undoable = entry.journal.length > 0;
        if (!undoable) taken.current = taken.current.filter((each) => each.id !== entry.id);
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
  }, [names, failures, cursor, byName, moveTo, belowReadingLine, index, changed, queue, say, undoTaken, albumsPath]);
  const decideRef = useRef(decide);
  decideRef.current = decide;

  /** An edit's answer that says a group changed is no edit: the reader must look again. */
  const editHeld = (answer: StagingEditResult) => {
    if (answer.changed.length > 0) throw new Error('it changed while you were deciding; look again');
  };

  const editJournal = (answer: StagingEditResult) => answer.journal ? [answer.journal] : [];

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
  /** Groups the selection holds, whole or but for some pictures. */
  const selectedGroups = useMemo(() => [...chosen.groups, ...chosen.partial.map(({ group }) => group)], [chosen]);
  // What is selected of groups that left the view (decided, gone, another lane) is let go.
  useEffect(() => selection.keep((section) => byName.has(section)), [byName]);
  const partPaths = useMemo(() => part?.items.map((item) => item.path) ?? [], [part]);
  /** What Enter, N, A and X act on inside the open group: the selection, else the part; none for the whole group. */
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
    });
    setFiled((value) => value + (row.memberCount ?? 0));
  }, [decide, leaveInside]);

  /** Make the group, or the pictures selected in it, a new album titled `title`. */
  const fileNew = useCallback((row: GroupRow, title: string, files: readonly string[] = []) => {
    const except = files.length > 0 ? openPaths.filter((path) => !files.includes(path)) : [];
    decide<StagingPromoteResult>({
      row,
      whole: files.length === 0,
      command: commands.promoteNew(row, title, except),
      label: `Filing ${photos(files.length || (row.memberCount ?? 0))} in a new album “${title}”`,
      failed: `Couldn't make “${title}”`,
      check: unchanged,
      done: (answer) => `${photos(answer.moved)} filed in “${answer.album?.title ?? title}”`,
      journal: (answer) => answer.journal ? [answer.journal] : [],
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
      done: (tally) => `${photos(tally.files)} filed in “${album.title}”`,
    });
  }, [startRun]);

  /** Make the selection one new album: the first call makes it, the rest file into it. */
  const newAlbumParts = useCallback((what: SelectionParts<GroupRow>, title: string) => {
    const start = newAlbumChunks(what, title);
    if (!start) {
      say('A new album starts from a group: select one whole, or add these pictures to an album.');
      return;
    }
    const count = partsCount(what);
    let made: AlbumTarget | undefined;
    startRun({
      verb: 'Filing',
      label: `Filing ${selectionWords(count)} in a new album “${title}”`,
      chunks: [start.first],
      then: (answer) => {
        const album = (answer as StagingPromoteResult).album;
        if (!album) return [];
        made = { path: album.path, title: album.title };
        return fileChunks(start.rest, album.path);
      },
      total: count,
      done: (tally) => `${photos(tally.files)} filed in “${made?.title ?? title}”`,
    });
  }, [startRun, say]);

  const discardParts = useCallback((what: SelectionParts<GroupRow>) => {
    const count = partsCount(what);
    startRun({
      verb: 'Discarding',
      label: `Discarding ${selectionWords(count)}`,
      chunks: discardChunks(what),
      total: count,
      done: (tally) => `${photos(tally.files)} moved to the trash`,
    });
  }, [startRun]);

  /** Accept the proposals of the groups confirmed in the plan dialog, at least as sure as `floor`. */
  const acceptGroups = useCallback((groups: GroupRow[], floor: MatchConfidence) => {
    const files = groups.reduce((sum, row) => sum + (row.memberCount ?? 0), 0);
    startRun({
      verb: 'Filing',
      label: `Accepting the proposals of ${groupCount(groups.length)}`,
      chunks: acceptChunks(groups, floor),
      total: { groups: groups.length, files },
      done: (tally) => `${groupCount(tally.groups)} filed, ${photos(tally.files)}`,
    });
  }, [startRun]);

  /** Create album: of which group, which of its pictures (none: all of it), and the name it starts from. */
  const [naming, setNaming] = useState<{ row: GroupRow; files: string[]; title: string } | null>(null);
  /** The decisions over many groups that ask first: their name, their album, the discard, the plan of their proposals. */
  const [bulkNaming, setBulkNaming] = useState<SelectionParts<GroupRow> | null>(null);
  const [bulkPicking, setBulkPicking] = useState<SelectionParts<GroupRow> | null>(null);
  const [bulkDiscarding, setBulkDiscarding] = useState<SelectionParts<GroupRow> | null>(null);
  const [accepting, setAccepting] = useState<GroupRow[] | null>(null);
  const [discarding, setDiscarding] = useState<GroupRow | null>(null);
  const [deleting, setDeleting] = useState<GroupRow | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Add to existing: for which group, and which of its pictures (none: all of it). */
  const [suggesting, setSuggesting] = useState<{ name: string; files: string[] } | null>(null);
  const suggestingRow = suggesting === null ? null : byName.get(suggesting.name) ?? null;
  /** The G picker: pictures of which group are moved. */
  const [moving, setMoving] = useState<{ row: GroupRow; files: string[] } | null>(null);
  /** T: the pictures whose time is being set, of which group. */
  const [dating, setDating] = useState<{ row: GroupRow; items: MediaItem[] } | null>(null);
  // A picture's exact copies, which join no group: a badge on its tile, which compares them.
  const duplicates = useFileDuplicates(0);
  const [comparing, setComparing] = useState<DuplicateSet | null>(null);
  const rereadDuplicates = duplicates.reread;
  const setActions = useSetActions(
    category.path,
    useCallback(() => {
      rereadDuplicates();
      onChanged();
    }, [rereadDuplicates, onChanged]),
  );
  const { badge: duplicateOf, setOf: duplicateSetOf } = duplicates;
  const renderDuplicate = useCallback((item: MediaItem) => {
    const badge = duplicateOf(item);
    return badge ? duplicateBadge(badge, () => setComparing(duplicateSetOf(item.path) ?? null)) : null;
  }, [duplicateOf, duplicateSetOf]);

  const modalOpen = useRef<boolean>(false);
  modalOpen.current = naming !== null || suggestingRow !== null || discarding !== null || deleting !== null || moving !== null || dating !== null ||
    bulkNaming !== null || bulkPicking !== null || bulkDiscarding !== null || accepting !== null || comparing !== null;

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
          row.name === cursor && openDuplicates.page ? { members: row.memberCount ?? 0, libraryDuplicates: duplicatesView.library.files } : undefined,
        ),
      ),
    [cursor, openDuplicates.page, duplicatesView],
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
    if (proposal.action === 'new') return { label, run: () => setNaming({ row, files, title: suggestedTitle(row, proposal) }) };
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
    else say('Nothing is proposed for it: create an album, add it to one, or discard it.');
  }, [enterFor, say]);

  /** Create new: a new album of `files` of `row` (none: all of it), named in a dialog that starts from its suggested name. */
  const createAlbum = useCallback((row: GroupRow, files: string[]) => {
    const proposal = proposalFor(row);
    setNaming({ row, files, title: suggestedTitle(row, proposal) });
  }, [proposalFor]);

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

  /** The albums `row` is suggested for, best first. */
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

  /** R, or Not this album: `candidate` is not where the group goes; it is matched again without it. */
  const rejectCandidate = useCallback((row: GroupRow, candidate: StagingCandidate) => {
    decide<StagingEditResult>({
      row,
      whole: false,
      command: commands.reject(row, candidate.album.path),
      label: `“${row.title}” is not for “${candidate.album.title}”`,
      failed: `Couldn't set “${candidate.album.title}” aside`,
      done: () => `“${candidate.album.title}” is no longer offered for “${row.title}”`,
      journal: editJournal,
    });
  }, [decide]);

  /**
   * What a card's buttons and menu do. On the cursor's group they act on what the keys do — the
   * pictures selected in it, or its part — and on any other group on all of it.
   */
  const actionsFor = useCallback((row: GroupRow): GroupActions => {
    const proposal = proposalFor(row);
    const label = proposalLabel(proposal);
    const files = row.name === cursor && !across ? filing : [];
    return {
      ...(label && proposal.action !== 'new'
        ? { proposal: { label, run: () => apply(row, []), ...(proposal.action === 'existing' ? { sure: CONFIDENCE_WORDS[proposal.confidence] } : {}) } }
        : {}),
      ...(files.length > 0 ? { acting: files.length } : {}),
      newAlbum: () => createAlbum(row, files),
      suggestions: () => setSuggesting({ name: row.name, files }),
      ...(row.staging.matchedAt !== undefined && !isLaneGroup(row) ? { suggested: row.staging.candidates ?? 0 } : {}),
      discard: () => askDiscard(row, files),
      rename: (title) => rename(row, title),
      openPage: () => navigate(albumRoute(row.path)),
      date: () => dateGroup(row, files),
      ...(isLaneGroup(row) ? {} : { remove: () => setDeleting(row) }),
    };
  }, [cursor, across, filing, proposalFor, apply, createAlbum, askDiscard, rename, navigate, dateGroup]);

  /** Bring the open group's part `id` up under its header. */
  const showPart = useCallback((id: string) => {
    if (cursor === null) return;
    const node = document.querySelector(`[data-group="${CSS.escape(cursor)}"] [data-part="${CSS.escape(id)}"]`);
    if (!node) return;
    scrollStream(node.getBoundingClientRect().top - readingLine - SECTION_METRICS.desktop.header - PART_MARGIN);
  }, [cursor, readingLine, scrollStream]);

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

  /** Decide on a selection across groups: what Enter, N, A and X do in the `groups` scope, and what a drop of it does. */
  const actOnParts = useCallback((what: SelectionParts<GroupRow>, action: TriageAction): boolean => {
    switch (action) {
      case 'apply':
        if (what.groups.length === 0) say('Accepting proposals takes groups selected whole.');
        else setAccepting(what.groups);
        return true;
      case 'new':
        setBulkNaming(what);
        return true;
      case 'add-to':
        setBulkPicking(what);
        return true;
      case 'discard':
        setBulkDiscarding(what);
        return true;
      default:
        return false;
    }
  }, [say]);
  const act = useCallback((action: TriageAction) => {
    const items = tiles.current.items;
    const files = filing;
    if (scope === 'groups' && actOnParts(chosen, action)) return;
    // What steps through the group's days or pictures needs them laid out: on a closed group it
    // expands it first.
    if (!cursorOpen && cursor !== null && (action.startsWith('tile-') || action.startsWith('part-') || action === 'open')) {
      setExpanded(cursor);
      return;
    }
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
        if (cursorRow) createAlbum(cursorRow, files);
        return;
      case 'add-to':
        if (cursorRow) setSuggesting({ name: cursorRow.name, files });
        return;
      case 'discard':
        if (cursorRow) askDiscard(cursorRow, files);
        return;
      case 'undo':
        undoLast();
        return;
      case 'rename':
        if (cursorRow) setRenaming(cursorRow.name);
        return;
      case 'expand':
        if (cursor !== null) toggleExpanded(cursor);
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
    cursorOpen,
    toggleExpanded,
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
    apply,
    createAlbum,
    askDiscard,
    undoLast,
    showPart,
    cut,
    moveInto,
    dateGroup,
    toCandidate,
  ]);

  useTriageKeys(!phone, scope, act, modalOpen);

  // Dragging: a selected picture carries the selection, which drops on group headers. What a drag carries is kept beside it, so the drop acts on that
  // selection as it was.
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
  /** What a drop carries, by what acts on it: the selection it was dragged from; nothing from elsewhere. */
  const partsOf = useCallback((payload: MediaDragPayload): SelectionParts<GroupRow> => dragged.current.get(payload) ?? { groups: [], partial: [], files: [] }, []);
  const dragPicture = useCallback((item: MediaItem) => picked?.isSelected(item.path) ? selectionPayload : undefined, [picked, selectionPayload]);

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
          done: (tally) => merging ? `${groupCount(tally.groups)} merged into “${row.title}”` : `${photos(tally.files)} moved into “${row.title}”`,
        });
      },
    };
  }, [phone, partsOf, cursor, openPaths, startRun]);

  /**
   * Merge N groups, from the selection bar: two or more groups selected whole merge into the first of them
   * in the stream, which keeps its name. None for a lane's group, or past one call's worth.
   */
  const selectionMerge = useMemo(() => {
    if (chosen.groups.length < 2 || chosen.partial.length > 0 || chosen.files.length > 0 || chosen.groups.some(isLaneGroup)) return undefined;
    const position = new Map(names.map((name, at) => [name, at]));
    const [into, ...rest] = chosen.groups.toSorted((a, b) => (position.get(a.name) ?? 0) - (position.get(b.name) ?? 0));
    const result = intoGroupChunks({ groups: rest, partial: [], files: [] }, into, () => undefined);
    if ('refused' in result) return undefined;
    const { chunk } = result;
    return {
      label: `Merge ${groupCount(chosen.groups.length)}`,
      run: () =>
        startRun({
          verb: 'Merging',
          label: `Merging ${groupCount(chunk.groups.length)} into “${into.title}”`,
          chunks: [chunk],
          total: { groups: chunk.decides, files: chunk.files },
          done: (tally) => `${groupCount(tally.groups)} merged into “${into.title}”`,
        }),
    };
  }, [chosen, names, startRun]);

  /** Create suggested albums, from the selection bar: each group selected whole a new album of its own, under its suggested name. */
  const createSuggested = useCallback(() => {
    const groups = chosen.groups;
    if (groups.length === 0) return;
    const titleOf = (row: GroupRow) => suggestedTitle(row, proposalFor(row));
    startRun({
      verb: 'Filing',
      label: `Making ${groupCount(groups.length)} into albums of their own`,
      chunks: ownAlbumChunks(groups, titleOf),
      total: { groups: groups.length, files: groups.reduce((sum, row) => sum + (row.memberCount ?? 0), 0) },
      done: (tally) => `${groupCount(tally.groups)} made into albums of their own`,
    });
  }, [chosen, proposalFor, startRun]);

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
    // Captured, so the stream's own pane scrolling is heard as the window's is.
    globalThis.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      globalThis.removeEventListener('scroll', onScroll, true);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [memberRail, cursor, readingLine]);
  const seekMember = useCallback((date: string) => {
    const at = seekIndex(memberDates, date, true);
    const box = at < 0 ? undefined : tiles.current.boxes[at];
    const grids = cursor === null ? null : document.querySelector(`[data-group="${CSS.escape(cursor)}"] [data-parts]`);
    if (!box || !grids) return;
    scrollStream(grids.getBoundingClientRect().top + box.top - readingLine - SECTION_METRICS.desktop.header - PART_MARGIN);
  }, [memberDates, cursor, readingLine, scrollStream]);
  const rail = memberRail || groupRail;

  // The lasso: what was selected as it started, where the stream and the open group's pictures
  // were then (read once, in the coordinates of what the stream scrolls in, as the band's are), and
  // what the last frame took, so a frame that takes nothing new selects nothing anew.
  const lassoBase = useRef<SectionSelection>(selection.selection);
  const lassoGeometry = useRef<StreamGeometry | null>(null);
  const lassoLast = useRef<LassoHits | null>(null);
  useLasso({
    enabled: !phone && view.length > 0,
    root: streamNode,
    topInset: readingLine,
    scroller,
    onStart: () => {
      lassoBase.current = selection.selection;
      lassoLast.current = null;
      const box = streamNode?.getBoundingClientRect();
      if (!box) {
        lassoGeometry.current = null;
        return;
      }
      const scrollX = scroller ? scroller.scrollLeft : globalThis.scrollX;
      const scrollY = scroller ? scroller.scrollTop : globalThis.scrollY;
      const metrics = SECTION_METRICS.desktop;
      const grids = cursor === null ? undefined : streamNode?.querySelector(`[data-group="${CSS.escape(cursor)}"] [data-parts]`)?.getBoundingClientRect();
      const { items, boxes } = tiles.current;
      lassoGeometry.current = {
        left: box.left + scrollX,
        right: box.right + scrollX,
        top: box.top + scrollY,
        inset: SECTION_INSET,
        header: metrics.header,
        foot: metrics.foot,
        open: cursor !== null && grids && items.length > 0 && boxes.length === items.length
          ? {
            key: cursor,
            left: grids.left + scrollX,
            top: grids.top + scrollY,
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

  const openKeys = useMemo(() => new Set(cursorOpen && cursor !== null ? [cursor] : []), [cursorOpen, cursor]);
  /** S can cut here: in a lane anything, elsewhere not before the group's first picture. */
  const canCut = cursorRow !== undefined && regrouping.length > 0 && (isLaneGroup(cursorRow) || regrouping[0] !== openItems[0]?.path);
  const backlog = queue.items.filter((item) => item.state !== 'failed');
  // How wide a closed group's grid is, for the stream's guess at each group's height until it is measured.
  const gridWidth = width - 2 * SECTION_INSET;
  const estimate = useCallback((row: GroupRow) => closedSectionEstimate(row.memberCount ?? 0, gridWidth, phone), [gridWidth, phone]);

  // The header's part, told to the page once for each change of what it says.
  const bar: SortBar | null = index.rows.length === 0 ? null : {
    lane,
    lanes: lanesInUse.map((each) => ({ id: each.id, label: each.label, groups: counts[each.id].groups })),
    summary: `${index.complete ? '' : '≥ '}${photos(view.reduce((sum, row) => sum + (row.memberCount ?? 0), 0))} to decide in ${groupCount(view.length)}`,
    applying: backlog.length,
  };
  const barKey = JSON.stringify(bar);
  const onBarRef = useRef(onBar);
  onBarRef.current = onBar;
  useEffect(() => onBarRef.current?.(JSON.parse(barKey)), [barKey]);

  // Over what stands in for the groups, the lead has the room the stream keeps over its first group.
  const leading = lead ? <Box pt='md'>{lead}</Box> : null;
  if (index.error) {
    return (
      <>
        {leading}
        <Alert color='red' m='md'>{index.error.message}</Alert>
      </>
    );
  }
  if (!index.complete && index.rows.length === 0) {
    return (
      <>
        {leading}
        <PageLoader label='Loading the suggested albums…' />
      </>
    );
  }
  if (index.rows.length === 0) {
    return (
      <>
        {leading}
        <EmptyState title='No groups yet' actions={<Button variant='light' onClick={onShowFiles}>Show the files</Button>}>
          {stillIndexing > 0
            ? `Groups appear as your files are prepared: ${stillIndexing.toLocaleString()} still to go.`
            : 'Groups appear here once uploaded files have been prepared and organized, within minutes of their arrival.'}
        </EmptyState>
      </>
    );
  }

  /** The groups, one section each; or, with none left in the lane, that it is all decided. */
  const streamBody = view.length === 0
    ? (
      <EmptyState title={`Everything in ${LANES.find((each) => each.id === lane)?.label ?? 'this lane'} is decided`}>
        {filed > 0 ? `${photos(filed)} filed today.` : 'Nothing is left to decide here.'}
      </EmptyState>
    )
    : (
      <Box ref={setStreamNode}>
        <SectionStream
          ref={streamRef}
          items={view}
          itemKey={(row) => row.name}
          openKeys={openKeys}
          closedHeight={closedSectionHeight(phone)}
          estimate={estimate}
          readingLine={readingLine}
          scroller={scroller}
          onReadingLine={setAtLine}
        >
          {(row, at, open) => (
            <GroupSection
              row={row}
              open={open}
              current={row.name === cursor}
              onExpand={() => toggleExpanded(row.name)}
              phone={phone}
              renaming={renaming === row.name}
              onRenamingChange={(on) => setRenaming(on ? row.name : null)}
              next={at < view.length - 1 ? view[at + 1].title : undefined}
              failure={failures.get(row.name)}
              onDismissFailure={() => setFailures((previous) => withoutKey(previous, row.name))}
              onActivate={() => moveTo(row.name, undefined, false)}
              actions={actionsFor(row)}
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
              arriveFrom={arrival?.name === row.name ? arrival.from : undefined}
              selected={selectedIn(row.name)}
              onSelect={phone ? undefined : selectGroup(row)}
              drop={headerDrop(row)}
              dragPayload={open && !phone ? dragPicture : undefined}
              scrollRoot={scroller ?? undefined}
              gridHeight={gridEstimate(row.memberCount ?? 0, gridWidth, phone)}
              renderOverlay={renderDuplicate}
            />
          )}
        </SectionStream>
      </Box>
    );

  return (
    <Box ref={widthRef} style={pane ? { flex: 1, minHeight: 0, display: 'flex' } : undefined}>
      {/* The stream's pane, which scrolls in a box of its own (on a phone, with the page); its rail runs down its right edge. */}
      <Box style={pane ? { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } : undefined}>
        {finding && <Text size='sm' c='dimmed' px='md' pb='xs'>Finding where you were…</Text>}

        {pane
          ? (
            <Box className='mrx-sort-stream' data-railed={rail || undefined} pos='relative' style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <ScrollBox frameStyle={{ flex: 1, minHeight: 0 }} viewportRef={setScroller}>
                {/* The room over the first group is inside the box, so the groups scroll up to the header's edge. */}
                <Box pt='md'>
                  {lead}
                  {streamReady && streamBody}
                </Box>
              </ScrollBox>
              {memberRail ? <TimelineScrubber facets={memberFacets} currentDate={memberAt} onSeek={seekMember} inline ascending /> : groupRail && (
                <TimelineScrubber
                  facets={facets}
                  currentDate={atLine === undefined ? undefined : byName.get(atLine)?.timeStart?.slice(0, 10)}
                  onSeek={seek}
                  inline
                  ascending={!newestFirst}
                />
              )}
            </Box>
          )
          : (
            <>
              {lead}
              {streamBody}
            </>
          )}
      </Box>
      {!phone && (
        <GroupSelectionBar
          words={selectionWords(chosenCount)}
          groups={chosen.groups.length}
          onCreateSuggested={createSuggested}
          merge={selectionMerge}
          pictures={!across && selected.length > 0 && cursorRow
            ? {
              count: selected.length,
              split: canCut ? { label: isLaneGroup(cursorRow) ? 'New group' : 'Split the group here', run: () => act('split') } : undefined,
              moveUp: previousRow ? { label: `Move to “${cardTitle(previousRow.title)}”`, run: () => act('move-up') } : undefined,
              moveDown: nextRow ? { label: `Move to “${cardTitle(nextRow.title)}”`, run: () => act('move-down') } : undefined,
              moveTo: () => act('move-to'),
            }
            : undefined}
          onClear={clearSelection}
        />
      )}

      {/* What was just done, and what is next, for a screen reader. */}
      <VisuallyHidden aria-live='polite'>{announce}</VisuallyHidden>

      <CompareDialog
        set={comparing}
        onClose={() => setComparing(null)}
        onResolve={(set, keep) => {
          setComparing(null);
          void setActions.resolve(set, keep);
        }}
      />

      <NameDialog
        group={naming && { title: naming.title, count: naming.files.length || naming.row.memberCount }}
        onClose={() => setNaming(null)}
        onConfirm={(title) => {
          const asked = naming;
          setNaming(null);
          if (asked) fileNew(asked.row, title, asked.files);
        }}
      />
      <AddToExistingDialog
        row={suggestingRow}
        what={suggesting && suggestingRow ? suggesting.files.length > 0 ? `${photos(suggesting.files.length)} of it` : photos(suggestingRow.memberCount ?? 0) : undefined}
        onClose={() => setSuggesting(null)}
        onMove={(album) => {
          const asked = suggesting;
          setSuggesting(null);
          if (asked && suggestingRow) fileInto(suggestingRow, album, asked.files);
        }}
        onReject={(candidate) => suggestingRow && rejectCandidate(suggestingRow, candidate)}
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
        onApplied={(written) => {
          const asked = dating;
          if (!asked) return;
          forgetMediaSet(asked.row.path);
          index.reread([asked.row.path]);
          leaveInside();
          say(`The time is set on ${photos(written)} of “${asked.row.title}”`, undefined, 'green');
          changed();
        }}
      />
      <NameDialog
        group={bulkNaming && { title: selectedGroups[0] ? cardTitle(selectedGroups[0].title) : '', count: partsCount(bulkNaming).files }}
        onClose={() => setBulkNaming(null)}
        onConfirm={(title) => {
          const asked = bulkNaming;
          setBulkNaming(null);
          if (asked) newAlbumParts(asked, title);
        }}
      />
      <AlbumPickerDialog
        opened={bulkPicking !== null}
        title='Add to an album'
        allowNew
        subtitle={bulkPicking ? selectionWords(partsCount(bulkPicking)) : undefined}
        onClose={() => setBulkPicking(null)}
        onPick={(choice: AlbumChoice) => {
          const asked = bulkPicking;
          setBulkPicking(null);
          if (!asked) return;
          if (choice.create) newAlbumParts(asked, choice.title);
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
