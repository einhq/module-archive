import { Box } from '@mantine/core';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef } from 'react';
import { volumeKeyTarget } from '../lib/player-settings.ts';

type VolumeSliderProps = {
  /** 0–1; drawn as none while muted. */
  volume: number;
  muted: boolean;
  onChange: (volume: number) => void;
};

/**
 * The video player's volume: drag or click along it, or the slider keys while it has focus.
 *
 * Like the timeline, a click leaves the focus where it was, so the lightbox's arrow keys stay its
 * previous and next; a keyboard user tabs to it, and then it keeps the arrows it handles.
 */
export function VolumeSlider({ volume, muted, onChange }: VolumeSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const heard = muted ? 0 : volume;

  const at = (clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return Math.round(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * 100) / 100;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const value = at(event.clientX);
    if (value === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onChange(value);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const value = at(event.clientX);
    if (value !== null) onChange(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const value = volumeKeyTarget(event, heard);
    if (value === null) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(value);
  };

  return (
    <Box
      ref={trackRef}
      role='slider'
      aria-label='Volume'
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(heard * 100)}
      aria-valuetext={muted ? 'Muted' : `${Math.round(volume * 100)}%`}
      tabIndex={0}
      className='mrx-video-volume'
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={onKeyDown}
      style={{ '--level': heard } as CSSProperties}
    >
      <div className='mrx-video-volume-track'>
        <div className='mrx-video-played' style={{ transform: 'scaleX(var(--level, 0))' }} />
      </div>
      <div className='mrx-video-thumb' style={{ left: 'calc(var(--level, 0) * 100%)' }} />
    </Box>
  );
}
