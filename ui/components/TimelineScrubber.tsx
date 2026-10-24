import { Box, Paper, Text } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useHeaderHeight } from '@ein/ui/hooks';
import {
  buildScrubberModel,
  createSeekScheduler,
  majorLabel,
  type ScrubberFacets,
  type ScrubberSelection,
  type ScrubberTarget,
  selectionAtY,
  targetLabel,
  yAtDate,
  yAtPosition,
} from '../lib/timeline-scrubber.ts';

export type { ScrubberFacets } from '../lib/timeline-scrubber.ts';

/** Labels closer than this are thinned; their occupied-date ticks remain. */
const LABEL_MIN_GAP = 30;
/** Pointer seeks are live, but bounded so a drag cannot flood the command bus. */
const SEEK_INTERVAL = 125;
const LABEL_HEIGHT = 30;
/** Pointer travel below this is a press, not a drag, and moves nothing. */
const DRAG_SLOP = 3;

type TimelineScrubberProps = {
  facets: (ScrubberFacets & { total?: number }) | null;
  /** Truncated ISO date of the entry currently at the top of the viewport. */
  currentDate?: string;
  onSeek: (date: string) => void;
  /** Scroll already-loaded geometry for this fractional position. */
  onScrub?: (selection: ScrubberSelection) => boolean;
  /** Overlay a scrolling modal body instead of pinning to the viewport. */
  inline?: boolean;
  /**
   * The list the rail belongs to. A pinned rail starts where this element
   * does while it is on screen, so the handle sits under the page's own
   * title and filters instead of on top of them; once they scroll away the
   * rail takes the full height below the app header.
   */
  below?: HTMLElement | null;
  /** The list beside it runs oldest-first, so the rail does too. */
  ascending?: boolean;
};

type MajorMark = { key: string; y: number };

/**
 * Google-Photos-style occupied-time scrubber.
 *
 * A long archive gives equal reach to each occupied month and labels its years;
 * a span under one year gives equal reach to each occupied day and labels its
 * months. The list is paged, so a drag seeks the source rather than pretending
 * unloaded rows have a scroll offset. Pointer capture keeps mouse, pen and touch
 * on one path. Pointer travel is continuous between the occupied landmarks;
 * keyboard users retain the same visual-order steps.
 */
export function TimelineScrubber({ facets, currentDate, onSeek, onScrub, inline = false, below, ascending = false }: TimelineScrubberProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const onSeekRef = useRef(onSeek);
  const onScrubRef = useRef(onScrub);
  const schedulerRef = useRef<ReturnType<typeof createSeekScheduler> | null>(null);

  const [height, setHeight] = useState(0);
  const [handleHeight, setHandleHeight] = useState(0);
  // The fixed AppShell header a viewport-pinned rail hangs from.
  const headerHeight = useHeaderHeight();
  const [top, setTop] = useState(headerHeight);
  const [atStart, setAtStart] = useState(false);
  const pressRef = useRef<{ y: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragSelection, setDragSelection] = useState<ScrubberSelection | undefined>(undefined);
  const [focused, setFocused] = useState(false);

  onSeekRef.current = onSeek;
  onScrubRef.current = onScrub;

  if (schedulerRef.current === null) {
    schedulerRef.current = createSeekScheduler((date) => onSeekRef.current(date), SEEK_INTERVAL);
  }

  useEffect(() => () => schedulerRef.current?.cancel(), []);

  // A released pointer may sit between occupied date landmarks. Keep that
  // fractional position visible instead of snapping the handle back to the
  // discrete date reported by the section observer. The next independent
  // scroll hands marker ownership back to the surrounding view.
  useEffect(() => {
    if (dragging || !dragSelection) return;
    const clearReleasedPosition = () => setDragSelection(undefined);
    globalThis.addEventListener('scroll', clearReleasedPosition, { capture: true, passive: true });
    return () => globalThis.removeEventListener('scroll', clearReleasedPosition, true);
  }, [dragging, dragSelection]);

  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    const measure = () => {
      setHeight(node.getBoundingClientRect().height);
      setHandleHeight(Number.parseFloat(getComputedStyle(node).getPropertyValue('--mrx-scrubber-handle-height')) || 0);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  // Follow the list's top edge down to the app header. Scroll is captured
  // because the list may sit inside a scrolling panel; the rail's own
  // ResizeObserver above picks up the height change that comes with it.
  // While the list's top is still on screen the reader is at the start, and
  // the handle rests at the top of the rail — where a drag upward ends —
  // rather than at the first date's centre a little further down.
  //
  // Not while dragging: the drag maps the pointer through the rail's own
  // rectangle, so moving the rail under the finger would move the position
  // it reads, which scrolls, which moves the rail again — one runaway jump
  // to the bottom. The rail stays where the press found it until release.
  useLayoutEffect(() => {
    if (inline || !below) {
      setTop(headerHeight);
      setAtStart(false);
      return;
    }
    if (dragging) return;
    const location = () => {
      const listTop = Math.round(below.getBoundingClientRect().top);
      setTop(Math.max(headerHeight, listTop));
      setAtStart(listTop >= headerHeight);
    };
    location();
    globalThis.addEventListener('scroll', location, { capture: true, passive: true });
    globalThis.addEventListener('resize', location);
    const observer = new ResizeObserver(location);
    observer.observe(below);
    return () => {
      globalThis.removeEventListener('scroll', location, true);
      globalThis.removeEventListener('resize', location);
      observer.disconnect();
    };
  }, [inline, below, dragging, headerHeight]);

  // The pinned rail stands in for the page's scrollbar, which hides while `.mrx-railed` is
  // on <html>; an inline list hides its own with a utility class, and the page keeps its bar.
  useLayoutEffect(() => {
    if (inline) return;
    document.documentElement.classList.add('mrx-railed');
    return () => document.documentElement.classList.remove('mrx-railed');
  }, [inline]);

  const model = useMemo(
    () => buildScrubberModel(facets ?? { years: [], months: [], days: [] }, ascending),
    [facets, ascending],
  );
  const ready = Boolean(facets) && model.targets.length >= 2;
  const shown = dragSelection?.date ?? currentDate ?? model.targets[0]?.key;
  const handleHalf = handleHeight / 2;
  const trackHeight = Math.max(0, height - handleHeight);
  const markerOnTrack = ready
    ? dragSelection ? yAtPosition(model, dragSelection.position, trackHeight) : atStart ? 0 : shown ? yAtDate(model, shown, trackHeight) : undefined
    : undefined;
  const markerY = markerOnTrack === undefined ? undefined : handleHalf + markerOnTrack;

  const yOf = useCallback(
    (index: number): number => handleHalf + (yAtPosition(model, index, trackHeight) ?? 0),
    [model, handleHalf, trackHeight],
  );

  const majorMarks = useMemo((): MajorMark[] => {
    const candidates: MajorMark[] = [];
    let previous: string | undefined;
    model.targets.forEach((target, index) => {
      if (target.majorKey === previous) return;
      candidates.push({ key: target.majorKey, y: yOf(index) });
      previous = target.majorKey;
    });
    if (candidates.length <= 2) return candidates;

    const markerIndex = markerY === undefined || trackHeight <= 0
      ? -1
      : Math.max(0, Math.min(model.targets.length - 1, Math.floor(((markerY - handleHalf) / trackHeight) * model.targets.length)));
    const activeMajor = model.targets[markerIndex]?.majorKey;
    const mandatory = new Set([candidates[0].key, candidates[candidates.length - 1].key, activeMajor]);
    const kept: MajorMark[] = candidates.filter((candidate) => mandatory.has(candidate.key));
    for (const candidate of candidates) {
      if (mandatory.has(candidate.key)) continue;
      if (kept.every((mark) => Math.abs(mark.y - candidate.y) >= LABEL_MIN_GAP)) kept.push(candidate);
    }
    return kept.sort((a, b) => a.y - b.y);
  }, [model.targets, markerY, height, handleHalf, trackHeight, yOf]);

  const selectionAtEvent = useCallback((clientY: number): ScrubberSelection | undefined => {
    const rect = railRef.current?.getBoundingClientRect();
    return rect ? selectionAtY(model, clientY - rect.top - handleHalf, trackHeight) : undefined;
  }, [model, handleHalf, trackHeight]);

  const applySelection = useCallback((selection: ScrubberSelection | undefined, final = false) => {
    if (!selection) return;
    if (onScrubRef.current?.(selection)) {
      schedulerRef.current?.cancel();
      return;
    }
    if (final) schedulerRef.current?.flush(selection.date);
    else schedulerRef.current?.push(selection.date);
  }, []);

  // A press moves nothing. The resting handle marks a date's centre, which is
  // rarely the exact scroll position, so seeking on pointer-down would make a
  // plain tap jump the page. The drag begins once the pointer has travelled.
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    railRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pressRef.current = { y: event.clientY, moved: false };
    setDragging(true);
  }, [ready]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!dragging || !press) return;
    if (!press.moved && Math.abs(event.clientY - press.y) < DRAG_SLOP) return;
    press.moved = true;
    const selection = selectionAtEvent(event.clientY);
    setDragSelection(selection);
    applySelection(selection);
  }, [dragging, selectionAtEvent, applySelection]);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const press = pressRef.current;
    pressRef.current = null;
    setDragging(false);
    if (!press?.moved) return;
    const selection = selectionAtEvent(event.clientY) ?? dragSelection;
    applySelection(selection, true);
  }, [dragging, dragSelection, selectionAtEvent, applySelection]);

  const seekTarget = useCallback((target: ScrubberTarget | undefined, index: number) => {
    if (!target) return;
    setDragSelection(undefined);
    applySelection({ date: target.key, position: index }, true);
  }, [applySelection]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!ready) return;
    const y = shown ? yAtDate(model, shown, height) : undefined;
    let index = y === undefined || height <= 0 ? 0 : Math.max(0, Math.min(model.targets.length - 1, Math.round((y / height) * model.targets.length)));
    if (event.key === 'ArrowUp') index--;
    else if (event.key === 'ArrowDown') index++;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = model.targets.length - 1;
    else return;
    event.preventDefault();
    index = Math.max(0, Math.min(model.targets.length - 1, index));
    seekTarget(model.targets[index], index);
  }, [ready, shown, model, height, seekTarget]);

  const activeIndex = Math.max(
    0,
    Math.min(
      model.targets.length - 1,
      dragSelection?.position ??
        (markerY === undefined || trackHeight <= 0 ? 0 : ((markerY - handleHalf) / trackHeight) * model.targets.length),
    ),
  );
  const tooltipTop = markerY === undefined ? 0 : Math.max(0, Math.min(height - LABEL_HEIGHT, markerY - LABEL_HEIGHT / 2));

  return (
    <Box
      className='mrx-scrubber'
      ref={railRef}
      role='slider'
      aria-label='Scroll through time'
      aria-orientation='vertical'
      aria-valuemin={0}
      aria-valuemax={Math.max(0, model.targets.length - 1)}
      aria-valuenow={activeIndex}
      aria-valuetext={shown ? targetLabel(model.mode, shown) : undefined}
      tabIndex={ready ? 0 : -1}
      style={{
        // Pinned, at the page's right edge: beside the side drawer when it is open.
        ...(inline
          ? { position: 'absolute', top: 0, right: 0, bottom: 0 }
          : { position: 'fixed', top, right: 'var(--app-shell-aside-offset, 0px)', bottom: 'var(--mrx-scrubber-bottom)' }),
        width: 'var(--mrx-scrubber-rail-width)',
        zIndex: 100,
        touchAction: 'none',
        userSelect: 'none',
        // Only the visible handle is interactive. The rest of this full-height
        // overlay must leave media at the right edge clickable.
        pointerEvents: 'none',
        outline: 'none',
      }}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div style={{ position: 'relative', height: '100%', width: '100%' }}>
        {model.targets.map((target, index) => {
          const major = index === 0 || model.targets[index - 1].majorKey !== target.majorKey;
          // Every occupied bucket remains a seek target, but drawing its tick
          // would make dense archives look striped. The major year/month marks are
          // enough to orient the reader; all occupied months/days still define
          // the continuous rail geometry.
          if (!major) return null;
          return (
            <div
              key={target.key}
              className='mrx-scrubber-mark'
              style={{
                position: 'absolute',
                top: yOf(index),
                right: 5,
                width: 15,
                height: 1,
                background: 'var(--mantine-color-dark-1)',
                opacity: dragging ? 0.9 : 0,
                transform: dragging ? 'translateX(0)' : 'translateX(6px)',
                transition: 'opacity 140ms ease, transform 140ms ease',
                pointerEvents: 'none',
              }}
            />
          );
        })}

        {majorMarks.map((mark) => (
          <Paper
            key={`label-${mark.key}`}
            className='mrx-scrubber-label'
            shadow='sm'
            radius='xl'
            px='sm'
            py={5}
            style={{
              position: 'absolute',
              top: Math.max(0, Math.min(height - LABEL_HEIGHT, mark.y - LABEL_HEIGHT / 2)),
              right: 'calc(100% + var(--mrx-scrubber-label-gap))',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              opacity: dragging ? 1 : 0,
              transform: dragging ? 'translateX(0)' : 'translateX(6px)',
              transition: 'opacity 140ms ease, transform 140ms ease',
              backgroundColor: 'var(--mrx-surface-chrome)',
            }}
          >
            <Text size='xs' fw={600}>{majorLabel(model.mode, mark.key)}</Text>
          </Paper>
        ))}

        {markerY !== undefined && (
          <Paper
            className='mrx-scrubber-handle'
            shadow={dragging || focused ? 'sm' : undefined}
            style={{
              position: 'absolute',
              top: `clamp(0px, calc(${markerY}px - var(--mrx-scrubber-handle-half)), calc(100% - var(--mrx-scrubber-handle-height)))`,
              right: 0,
              // Flush with the screen edge: square there, fully rounded on the
              // side that faces the content.
              borderRadius: 'var(--mrx-scrubber-handle-half) 0 0 var(--mrx-scrubber-handle-half)',
              // Half there at rest, so the pictures show through it; solid under a finger.
              opacity: dragging || focused ? 1 : 0.6,
              width: 'var(--mrx-scrubber-handle-width)',
              height: 'var(--mrx-scrubber-handle-height)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--mantine-color-marine-5)',
              border: focused ? '2px solid var(--mantine-color-marine-2)' : 'none',
              borderRight: 'none',
              transition: dragging ? 'opacity 140ms ease' : 'top 100ms ease, box-shadow 140ms ease, opacity 140ms ease',
              zIndex: 1,
              pointerEvents: ready ? 'auto' : 'none',
              touchAction: 'none',
              cursor: ready ? 'ns-resize' : 'default',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          >
            <TablerIcon
              name='selector'
              color='white'
              stroke={2}
              style={{ width: 'var(--mrx-scrubber-grip-size)', height: 'var(--mrx-scrubber-grip-size)', opacity: 0.9 }}
            />
          </Paper>
        )}

        {dragging && dragSelection && markerY !== undefined && (
          <Paper
            className='mrx-scrubber-tooltip'
            shadow='md'
            radius='xl'
            px='sm'
            py={5}
            style={{
              position: 'absolute',
              top: tooltipTop,
              right: 'calc(100% + var(--mrx-scrubber-label-gap))',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 2,
              backgroundColor: 'var(--mrx-surface-chrome)',
            }}
          >
            <Text size='xs' fw={600}>{targetLabel(model.mode, dragSelection.date)}</Text>
          </Paper>
        )}
      </div>
    </Box>
  );
}
