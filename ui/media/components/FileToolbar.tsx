/**
 * The file actions (`useFileActions`) as a row of icons floating
 * over the top of the viewer, on a translucent rounded pill. Each icon is titled with its action;
 * one that is on (drawing faces, mirrored) is in the accent colour. Past a divider at its end, a
 * close button hides the toolbar, as the lightbox menu's switch does.
 *
 * The row stays `top` from the top of the surface it floats in, whatever picture is shown, so it
 * clears the buttons there.
 */

import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Divider, Group } from '@mantine/core';
import { useEffect } from 'react';
import { type FileActionsOptions, useFileActions } from './FileActions.tsx';

const INSET_PX = 8;

type FileToolbarProps = FileActionsOptions & {
  /** A dialog of the toolbar's opened or closed, which has the keys while open. */
  onLayer: (open: boolean) => void;
  /** Hide the toolbar. */
  onHide: () => void;
  top: number;
  iconSize: number;
  buttonSize: string;
};

export function FileToolbar({ onLayer, onHide, top, iconSize, buttonSize, ...options }: FileToolbarProps) {
  const { actions, dialogs, layer } = useFileActions(options);
  useEffect(() => onLayer(layer), [layer]);
  useEffect(() => () => onLayer(false), []);

  if (actions.length === 0) return <>{dialogs}</>;
  return (
    <>
      <Group
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
        <Divider orientation='vertical' mx={4} color='rgba(255, 255, 255, 0.35)' />
        <ActionIcon variant='subtle' color='gray' size={buttonSize} title='Hide toolbar' aria-label='Hide toolbar' onClick={onHide}>
          <TablerIcon name='x' size={iconSize} color='white' />
        </ActionIcon>
      </Group>
      {dialogs}
    </>
  );
}
