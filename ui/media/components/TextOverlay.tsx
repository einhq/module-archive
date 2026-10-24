/**
 * The text in a picture, laid over it.
 *
 * The layer covers exactly the rendered picture — not the `object-fit: contain` element around
 * it — and darkens it enough to read the text against. The text is in a typewriter face, sized so
 * its longest line spans most of the picture's width, between a floor that keeps a long line readable (it
 * wraps there) and a ceiling that keeps short text at a reading size. Text narrower than the
 * picture is centred across it, and text shorter than it centred down it too. Text taller than the
 * picture scrolls inside the layer, from its top, with the app's scrollbar (`ScrollBox`); the
 * layer takes the wheel and the finger for that (`data-text-overlay`).
 */

import { ScrollBox, TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Tooltip } from '@mantine/core';
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContentRect } from '../hooks/useContentRect.ts';
import { usePictureText } from '../hooks/usePictureText.ts';

const FONT_FAMILY = 'var(--mrx-font-typewriter)';
const MIN_FONT_PX = 16;
const MAX_FONT_PX = 26;
/** The longest line spans this share of the width, leaving a margin either side of the text. */
const WIDTH_SHARE = 0.85;
const LINE_HEIGHT = 1.3;

type TextOverlayProps = {
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  /** The picture, whose `metadata/content` holds the whole text when `text` is only its start. */
  path: string;
  text: string;
  truncated?: boolean;
  /** Present when the text may be written: opens the editor. */
  onEdit?: () => void;
};

let measureContext: CanvasRenderingContext2D | null = null;

/** The font size at which the widest of `lines` is `width` wide, in the font `family`. */
const sizeToWidth = (lines: string[], width: number, family: string): number => {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) return MIN_FONT_PX;
  measureContext.font = `100px ${family}`;
  const widest = Math.max(0, ...lines.map((line) => measureContext!.measureText(line).width));
  // A little under the exact fit: the browser's layout rounds differently from the canvas.
  return widest > 0 ? (100 * width / widest) * 0.98 : MIN_FONT_PX;
};

export function TextOverlay({ mediaRef, path, text, truncated = false, onEdit }: TextOverlayProps) {
  const rect = useContentRect(mediaRef);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [fontSize, setFontSize] = useState(MIN_FONT_PX);
  const [fontsReady, setFontsReady] = useState(0);
  const shown = usePictureText(path, text, truncated).text;

  // Measured in the typewriter face, which may still be on its way when the layer first draws.
  const placed = rect !== null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let live = true;
    document.fonts.load(`16px ${getComputedStyle(el).fontFamily}`).then(() => live && setFontsReady((n) => n + 1)).catch(() => {});
    return () => {
      live = false;
    };
  }, [placed]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !rect) return;
    const style = getComputedStyle(el);
    const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const fit = sizeToWidth(shown.split('\n'), width * WIDTH_SHARE, style.fontFamily);
    setFontSize(Math.max(MIN_FONT_PX, Math.min(fit, MAX_FONT_PX)));
  }, [rect, shown, fontsReady]);

  if (!rect) return null;

  const padding = Math.max(8, Math.round(Math.min(rect.width, rect.height) * 0.04));

  return (
    <Box
      data-text-overlay
      style={{
        position: 'absolute',
        // Over the face layer, which sits at 2.
        zIndex: 3,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(0, 0, 0, 0.84)',
        cursor: 'auto',
        userSelect: 'text',
      }}
    >
      <ScrollBox
        viewportRef={scrollRef}
        // The thumb is drawn in the text colour, which over the darkened picture is white.
        frameStyle={{ flex: 1, minHeight: 0, '--mrx-text-primary': 'white' } as CSSProperties}
        style={{
          fontFamily: FONT_FAMILY,
          fontSize,
          lineHeight: LINE_HEIGHT,
          color: 'white',
          padding,
          overscrollBehavior: 'contain',
          touchAction: 'pan-y',
        }}
      >
        {
          /* At least the viewport's height, so a short text sits in the middle; a taller one makes
            it taller and starts at the top. The lines keep to the left of their block. */
        }
        <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ maxWidth: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shown}</div>
        </div>
      </ScrollBox>
      {onEdit && (
        <Tooltip label='Edit text' withArrow>
          <ActionIcon
            variant='subtle'
            color='gray'
            onClick={onEdit}
            aria-label='Edit text'
            // Clear of the scrollbar along the right edge.
            style={{ position: 'absolute', top: 4, right: 14, background: 'rgba(0, 0, 0, 0.4)' }}
          >
            <TablerIcon name='pencil' size={16} color='white' />
          </ActionIcon>
        </Tooltip>
      )}
    </Box>
  );
}
