import type { StagingCategoryStatus, StagingQueueReport } from '@archive/staging/api';
import { StackedBar } from '@ein/ui/components';
import { shq, uploadsUnder } from '@ein/ui/lib';
import { execCommand, notify, uploadSummaryByTarget } from '@ein/ui/signals';
import { Stack } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback } from 'react';
import { categoryStages, heldFiles, stagesUnderWay } from '../lib/overview.ts';
import { ArrivalStages } from './ArrivalStages.tsx';
import { barSegments } from './CategoryCard.tsx';

type Props = {
  category: Pick<StagingCategoryStatus, 'path' | 'counts' | 'organizer'>;
  /** How long the files still being prepared take, in ms, when there is a rate to tell. */
  eta?: number;
};

/**
 * Where a category's files are, above its tabs: a thin bar of them by how far along they are, and
 * while files are on their way in, how many are arriving (the uploads into it from this browser),
 * being prepared and being grouped, which **Group now** asks the organizer to do at once
 * (`staging organize <category> --queue`). Nothing for an empty category nothing is arriving in.
 * It follows the uploads itself, so the page under it does not render again with each of their
 * updates.
 */
export function ProgressStrip({ category, eta }: Props) {
  useSignals();
  const stages = categoryStages(category, uploadsUnder(uploadSummaryByTarget.value, category.path));
  const groupNow = useCallback(async () => {
    try {
      await execCommand<StagingQueueReport>(`staging organize ${shq(category.path)} --queue`);
      notify({ message: 'Grouping asked for: the new files are grouped within a few minutes' });
    } catch (error) {
      notify({ message: `Could not ask for grouping: ${error instanceof Error ? error.message : String(error)}`, color: 'red' });
    }
  }, [category.path]);
  const held = heldFiles(category.counts);
  if (held === 0 && !stagesUnderWay(stages)) return null;
  return (
    <Stack gap={4} px='md' pb='sm'>
      {held > 0 && <StackedBar segments={barSegments(category.counts).filter((segment) => segment.value > 0)} height={6} />}
      <ArrivalStages stages={stages} eta={eta} onGroupNow={groupNow} />
    </Stack>
  );
}
