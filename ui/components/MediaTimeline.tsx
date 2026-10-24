import { Box, Checkbox, Divider, Stack, Text, UnstyledButton } from '@mantine/core';
import { MediaGrid, MediaSelectionBar, MoreLoader, PageLoader, type SelectionActionContext } from '@ein/ui/components';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { type TimelineGranularity, useMediaTimeline } from '../hooks/useMediaTimeline.ts';
import { holdElement, SearchOutcome, useAccessIds, useHeaderHeight, useIdentities, useMediaSelection } from '@ein/ui/hooks';
import { useSubjectFacets } from '../hooks/useSubjectFacets.ts';
import { canWrite, canWriteEach, SearchFilters, SearchKind, subjectArg, TO_TOP_EVENT } from '@ein/ui/lib';
import { type MediaItem, mediaRestored, offerLightboxList, openMediaAt } from '@ein/ui/signals';
import { TimelineScrubber } from './TimelineScrubber.tsx';
import { AddToAlbumAction } from '../media/components/AddToAlbumAction.tsx';
import { LabelAction } from '../media/components/LabelAction.tsx';
import { SetLocationAction } from '../media/components/SetLocationAction.tsx';
import { placeEvents } from '../lib/album-event-sections.ts';
import { buildScrubberModel, offsetAtPosition, scrollAnchorsForSections, scrollAnchorsWithBounds, type ScrubberSelection } from '../lib/timeline-scrubber.ts';
import { type AlbumEvent, useAlbumEvents } from '../media/hooks/useAlbumEvents.ts';
import { AlbumEventNote } from '../media/components/AlbumEventNote.tsx';
import { EventModal } from '../people/components/EventModal.tsx';
import { albumMediaRefreshRequest, mediaMoved } from '../media/signals/album.ts';

/**
 * Below this, the rail has no job: everything it could point at is within a
 * couple of screens of scrolling. Album event entries count too: they add real
 * dated sections, even though they are not media search results.
 */
const RAIL_MIN_ITEMS = 120;

/** How far below the fixed AppShell header the floating date sits. */
const FLOATING_DATE_GAP = 8;
/** The floating date's vertical padding: its text sits this far below its top. */
const FLOATING_DATE_PAD_Y = 4;

function renderMatchBadge(item: MediaItem): ReactNode {
  if (item.score === undefined) return null;

  return (
    <Text className='mrx-tile-badge' data-match-score={item.score} component='span' size='xs' fw={600} px={7} py={2}>
      {Math.round(item.score * 100)}%
    </Text>
  );
}

type MediaTimelineProps = {
  /** Person slug or path — the media they are tagged in. */
  person?: string;
  /** Location slug or path — the media linked to it. */
  location?: string;
  /** Album (or directory) path — the media it holds. */
  album?: string;
  /** Directory path — every file in the tree under it, however deep. */
  within?: string;
  /** Device path (`/devices/<name>`) — the media that camera produced. */
  device?: string;
  /** Restrict to these kinds, e.g. from the media-type filter. */
  kinds?: SearchKind[];
  /**
   * Everything else `search` takes — free text, labels, a region, a year window.
   * Merged with the named props above, which win.
   */
  filters?: SearchFilters;
  /** Keep search hits in best-match order and omit time-only navigation. */
  rankByRelevance?: boolean;
  /**
   * List everything when there is no filter at all — the media feed. Every
   * other caller has a subject; see `UseMediaTimelineOptions.browseAll`.
   */
  browseAll?: boolean;
  /** Oldest first. Defaults to newest first. */
  ascending?: boolean;
  /** Header width: months for a subject, days for an album. Defaults to months. */
  granularity?: TimelineGranularity;
  /**
   * Break the list into dated sections. On by default.
   *
   * A subject's or an album's media is *about* when it happened, so the headers
   * are the structure of the thing. A filtered search is not — "every photo with
   * a boat in it" chopped into 140 month headers is a worse grid, not a better
   * one — so a search turns them off and gets one continuous justified grid.
   */
  grouped?: boolean;
  /** Square tiles, this many across on a phone, rather than justified rows; see `MediaGrid`'s `square`. */
  square?: number;
  /** Lock the media that keeps its own sharing; see `MediaGrid`'s `markPinned`. */
  markPinned?: boolean;
  /** Drawn over each tile drawn; a search ranked by relevance draws its match score instead. */
  renderOverlay?: (item: MediaItem) => ReactNode;
  /**
   * Told while the list waits for its first pictures — a new question, or the first load — for a
   * progress indicator above. Not for a page further along, or one the rail seeks: the list keeps
   * what it shows meanwhile.
   */
  onLoadingChange?: (loading: boolean) => void;
  /** Told how each first page was answered — its timing and any provider warning — for a note above. */
  onOutcome?: (outcome: SearchOutcome) => void;
  /** What an empty list says: a sentence, drawn dimmed, or a whole `EmptyState`. */
  emptyMessage?: ReactNode;
  /**
   * Changing this re-runs the search behind the list, keeping the reader where
   * they are. For a page that has just changed what the album holds — an upload
   * — and cannot know when the index caught up.
   */
  reloadToken?: number;
  /**
   * Extra controls for the selection bar. A render prop because the selection is owned here,
   * not by the page — the page supplies the action, this hands back what it needs to act on.
   */
  selectionActions?: (ctx: SelectionActionContext) => ReactNode;
  /**
   * The element the list scrolls in, when that is not the page — a dialog's own
   * column. Everything that measured against the window and the app header
   * measures against its top edge instead, and the rail stands inline, so the
   * caller has to give that column a positioned parent that does not scroll:
   * the rail is absolute, and it must stay put while the column moves.
   */
  scrollRoot?: HTMLElement;
};

/**
 * A subject's, an album's or a directory tree's media, newest first, grouped by date, with the
 * timeline's adaptive time rail once there is enough to be worth a drag. Its
 * complete compact layout is loaded up front unless the source exceeds the
 * safety ceiling, in which case cursor paging takes over.
 *
 * Each bucket is its own justified grid, so a sparse one ends ragged instead of
 * stretching a handful of pictures across the page. The selection is owned here
 * rather than per grid, so a shift-range can run across a bucket boundary, and
 * clicking a tile opens the app-wide lightbox over the whole loaded list — which
 * is what `startIndex` maps a tile back to.
 *
 * With the complete layout, the rail scrolls directly to an existing date
 * header. A paged source re-anchors when the target is not in the document yet.
 */
export function MediaTimeline(
  {
    person,
    location,
    album,
    within,
    device,
    kinds,
    filters,
    rankByRelevance = false,
    browseAll = false,
    ascending,
    granularity,
    grouped = true,
    square,
    markPinned,
    renderOverlay,
    emptyMessage,
    reloadToken,
    onLoadingChange,
    onOutcome,
    selectionActions,
    scrollRoot,
  }: MediaTimelineProps,
) {
  useSignals();
  // Where the list starts, and what the reader is looking at. Kept apart:
  // scrolling must not re-anchor, or every scroll would refetch.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [topMonth, setTopMonth] = useState<string | undefined>(undefined);
  const [floatingDate, setFloatingDate] = useState<string | undefined>(undefined);
  const headerHeight = useHeaderHeight();
  const root = scrollRoot ?? null;

  // What the list is *of*. Changing it starts a new list, so the seek has to let
  // go — an anchor into the old one means nothing in the new one.
  const subject = person ?? location ?? album ?? within ?? device;
  const filterKey = JSON.stringify(filters ?? {});
  useEffect(() => {
    setAnchor(null);
    setTopMonth(undefined);
  }, [subject, filterKey]);

  const { groups, items, loading, error, hasMore, sentinelRef, openAt, removeItems, reload, hasNewer, anchorIndex, answeredAnchor, topSentinelRef, outcome } =
    useMediaTimeline({
      person,
      location,
      under: album,
      within,
      device,
      kinds,
      filters,
      rankByRelevance,
      browseAll,
      ascending,
      // Ungrouped is still bucketed — just into one bucket per segment rather than
      // per month. A page prepended above the list has to start its own grid, or
      // the justified rows below it all re-pack when it arrives.
      granularity: grouped ? granularity : 'none',
      anchor,
      scrollRoot: root,
    });
  const pendingStackRefresh = useRef<{ id: number; focusPath: string; sawLoading: boolean } | null>(null);
  // Removed media came back (a delete's Undo): reload, for a restore made while this list is up.
  const restored = mediaRestored.value;
  const handledRestore = useRef(restored?.at);
  useEffect(() => {
    if (!restored || restored.at === handledRestore.current) return;
    handledRestore.current = restored.at;
    reload();
  }, [restored, reload]);
  // Media moved away from where this list found them (a staged file put in an album): drop them.
  const moved = mediaMoved.value;
  const handledMove = useRef(moved?.at);
  useEffect(() => {
    if (!moved || moved.at === handledMove.current) return;
    handledMove.current = moved.at;
    removeItems(moved.paths);
  }, [moved, removeItems]);

  const stackRefresh = albumMediaRefreshRequest.value;
  useEffect(() => {
    if (!album || !stackRefresh || stackRefresh.albumPath !== album || pendingStackRefresh.current?.id === stackRefresh.id) return;
    pendingStackRefresh.current = { id: stackRefresh.id, focusPath: stackRefresh.focusPath, sawLoading: false };
    reload();
  }, [album, reload, stackRefresh]);
  useEffect(() => {
    const pending = pendingStackRefresh.current;
    if (!pending) return;
    if (loading) {
      pending.sawLoading = true;
      return;
    }
    if (!pending.sawLoading || items.length === 0) return;
    const index = items.findIndex((item) => item.path === pending.focusPath);
    if (index < 0) return;
    openMediaAt(index, items);
    pendingStackRefresh.current = null;
  }, [items, loading]);
  const { events: albumEvents, reload: reloadEvents } = useAlbumEvents(album);
  // An event without a named writer is signed by the account that added it: its own name, or the account name for one without.
  const { users } = useIdentities();
  const authors = useMemo(() => new Map(users.map((user) => [user.uid, user.title || user.username])), [users]);
  const [editedEvent, setEditedEvent] = useState<AlbumEvent | undefined>(undefined);
  const [editingEvent, setEditingEvent] = useState(false);

  // Ungrouped there are no dates to put the events under.
  const sectionList = useMemo(
    () => placeEvents(groups, grouped ? albumEvents : [], { granularity: granularity ?? 'month', ascending, hasNewer, hasMore }),
    [groups, grouped, albumEvents, granularity, ascending, hasNewer, hasMore],
  );

  // A lightbox opened by its URL (a reload, a link) walks this list from its file, as if opened
  // from the grid, whichever of the two arrives first.
  useEffect(() => {
    offerLightboxList(items);
    return () => offerLightboxList([]);
  }, [items]);

  // A new token means the album changed under the list. Not on mount: the list
  // has just loaded itself.
  const lastToken = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === lastToken.current) return;
    lastToken.current = reloadToken;
    reload();
  }, [reloadToken, reload]);

  // The rail describes the list beside it, so it runs the same way — an album
  // sorted oldest-first gets a rail with its earliest year at the top.
  const { facets } = useSubjectFacets(
    {
      ...filters,
      subjects: person ? [subjectArg('person', person)] : location ? [subjectArg('location', location)] : device ? [subjectArg('device', device)] : filters?.subjects,
      under: album ?? filters?.under,
      within: within ?? filters?.within,
      kinds: kinds?.length ? kinds : filters?.kinds,
    },
    !rankByRelevance && (browseAll || Boolean(subject) || Boolean(filters)),
  );
  // Every source can be seeked by date (`search --at`), so the rail is shown
  // wherever there is enough to be worth dragging.
  const railModel = useMemo(
    () => buildScrubberModel(facets ?? { years: [], months: [], days: [] }, ascending),
    [facets, ascending],
  );
  const timelineEntryCount = (facets?.total ?? 0) + albumEvents.length;
  const showRail = !rankByRelevance && timelineEntryCount > RAIL_MIN_ITEMS && railModel.targets.length >= 2;

  const selection = useMediaSelection(items);
  // Placing and labelling write to each picture, so they are offered only when the reader may
  // change every one selected.
  const access = useAccessIds();
  const changeable = canWriteEach(items.filter((item) => selection.selected.has(item.path)), access);

  // Reported upward rather than rendered here: the page wants it in its search
  // box, where someone is looking after pressing Enter. A new question empties
  // the list first; paging and seeking keep it.
  const asking = loading && items.length === 0;
  useEffect(() => onLoadingChange?.(asking), [asking, onLoadingChange]);
  useEffect(() => {
    if (outcome) onOutcome?.(outcome);
  }, [outcome, onOutcome]);

  const headersRef = useRef(new Map<string, HTMLElement>());
  /** The list root, so the rail can start under the page's own header. */
  const [listNode, setListNode] = useState<HTMLDivElement | null>(null);
  // Media sections by where they start in the list (a seek lands on one by that), event-only ones by `events:<date>`.
  const sectionsRef = useRef(new Map<string, HTMLElement>());

  const scrub = useCallback((selection: ScrubberSelection): boolean => {
    if (!grouped) return false;
    const edge = root ? root.getBoundingClientRect().top : headerHeight;
    const scrolled = root ? root.scrollTop : globalThis.scrollY;
    const sections = [...headersRef.current.entries()].flatMap(([key, header]) => {
      const section = header.parentElement;
      if (!section) return [];
      const rect = section.getBoundingClientRect();
      return [{ key, offset: scrolled + rect.top - edge, size: rect.height }];
    });
    // Albums, people and devices can put arbitrary content before their first
    // media section (an album title, description, folder grid, and so on). The
    // rail's top half-bucket, from the page top down to the first divider, is
    // what scrolls through it; the dates themselves stay exact.
    const scrollingElement = root ?? document.scrollingElement ?? document.documentElement;
    const anchors = scrollAnchorsWithBounds(
      scrollAnchorsForSections(railModel, sections),
      railModel.targets.length,
      0,
      Math.max(0, scrollingElement.scrollHeight - scrollingElement.clientHeight),
    );
    const top = offsetAtPosition(anchors, selection.position);
    if (top === undefined) return false;

    // Direct manipulation needs one immediate correction per pointer event;
    // CSS smooth scrolling would trail behind the finger and queue animations.
    if (root) root.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    else globalThis.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    return true;
  }, [grouped, railModel, root, headerHeight]);

  const seek = useCallback((date: string) => {
    setTopMonth(date);

    // A complete layout already has the requested month represented. Find its
    // first header in visual order; no query or spinner is needed merely to
    // move through known geometry. A paged source (or an over-limit fallback)
    // will miss here and use the anchored query below.
    const target = [...headersRef.current.entries()].find(([key]) => key.startsWith(date) || date.startsWith(key))?.[1];
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      return;
    }

    // The list stays put until the sought page is in; the landing above moves it.
    seekSerialRef.current++;
    setAnchor(date);
  }, []);

  // Landing after a seek — and only once the answer to *this* seek is what is
  // on screen. The previous list stays where it was until then, rather than
  // showing its top as though it were the new location. The answer carries a page
  // above the sought row, so
  // put the sought section at the top, then keep it there while the lead's
  // grids take their real height. The hold outlives this effect's re-runs on
  // purpose — a page appended below must not cut it short while the lead is
  // still settling. Each seek lands once, even one that resolves to the same
  // row as the last: the reader may have scrolled away since.
  const seekSerialRef = useRef(0);
  const landedRef = useRef<string | null>(null);
  const landingHoldRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (anchor === null || answeredAnchor !== anchor || items.length === 0) return;
    const landing = `${seekSerialRef.current}|${anchor}`;
    if (landedRef.current === landing) return;
    const section = sectionsRef.current.get(String(anchorIndex));
    if (!section) return;
    landedRef.current = landing;
    // The divider, not the section: it is what carries the scroll margin that
    // keeps a date header out from under the fixed app header.
    (section.querySelector('[data-date-divider]') ?? section).scrollIntoView({ block: 'start', behavior: 'instant' });
    landingHoldRef.current?.();
    landingHoldRef.current = holdElement(section, root);
  }, [anchor, answeredAnchor, anchorIndex, items, root]);
  useEffect(() => () => landingHoldRef.current?.(), []);

  // Back to the top: a seeked list lets go of its date and loads from the start,
  // or the top would be the seeked page's first picture.
  useEffect(() => {
    const toTop = () => {
      landingHoldRef.current?.();
      landingHoldRef.current = null;
      setAnchor(null);
      setTopMonth(undefined);
    };
    globalThis.addEventListener(TO_TOP_EVENT, toTop);
    return () => globalThis.removeEventListener(TO_TOP_EVENT, toTop);
  }, []);

  // Which bucket the reader is looking at, for the rail's marker. The bottom
  // margin keeps the answer from flipping to a header that has only just
  // entered from below.
  useEffect(() => {
    if (!showRail) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const key = visible?.target.getAttribute('data-month');
      if (key) setTopMonth(key);
    }, { root, rootMargin: `-${root ? 0 : headerHeight}px 0px -85% 0px` });

    for (const node of headersRef.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [groups, showRail, root, headerHeight]);

  // Keep one compact date over the pictures once its ordinary divider has scrolled
  // up to where that date floats. The switch happens when the divider's text
  // reaches the floating text's line, and the divider's own text hides meanwhile,
  // so the heading reads as one label that sticks rather than one that leaves and
  // another that turns up later. A capture listener also covers timelines inside
  // a scrolling panel.
  useEffect(() => {
    if (!grouped) {
      setFloatingDate(undefined);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      let next: string | undefined;
      const edge = root ? root.getBoundingClientRect().top : headerHeight;
      const line = edge + FLOATING_DATE_GAP + FLOATING_DATE_PAD_Y;

      // The sections reaching up to the floating line, top first: the section
      // still under the header, then possibly the next one whose divider is
      // arriving. The arriving one takes over once its text is on the line.
      const reaching = [...sectionsRef.current.values()]
        .map((section) => ({ section, rect: section.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > edge && rect.top <= line)
        .sort((a, b) => a.rect.top - b.rect.top);
      for (const { section } of reaching) {
        const label = section.querySelector<HTMLElement>('[data-date-divider] .mrx-date-divider-label');
        if (!label || label.getBoundingClientRect().top <= line) next = section.dataset.dateLabel;
      }

      setFloatingDate((previous) => previous === next ? previous : next);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    schedule();
    globalThis.addEventListener('scroll', schedule, { capture: true, passive: true });
    globalThis.addEventListener('resize', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      globalThis.removeEventListener('scroll', schedule, true);
      globalThis.removeEventListener('resize', schedule);
    };
  }, [groups, grouped, root, headerHeight]);

  if (error) {
    return (
      <Text c='red' size='sm'>
        {error.message}
      </Text>
    );
  }

  if (loading && items.length === 0) {
    return <PageLoader label='Loading media…' />;
  }

  if (!loading && sectionList.length === 0 && anchor === null) {
    if (emptyMessage !== undefined && typeof emptyMessage !== 'string') return <>{emptyMessage}</>;
    return (
      <Text c='dimmed' size='sm'>
        {emptyMessage ?? 'No media yet.'}
      </Text>
    );
  }

  // An album's texts, each signed by its writer and with a pen for whoever may change its file.
  const notes = (events: AlbumEvent[] | undefined) =>
    events?.map((event) => (
      <AlbumEventNote
        key={event.path}
        text={event.text}
        author={event.writer?.name ?? authors.get(event.creator)}
        onEdit={canWrite(event.ownership, access)
          ? () => {
            setEditedEvent(event);
            setEditingEvent(true);
          }
          : undefined}
      />
    ));

  return (
    <>
      <Box ref={setListNode}>
        <Box
          h={0}
          aria-hidden
          className='mrx-floating-date'
          style={{ position: 'sticky', top: root ? FLOATING_DATE_GAP : headerHeight + FLOATING_DATE_GAP, zIndex: 30, pointerEvents: 'none' }}
        >
          {floatingDate && (
            <Text
              data-floating-date
              component='span'
              size='sm'
              fw={600}
              px='sm'
              py={FLOATING_DATE_PAD_Y}
              style={{
                display: 'inline-block',
                borderRadius: 'var(--mantine-radius-xl)',
                background: 'color-mix(in srgb, var(--mrx-surface-raised) 90%, transparent)',
                boxShadow: 'var(--mantine-shadow-sm)',
                backdropFilter: 'blur(8px)',
              }}
            >
              {floatingDate}
            </Text>
          )}
        </Box>
        {
          /* `overflow-anchor: none`: the browser does its own scroll anchoring when
          content appears above the viewport, and this list already does that
          itself — precisely, and for the frames afterwards where a justified grid
          is still settling. With both, a prepended page would move the reader by
          twice its height. */
        }
        <Stack
          gap='lg'
          style={{ overflowAnchor: 'none' }}
        >
          {
            /* Above the first bucket: crossing it loads the page before this one
            and holds the reader's location, so climbing back towards the newest
            works the same way as scrolling into the past. A seeked list starts
            with it on screen, so the page above arrives at once and there is
            never a gap to announce — no "back to the newest" button. */
          }
          {hasNewer && <Box ref={topSentinelRef} h={1} />}

          {sectionList.map((section) => {
            if (section.kind === 'events') {
              const ref = `events:${section.key}`;
              return (
                <Box
                  key={ref}
                  data-date-label={section.label}
                  data-hold-anchor={ref}
                  ref={(node: HTMLDivElement | null) => {
                    if (node) sectionsRef.current.set(ref, node);
                    else sectionsRef.current.delete(ref);
                  }}
                >
                  <Box
                    data-date-divider
                    className='mrx-date-divider'
                    py='sm'
                    data-month={section.key}
                    ref={(node: HTMLDivElement | null) => {
                      if (node) headersRef.current.set(section.key, node);
                      else headersRef.current.delete(section.key);
                    }}
                  >
                    {/* No pictures to take, so the date is only a heading. */}
                    <Box className='mrx-date-divider-label'>
                      <Text
                        className='mrx-date-divider-text'
                        fw={600}
                        size='sm'
                        component='span'
                        style={{ visibility: floatingDate === section.label ? 'hidden' : undefined }}
                      >
                        {section.label}
                      </Text>
                    </Box>
                  </Box>
                  {notes(section.events)}
                </Box>
              );
            }

            const { group, events } = section;
            const groupPaths = group.items.map((item) => item.path);
            const selectedInGroup = groupPaths.filter((path) => selection.selected.has(path)).length;
            const allSelected = selectedInGroup === groupPaths.length && groupPaths.length > 0;

            return (
              <Box
                key={`${group.key || 'undated'}-${group.startIndex}`}
                data-date-label={group.label}
                // Named by its first picture, which a prepend above cannot change — an index would.
                data-hold-anchor={group.items[0]?.path ?? group.key}
                ref={(node: HTMLDivElement | null) => {
                  if (node) sectionsRef.current.set(String(group.startIndex), node);
                  else sectionsRef.current.delete(String(group.startIndex));
                }}
              >
                {
                  /* Ungrouped there is nothing to head — every bucket is the same
                  "all", and a label saying so on each segment is noise. A bucket
                  split at a seam is the same date continuing, so it says so with
                  a rule rather than repeating the header. */
                }
                {!grouped ? null : group.continued ? <Divider mb='xs' /> : (
                  <Box
                    data-date-divider
                    className='mrx-date-divider'
                    py='sm'
                    data-month={group.key}
                    ref={(node: HTMLDivElement | null) => {
                      if (node) headersRef.current.set(group.key, node);
                      else headersRef.current.delete(group.key);
                    }}
                  >
                    {
                      /* Pressing the date takes the whole bucket — a day of an album is
                      the unit people actually act on (download it, delete it). The
                      checkbox only appears once the whole day is in. On a phone it and the
                      count hang off the date's box (see `.mrx-date-divider-check`), so
                      neither the checkbox's coming and going nor the count growing into
                      "37 / 37" shifts the centred date. */
                    }
                    <Box className='mrx-date-divider-label'>
                      {allSelected && (
                        <Checkbox
                          className='mrx-date-divider-check'
                          size='xs'
                          checked
                          onChange={() => selection.setKeys(groupPaths, false)}
                          aria-label={`Deselect everything from ${group.label}`}
                        />
                      )}
                      <UnstyledButton
                        // Covered by the floating copy of itself: hidden, so the two do
                        // not show through each other.
                        style={{ visibility: floatingDate === group.label ? 'hidden' : undefined }}
                        onClick={() => selection.setKeys(groupPaths, !allSelected)}
                        aria-pressed={allSelected}
                        aria-label={`${allSelected ? 'Deselect' : 'Select'} everything from ${group.label}`}
                      >
                        <Text className='mrx-date-divider-text' fw={600} size='sm' component='span'>
                          {group.label}
                        </Text>
                      </UnstyledButton>
                      <Text className='mrx-date-divider-count' size='xs' c='dimmed'>
                        {selectedInGroup > 0 ? `${selectedInGroup} / ${group.items.length}` : group.items.length}
                      </Text>
                    </Box>
                  </Box>
                )}

                {notes(events)}

                <MediaGrid
                  items={group.items}
                  indexOffset={group.startIndex}
                  lightboxItems={items}
                  onOpen={(index) => openAt(index)}
                  selection={selection}
                  renderOverlay={rankByRelevance ? renderMatchBadge : renderOverlay}
                  markPinned={markPinned}
                  bleed
                  square={square}
                />
              </Box>
            );
          })}

          {/* Sits below the last row: coming within reach of it pages. */}
          {hasMore && <Box ref={sentinelRef} h={1} />}

          {loading && <MoreLoader />}

          {!loading && items.length === 0 && anchor !== null && <Text c='dimmed' size='sm'>Nothing here in this range.</Text>}
        </Stack>
      </Box>

      {showRail && <TimelineScrubber facets={facets} currentDate={topMonth} onSeek={seek} onScrub={scrub} inline={root !== null} below={listNode} ascending={ascending} />}

      <MediaSelectionBar
        selection={selection}
        items={items}
        onRemoved={removeItems}
        actions={
          <>
            <AddToAlbumAction paths={selection.paths} onDone={selection.clear} />
            {selectionActions?.({ selection, items, reload })}
            {changeable && <SetLocationAction paths={selection.paths} onDone={selection.clear} />}
            {changeable && <LabelAction paths={selection.paths} onDone={selection.clear} />}
          </>
        }
      />

      {editedEvent && (
        <EventModal
          event={editedEvent}
          genericOnly
          opened={editingEvent}
          onClose={() => setEditingEvent(false)}
          onApplied={reloadEvents}
        />
      )}
    </>
  );
}
