/**
 * A photo that zooms and pans inside its box, outside the lightbox: the wheel zooms about the
 * pointer, a drag pans, a double-click (or double-tap) zooms in on a point and out again, two
 * fingers pinch, and the buttons in the corner step in, out and back to fit. The geometry is the
 * lightbox's (`lightbox-zoom`), and a zoomed picture asks for a larger rendition the same way.
 */

import { TablerIcon } from '@ein/ui/components';
import type { MediaItem } from '@ein/ui/signals';
import { ActionIcon, Box, Group } from '@mantine/core';
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { lightboxPhotoSources } from '../lib/lightbox-image.ts';
import {
  isZoomed,
  panZoom,
  pinchGeometry,
  pinchZoom,
  stepZoom,
  toggleZoom,
  wheelZoomScale,
  ZOOM_IDENTITY,
  zoomAt,
  zoomedSizes,
  type ZoomFrame,
  type ZoomPoint,
  type ZoomState,
} from '../lib/lightbox-zoom.ts';

type ZoomableImageProps = {
  media: MediaItem;
  reloadToken: number;
  alt: string;
};

export function ZoomableImage({ media, reloadToken, alt }: ZoomableImageProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_IDENTITY);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, ZoomPoint>());
  const pinchRef = useRef<{ state: ZoomState; centre: ZoomPoint; distance: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const sources = lightboxPhotoSources(media, reloadToken);
  const source = failed && sources.fallback ? sources.fallback : sources.primary;

  const frame = useCallback((): ZoomFrame => {
    const box = boxRef.current;
    const image = imageRef.current;
    const viewport = { width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 };
    if (!image?.naturalWidth || !image.naturalHeight) return { viewport, content: viewport };
    const scale = Math.min(viewport.width / image.naturalWidth, viewport.height / image.naturalHeight);
    return { viewport, content: { width: image.naturalWidth * scale, height: image.naturalHeight * scale } };
  }, []);

  /** A screen point relative to the box's centre, the frame the zoom geometry works in. */
  const focal = useCallback((clientX: number, clientY: number): ZoomPoint => {
    const bounds = boxRef.current!.getBoundingClientRect();
    return { x: clientX - (bounds.left + bounds.width / 2), y: clientY - (bounds.top + bounds.height / 2) };
  }, []);

  // Native, not React's `onWheel`, which is passive: the dialog must not scroll under the zoom.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = zoomRef.current;
      setZoom(zoomAt(current, focal(event.clientX, event.clientY), wheelZoomScale(current.scale, event.deltaY), frame()));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [focal, frame]);

  // A resized box (the dialog, the window) could leave a panned picture short of an edge.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setZoom((current) => panZoom(current, 0, 0, frame())));
    observer.observe(box);
    return () => observer.disconnect();
  }, [frame]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = { state: zoomRef.current, ...pinchGeometry(focal(a.x, a.y), focal(b.x, b.y)) };
    }
    setDragging(true);
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointers.current.values()];
      setZoom(pinchZoom(pinchRef.current, pinchGeometry(focal(a.x, a.y), focal(b.x, b.y)), frame()));
      return;
    }
    setZoom((current) => panZoom(current, event.clientX - previous.x, event.clientY - previous.y, frame()));
  };

  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const zoomed = isZoomed(zoom);

  return (
    <Box
      ref={boxRef}
      data-zoomable-image
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      // Double-tap arrives as a dblclick too.
      onDoubleClick={(event) => setZoom(toggleZoom(zoomRef.current, focal(event.clientX, event.clientY), frame()))}
      onDragStart={(event) => event.preventDefault()}
      style={{
        position: 'relative',
        overflow: 'hidden',
        width: '100%',
        height: '100%',
        background: 'black',
        touchAction: 'none',
        userSelect: 'none',
        cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
      }}
    >
      <img
        ref={imageRef}
        src={source.src}
        {...(source.srcSet ? { srcSet: source.srcSet, sizes: zoomedSizes(zoom.scale) } : {})}
        alt={alt}
        onError={() => setFailed(true)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
          transformOrigin: 'center',
          transition: dragging ? 'none' : 'transform 120ms ease-out',
        }}
      />
      <Group gap={4} style={{ position: 'absolute', right: 8, bottom: 8 }}>
        <ActionIcon variant='filled' color='dark' aria-label='Zoom out' disabled={!zoomed} onClick={() => setZoom(stepZoom(zoomRef.current, -1, frame()))}>
          <TablerIcon name='zoom-out' size={16} />
        </ActionIcon>
        <ActionIcon variant='filled' color='dark' aria-label='Zoom in' onClick={() => setZoom(stepZoom(zoomRef.current, 1, frame()))}>
          <TablerIcon name='zoom-in' size={16} />
        </ActionIcon>
        <ActionIcon variant='filled' color='dark' aria-label='Fit the picture' disabled={!zoomed} onClick={() => setZoom(ZOOM_IDENTITY)}>
          <TablerIcon name='arrows-minimize' size={16} />
        </ActionIcon>
      </Group>
    </Box>
  );
}
