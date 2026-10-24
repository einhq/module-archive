import { Box } from '@mantine/core';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useRef } from 'react';
import { formatClock } from '@ein/ui/lib';
import type { MediaTransport } from '../hooks/useMediaTransport.ts';
import { scrubKeyTarget, timeAtClientX } from '../lib/transport.ts';

type ScrubberProps = {
  transport: MediaTransport;
  /** The chapters' starts, for PageUp and PageDown. */
  chapters?: number[];
  /** What a screen reader hears as the value; the clock unless given. */
  valueText?: string;
  /**
   * The time under the pointer as a mouse moves over the timeline or anything drags it, with the
   * pointer's x; null when the mouse leaves or the drag ends.
   */
  onPoint?: (seconds: number | null, clientX: number) => void;
  style?: CSSProperties;
  className?: string;
  /** What is drawn on the timeline. It reads the playhead from the inherited `--progress` (0–1). */
  children?: ReactNode;
};

/**
 * A player's timeline: drag or click to seek, and the slider keys while it has focus.
 *
 * A click does not leave the focus on it (`onMouseDown`): the lightbox's arrow keys step to the next
 * picture, and a timeline focused by the mouse would quietly take them for ±5 s instead. A keyboard
 * user tabs to it, and then it handles the arrows itself and stops them there, or the album would
 * step off the recording in the same keystroke.
 */
export function Scrubber({ transport, chapters, valueText, onPoint, style, className, children }: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const { progressRef } = transport;
  const attach = useCallback((el: HTMLDivElement | null) => {
    trackRef.current = el;
    progressRef(el);
  }, [progressRef]);

  const timeAt = (clientX: number): number | null => {
    const track = trackRef.current;
    return track ? timeAtClientX(clientX, track.getBoundingClientRect(), transport.duration) : null;
  };

  // Pointer capture, so a drag that leaves the timeline keeps scrubbing and ends wherever it is let go.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const seconds = timeAt(event.clientX);
    if (seconds === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    transport.startScrub(seconds);
    onPoint?.(seconds, event.clientX);
  };

  // A mouse points without pressing; anything else points only while it drags.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragging = event.currentTarget.hasPointerCapture(event.pointerId);
    if (!dragging && event.pointerType !== 'mouse') return;
    const seconds = timeAt(event.clientX);
    if (dragging && seconds !== null) transport.moveScrub(seconds);
    onPoint?.(seconds, event.clientX);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    transport.endScrub();
    if (event.pointerType !== 'mouse') onPoint?.(null, event.clientX);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = scrubKeyTarget(event, transport.position, transport.duration, chapters);
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    transport.seek(target);
  };

  return (
    <Box
      ref={attach}
      role='slider'
      aria-label='Seek'
      aria-valuemin={0}
      aria-valuemax={Math.round(transport.duration)}
      aria-valuenow={Math.round(transport.position)}
      aria-valuetext={valueText ?? formatClock(transport.position)}
      tabIndex={0}
      className={className}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={() => transport.endScrub()}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse' && !event.currentTarget.hasPointerCapture(event.pointerId)) onPoint?.(null, event.clientX);
      }}
      onKeyDown={onKeyDown}
      style={{ cursor: 'pointer', touchAction: 'none', ...style }}
    >
      {children}
    </Box>
  );
}
