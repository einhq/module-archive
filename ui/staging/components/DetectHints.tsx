import { TablerIcon } from '@ein/ui/components';
import { openDialog } from '@ein/ui/signals';
import { ActionIcon, Alert, Anchor, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useState } from 'react';
import type { DetectHint } from '../lib/detect-hint.ts';

/** Hints shown before "N more". */
const SHOWN = 3;

type Props = {
  hints: DetectHint[];
  /** Open the Move dialog for a hint whose way is a category the reader has. */
  onMove: (hint: DetectHint) => void;
  /** Stop offering a hint for the folder at `path`. */
  onDismiss: (path: string) => void;
};

/**
 * What newly arrived folders of the default category look like, a row each: "“Takeout” looks like
 * Google Photos", its strongest evidence, the way to its category (Move to it, or Make one, which
 * moves the folder there once made), and a dismiss for a folder that stays. The first `SHOWN`,
 * then "N more" for the rest. Nothing when there are no hints.
 */
export function DetectHints({ hints, onMove, onDismiss }: Props) {
  const [all, setAll] = useState(false);
  if (hints.length === 0) return null;
  const shown = all ? hints : hints.slice(0, SHOWN);
  return (
    <Alert color='blue' variant='light' icon={<TablerIcon name='wand' size={16} />} data-detect-hints>
      <Stack gap='xs'>
        {shown.map((hint) => (
          <Group key={hint.path} justify='space-between' gap='sm' wrap='nowrap' data-detect-hint>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size='sm' truncate>“{hint.name}” looks like {hint.source}</Text>
              <Text size='xs' c='dimmed' truncate>{hint.evidence.slice(0, 2).join(' · ')}</Text>
            </Stack>
            <Group gap={4} wrap='nowrap' style={{ flexShrink: 0 }}>
              <Button size='xs' variant='light' onClick={() => hint.action.type === 'move' ? onMove(hint) : openDialog(hint.action.route)}>
                {hint.action.label}
              </Button>
              <Tooltip label='Keep it here, stop asking'>
                <ActionIcon variant='subtle' color='gray' aria-label={`Dismiss the hint for “${hint.name}”`} onClick={() => onDismiss(hint.path)}>
                  <TablerIcon name='x' size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        ))}
        {hints.length > SHOWN && (
          <Anchor component='button' type='button' size='xs' onClick={() => setAll(!all)} style={{ alignSelf: 'flex-start' }}>
            {all ? 'Show fewer' : `${hints.length - SHOWN} more`}
          </Anchor>
        )}
      </Stack>
    </Alert>
  );
}
