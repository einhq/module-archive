import { ActionIcon, Box, Group, SegmentedControl, Slider, Stack, Text, Tooltip } from '@mantine/core';
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { TablerIcon } from '@ein/ui/components';
import { drawStroke, type MaskStroke } from '../lib/restore-mask.ts';
import {
  isZoomed,
  panZoom,
  pinchGeometry,
  pinchZoom,
  stepZoom,
  wheelZoomScale,
  ZOOM_IDENTITY,
  zoomAt,
  zoomedSizes,
  type ZoomFrame,
  type ZoomPoint,
  type ZoomState,
} from '../lib/lightbox-zoom.ts';

/** The marks' colour over the picture. */
const INK = '#fa5252';
/** The long edge the marks to start from are kept at, in canvas pixels. */
const EDGE = 1600;
/** How far the picture zooms: far enough that a speck on a large scan is several screen pixels across. */
const MAX_ZOOM = 16;

type Props = {
  /** The picture, upright as it is shown. */
  src: string;
  srcSet?: string;
  /** Marks to start from, white on black in the display frame. */
  marks?: string;
  strokes: MaskStroke[];
  onStrokes: (strokes: MaskStroke[]) => void;
  mode: MaskStroke['mode'];
  /** The brush's radius, in fractions of the picture's width. */
  radius: number;
  disabled?: boolean;
};

/**
 * A picture with marks over it in red, painted on and erased with a brush. The strokes are kept
 * in fractions of the display frame, so they can be drawn again at any size. The picture zooms
 * and pans the way the lightbox's does — the wheel or two fingers zoom, a drag with the right or
 * middle button or with two fingers pans, the buttons in the corner step — and the marks are
 * drawn at the screen's resolution over the part that is shown.
 */
export function MarksBrush({ src, srcSet, marks, strokes, onStrokes, mode, radius, disabled }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<MaskStroke | null>(null);
  const pointers = useRef(new Map<number, ZoomPoint>());
  const pinch = useRef<{ state: ZoomState; centre: ZoomPoint; distance: number } | null>(null);
  const [cursor, setCursor] = useState<ZoomPoint | null>(null);
  const [loaded, setLoaded] = useState(0);
  // The picture's shape, once it has loaded; square until then.
  const [aspect, setAspect] = useState(1);
  const width = aspect >= 1 ? EDGE : Math.round(EDGE * aspect);
  const height = aspect >= 1 ? Math.round(EDGE / aspect) : EDGE;
  // The box's size in CSS pixels, which is the picture's at fit.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_IDENTITY);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const ratio = globalThis.devicePixelRatio || 1;

  // The marks to start from, turned from white on black into red on nothing.
  useEffect(() => {
    base.current = null;
    if (!marks) return setLoaded((n) => n + 1);
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      const layer = document.createElement('canvas');
      layer.width = width;
      layer.height = height;
      const ctx = layer.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height);
      const [r, g, b] = [0xfa, 0x52, 0x52];
      for (let i = 0; i < pixels.data.length; i += 4) {
        const marked = pixels.data[i] >= 128;
        pixels.data.set([r, g, b, marked ? 255 : 0], i);
      }
      ctx.putImageData(pixels, 0, 0);
      base.current = layer;
      setLoaded((n) => n + 1);
    };
    image.src = marks;
    return () => {
      live = false;
    };
  }, [marks, width, height]);

  useEffect(() => setZoom(ZOOM_IDENTITY), [src]);

  const frame = useCallback((): ZoomFrame => {
    const shown = { width: box.current?.clientWidth ?? 0, height: box.current?.clientHeight ?? 0 };
    return { viewport: shown, content: shown, max: MAX_ZOOM };
  }, []);

  /** A screen point relative to the box's centre, the frame the zoom geometry works in. */
  const focal = useCallback((clientX: number, clientY: number): ZoomPoint => {
    const bounds = box.current!.getBoundingClientRect();
    return { x: clientX - (bounds.left + bounds.width / 2), y: clientY - (bounds.top + bounds.height / 2) };
  }, []);

  /** The marks and the strokes, the one being made too, over the part of the picture shown. */
  const draw = useCallback(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // The picture's top left corner and size on the screen, in CSS pixels from the box's.
    const { scale, x, y } = zoomRef.current;
    const [shownWidth, shownHeight] = [size.width * scale, size.height * scale];
    ctx.setTransform(ratio, 0, 0, ratio, ratio * (size.width / 2 + x - shownWidth / 2), ratio * (size.height / 2 + y - shownHeight / 2));
    ctx.imageSmoothingEnabled = false;
    if (base.current) ctx.drawImage(base.current, 0, 0, shownWidth, shownHeight);
    for (const stroke of drawing.current ? [...strokes, drawing.current] : strokes) drawStroke(ctx, stroke, shownWidth, shownHeight, INK, null);
  }, [strokes, size, ratio]);

  useEffect(draw, [draw, loaded, zoom]);

  // Native, not React's `onWheel`, which is passive: the dialog must not scroll under the zoom.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = zoomRef.current;
      setZoom(zoomAt(current, focal(event.clientX, event.clientY), wheelZoomScale(current.scale, event.deltaY, MAX_ZOOM), frame()));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [focal, frame]);

  // A resized box (the dialog, the window) changes the canvas and could leave the picture short of an edge.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
      setZoom((current) => panZoom(current, 0, 0, frame()));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);

  /** Where a pointer is on the picture, in fractions of the display frame. */
  const at = (clientX: number, clientY: number): [number, number] => {
    const point = focal(clientX, clientY);
    const { scale, x, y } = zoomRef.current;
    const { viewport } = frame();
    const fraction = (offset: number, shift: number, extent: number) => Math.min(1, Math.max(0, (offset - shift) / (scale * extent) + 0.5));
    return [fraction(point.x, x, viewport.width), fraction(point.y, y, viewport.height)];
  };
  const track = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = box.current!.getBoundingClientRect();
    setCursor({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };

  // One pointer paints with the left button and pans with another, or with the left one while
  // disabled; a second finger takes back the stroke the first began and pinches instead.
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) return;
    // The middle button pans here, not the page.
    if (event.button === 1) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    track(event);
    if (pointers.current.size === 2) {
      drawing.current = null;
      draw();
      const [a, b] = [...pointers.current.values()];
      pinch.current = { state: zoomRef.current, ...pinchGeometry(focal(a.x, a.y), focal(b.x, b.y)) };
      return;
    }
    if (pointers.current.size > 1 || disabled || event.button !== 0) return;
    drawing.current = { mode, radius, points: [at(event.clientX, event.clientY)] };
    draw();
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    track(event);
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      setZoom(pinchZoom(pinch.current, pinchGeometry(focal(a.x, a.y), focal(b.x, b.y)), frame()));
      return;
    }
    const stroke = drawing.current;
    if (!stroke) return setZoom((current) => panZoom(current, event.clientX - previous.x, event.clientY - previous.y, frame()));
    stroke.points.push(at(event.clientX, event.clientY));
    draw();
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const stroke = drawing.current;
    drawing.current = null;
    if (stroke) onStrokes([...strokes, stroke]);
  };

  const zoomed = isZoomed(zoom);
  // The brush's outline, never too small to see.
  const brush = Math.max(3, 2 * radius * size.width * zoom.scale);

  return (
    <Stack gap={4} align='center'>
      <Box
        ref={box}
        pos='relative'
        display='inline-block'
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => setCursor(null)}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
        style={{
          lineHeight: 0,
          overflow: 'hidden',
          borderRadius: 'var(--mantine-radius-sm)',
          touchAction: 'none',
          userSelect: 'none',
          cursor: !disabled ? 'none' : zoomed ? 'grab' : 'default',
        }}
      >
        <img
          src={src}
          srcSet={srcSet || undefined}
          sizes={zoomedSizes(zoom.scale)}
          alt=''
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) setAspect(image.naturalWidth / image.naturalHeight);
          }}
          style={{
            maxWidth: '100%',
            maxHeight: 'max(240px, calc(100dvh - 350px))',
            width: 'auto',
            height: 'auto',
            display: 'block',
            transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
            transformOrigin: 'center',
          }}
        />
        <canvas
          ref={canvas}
          width={Math.round(size.width * ratio)}
          height={Math.round(size.height * ratio)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.6 }}
        />
        {cursor && !disabled && (
          <Box
            pos='absolute'
            style={{
              left: cursor.x - brush / 2,
              top: cursor.y - brush / 2,
              width: brush,
              height: brush,
              borderRadius: '50%',
              border: '1px solid white',
              boxShadow: '0 0 0 1px black',
              pointerEvents: 'none',
            }}
          />
        )}
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
      <Text size='xs' c='dimmed'>Zoom with the wheel, two fingers or the buttons; move with the right mouse button or two fingers.</Text>
    </Stack>
  );
}

/** The brush's radius at its smallest and largest, in fractions of the picture's width. */
const BRUSH_MIN = 0.0003;
const BRUSH_MAX = 0.05;

/** Paint or erase, how wide, and taking the last stroke back. */
export function BrushBar({ mode, onMode, radius, onRadius, onUndo, disabled }: {
  mode: MaskStroke['mode'];
  onMode: (mode: MaskStroke['mode']) => void;
  radius: number;
  onRadius: (radius: number) => void;
  /** Absent when there is nothing to take back. */
  onUndo?: () => void;
  disabled?: boolean;
}) {
  return (
    <Group gap='md' wrap='wrap'>
      <SegmentedControl
        size='xs'
        value={mode}
        onChange={(value) => onMode(value as MaskStroke['mode'])}
        disabled={disabled}
        data={[{ value: 'paint', label: 'Paint' }, { value: 'erase', label: 'Erase' }]}
      />
      <Group gap='xs' wrap='nowrap' style={{ flex: 1, minWidth: 160, maxWidth: 280 }}>
        <Text size='xs' c='dimmed'>Size</Text>
        <Slider
          style={{ flex: 1 }}
          min={Math.log(BRUSH_MIN)}
          max={Math.log(BRUSH_MAX)}
          step={0.01}
          value={Math.log(radius)}
          onChange={(value) => onRadius(Math.exp(value))}
          disabled={disabled}
          label={null}
        />
      </Group>
      <Tooltip label='Take back the last stroke'>
        <ActionIcon variant='default' onClick={onUndo} disabled={disabled || !onUndo} aria-label='Undo'>
          <TablerIcon name='arrow-back-up' size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
