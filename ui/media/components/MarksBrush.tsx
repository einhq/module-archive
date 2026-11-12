import { ActionIcon, Box, Group, SegmentedControl, Slider, Text, Tooltip } from '@mantine/core';
import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { TablerIcon } from '@ein/ui/components';
import { drawStroke, type MaskStroke } from '../lib/restore-mask.ts';

/** The marks' colour over the picture. */
const INK = '#fa5252';
/** The long edge the marks are drawn at over the picture, in canvas pixels. */
const EDGE = 1600;

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
 * in fractions of the display frame, so they can be drawn again at any size.
 */
export function MarksBrush({ src, srcSet, marks, strokes, onStrokes, mode, radius, disabled }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<MaskStroke | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; size: number } | null>(null);
  const [loaded, setLoaded] = useState(0);
  // The picture's shape, once it has loaded; square until then.
  const [aspect, setAspect] = useState(1);
  const width = aspect >= 1 ? EDGE : Math.round(EDGE * aspect);
  const height = aspect >= 1 ? Math.round(EDGE / aspect) : EDGE;

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

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (base.current) ctx.drawImage(base.current, 0, 0);
    for (const stroke of strokes) drawStroke(ctx, stroke, width, height, INK, null);
  }, [strokes, loaded, width, height]);

  const at = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))];
  };
  const track = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setCursor({ x: event.clientX - box.left, y: event.clientY - box.top, size: 2 * radius * box.width });
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = { mode, radius, points: [at(event)] };
    const ctx = canvas.current?.getContext('2d');
    if (ctx) drawStroke(ctx, drawing.current, width, height, INK, null);
    track(event);
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    track(event);
    const stroke = drawing.current;
    if (!stroke) return;
    const point = at(event);
    const last = stroke.points[stroke.points.length - 1];
    stroke.points.push(point);
    const ctx = canvas.current?.getContext('2d');
    if (ctx) drawStroke(ctx, { ...stroke, points: [last, point] }, width, height, INK, null);
  };
  const up = () => {
    const stroke = drawing.current;
    drawing.current = null;
    if (stroke) onStrokes([...strokes, stroke]);
  };

  return (
    <Box ta='center' style={{ lineHeight: 0 }}>
      <Box pos='relative' display='inline-block' style={{ overflow: 'hidden', borderRadius: 'var(--mantine-radius-sm)' }}>
        <img
          src={src}
          srcSet={srcSet || undefined}
          sizes='100vw'
          alt=''
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) setAspect(image.naturalWidth / image.naturalHeight);
          }}
          style={{ maxWidth: '100%', maxHeight: 'max(240px, calc(100dvh - 330px))', width: 'auto', height: 'auto', display: 'block' }}
        />
        <canvas
          ref={canvas}
          width={width}
          height={height}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={() => setCursor(null)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.6, touchAction: 'none', cursor: disabled ? 'default' : 'none' }}
        />
        {cursor && !disabled && (
          <Box
            pos='absolute'
            style={{
              left: cursor.x - cursor.size / 2,
              top: cursor.y - cursor.size / 2,
              width: cursor.size,
              height: cursor.size,
              borderRadius: '50%',
              border: '1px solid white',
              boxShadow: '0 0 0 1px black',
              pointerEvents: 'none',
            }}
          />
        )}
      </Box>
    </Box>
  );
}

/** The brush's radius at its smallest and largest, in fractions of the picture's width. */
const BRUSH_MIN = 0.002;
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
