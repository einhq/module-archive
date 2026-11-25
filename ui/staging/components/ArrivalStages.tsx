import { TablerIcon } from '@ein/ui/components';
import { formatDuration } from '@ein/ui/lib';
import { Group, Text, Tooltip } from '@mantine/core';
import { Fragment } from 'react';
import { type CategoryStages, stagesUnderWay } from '../lib/overview.ts';

type Props = {
  stages: CategoryStages;
  /** How long the files still being prepared take, in ms, when there is a rate to tell. */
  eta?: number;
};

/**
 * Where a category's newest files are on their way in, in the order they go: arriving (uploading
 * from this browser), being prepared, being grouped. Each stage shows while it holds files;
 * nothing when none does.
 */
export function ArrivalStages({ stages, eta }: Props) {
  if (!stagesUnderWay(stages)) return null;
  const parts = [
    ...(stages.arriving
      ? [{
        icon: 'cloud-upload',
        text: `${stages.arriving.done.toLocaleString()} of ${stages.arriving.of.toLocaleString()} arriving`,
        tip: 'Uploading from this browser',
      }]
      : []),
    ...(stages.preparing > 0
      ? [{
        icon: 'loader-2',
        text: `${stages.preparing.toLocaleString()} being prepared${eta !== undefined ? `, about ${formatDuration(eta)}` : ''}`,
        tip: 'Their dates and places are being read; the groups they join may still change',
      }]
      : []),
    ...(stages.grouping > 0
      ? [{ icon: 'stack-2', text: `${stages.grouping.toLocaleString()} being grouped`, tip: 'Read, and waiting for the organizer to put them in a group' }]
      : []),
  ];
  return (
    <Group gap={6} wrap='wrap'>
      {parts.map((part, index) => (
        <Fragment key={part.icon}>
          {index > 0 && <Text size='xs' c='dimmed' aria-hidden>→</Text>}
          <Tooltip label={part.tip}>
            <Group gap={4} wrap='nowrap'>
              <TablerIcon name={part.icon} size={14} />
              <Text size='xs' c='dimmed'>{part.text}</Text>
            </Group>
          </Tooltip>
        </Fragment>
      ))}
    </Group>
  );
}
