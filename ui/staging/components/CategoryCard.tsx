import type { StagingCategoryStatus, StagingFileCounts } from '@archive/staging/api';
import { type BarSegment, CANCELLED_COLOR, StackedBar, TablerIcon, WAITING_COLOR, WORKLOAD_COLORS } from '@ein/ui/components';
import { countOf, formatBytes, type UploadCounts } from '@ein/ui/lib';
import { openDialog } from '@ein/ui/signals';
import { ActionIcon, Card, Group, Stack, Text, Tooltip } from '@mantine/core';
import { type CategorySegmentKey, categorySegments, categoryStages, heldFiles } from '../lib/overview.ts';
import { ArrivalStages } from './ArrivalStages.tsx';

/**
 * The status hues the parts of a category's bar wear: not started, under way, needing a person,
 * and neutral for what is not media. The two neutrals are at the bar's two ends, never side by side.
 */
const SEGMENT_COLORS: Record<CategorySegmentKey, string> = {
  preparing: WAITING_COLOR,
  ready: WORKLOAD_COLORS.running,
  undated: WORKLOAD_COLORS.queued,
  other: CANCELLED_COLOR,
};

/** A category's counts as the segments of a `StackedBar`. */
const barSegments = (counts: StagingFileCounts): BarSegment[] => categorySegments(counts).map((segment) => ({ ...segment, color: SEGMENT_COLORS[segment.key] }));

/** The route of the Import dialog, into `category` when one is named. */
export const importRoute = (category?: string): string => category ? `/staging/import?c=${encodeURIComponent(category)}` : '/staging/import';

/** The route of `category`'s settings dialog. */
export const settingsRoute = (category: string): string => `/staging/categories/${encodeURIComponent(category)}`;

type Props = {
  category: StagingCategoryStatus;
  /** How long its files still being prepared take, in ms, when there is a rate to tell. */
  eta?: number;
  /** The uploads into it from this browser. */
  uploads?: UploadCounts;
  onOpen: () => void;
};

/**
 * One category on the overview: what it is called and holds, a bar of its files by how far along
 * they are, and how many are arriving, being prepared and being grouped. Clicking it (or Enter on
 * it) opens its page; its gear opens its settings.
 */
export function CategoryCard({ category, eta, uploads, onOpen }: Props) {
  const held = heldFiles(category.counts);
  return (
    <Card
      withBorder
      radius='md'
      padding='md'
      role='button'
      tabIndex={0}
      aria-label={`Open ${category.label}`}
      style={{ cursor: 'pointer' }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <Stack gap='sm'>
        <Group justify='space-between' wrap='nowrap' align='flex-start'>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} truncate>{category.label}</Text>
            <Text size='xs' c='dimmed' truncate>files/{category.name}</Text>
          </Stack>
          <Tooltip label='Category settings'>
            <ActionIcon
              variant='subtle'
              color='gray'
              aria-label={`Settings of ${category.label}`}
              onClick={(event) => {
                event.stopPropagation();
                openDialog(settingsRoute(category.name));
              }}
            >
              <TablerIcon name='settings' size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {held > 0
          ? <StackedBar segments={barSegments(category.counts).filter((segment) => segment.value > 0)} height={10} />
          : <Text size='sm' c='dimmed'>Nothing here yet.</Text>}
        <Text size='xs' c='dimmed'>
          {countOf(held, 'file', 'files')} · {formatBytes(category.counts.bytes)}
        </Text>
        <ArrivalStages stages={categoryStages(category, uploads)} eta={eta} />
      </Stack>
    </Card>
  );
}
