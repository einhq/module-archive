/**
 * The file actions of the details panel's cog menu (`useFileActions`) as a row of icons floating
 * over the top of the picture, on a translucent rounded pill. Each icon is titled with its action;
 * one that is on (drawing faces, mirrored) is in the accent colour.
 *
 * The row sits just inside the picture's top edge, measured from where the picture is drawn, and
 * no higher than `minTop` from the top of the surface it floats in, so it clears the buttons there.
 */

import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Group } from '@mantine/core';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContentRect } from '../hooks/useContentRect.ts';
import { type FileActionsOptions, useFileActions } from './FileActions.tsx';

const INSET_PX = 8;

type FileToolbarProps = FileActionsOptions & {
  /** A dialog of the toolbar's opened or closed, which has the keys while open. */
  onLayer: (open: boolean) => void;
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  minTop: number;
  iconSize: number;
  buttonSize: string;
};

export function FileToolbar({ onLayer, mediaRef, minTop, iconSize, buttonSize, ...options }: FileToolbarProps) {
  const { actions, dialogs, layer } = useFileActions(options);
  useEffect(() => onLayer(layer), [layer]);
  useEffect(() => () => onLayer(false), []);
  const rect = useContentRect(mediaRef);
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(minTop);

  // Measured on every render rather than from `rect` alone: a zoom scales the picture's element
  // without resizing it.
  useLayoutEffect(() => {
    const el = mediaRef.current;
    const surface = ref.current?.offsetParent;
    if (!el || !surface || !rect || el.clientHeight === 0) return setTop(minTop);
    const box = el.getBoundingClientRect();
    const scale = box.height / el.clientHeight;
    const pictureTop = box.top + (rect.top - el.offsetTop) * scale - surface.getBoundingClientRect().top;
    const next = Math.max(minTop, Math.round(pictureTop + INSET_PX));
    setTop((current) => current === next ? current : next);
  });

  if (actions.length === 0) return <>{dialogs}</>;
  return (
    <>
      <Group
        ref={ref}
        data-lightbox-toolbar
        gap={2}
        wrap='nowrap'
        p={4}
        style={{
          position: 'absolute',
          zIndex: 9,
          top,
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: `calc(100% - ${2 * INSET_PX}px)`,
          overflowX: 'auto',
          borderRadius: 'var(--mantine-radius-md)',
          background: 'rgba(0, 0, 0, 0.55)',
          backdropFilter: 'blur(4px)',
        }}
      >
        {actions.map((action) => (
          <ActionIcon
            key={action.key}
            variant='subtle'
            color='gray'
            size={buttonSize}
            title={action.label}
            aria-label={action.label}
            aria-pressed={action.checked}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            <TablerIcon name={action.icon} size={iconSize} color={action.checked ? 'var(--mrx-accent)' : 'white'} />
          </ActionIcon>
        ))}
      </Group>
      {dialogs}
    </>
  );
}
