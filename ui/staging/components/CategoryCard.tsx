import type { StagingCategoryStatus, StagingFileCounts } from '@archive/staging/api';
import { type BarSegment, CANCELLED_COLOR, StackedBar, TablerIcon, WAITING_COLOR, WORKLOAD_COLORS } from '@ein/ui/components';
import { countOf, formatBytes, type UploadCounts } from '@ein/ui/lib';
import { openDialog } from '@ein/ui/signals';
import { ActionIcon, Button, Card, Group, Stack, Text, Tooltip } from '@mantine/core';
import { type CategorySegmentKey, categorySegments, categoryStages, heldFiles, KIND_LABELS } from '../lib/overview.ts';
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
export const barSegments = (counts: StagingFileCounts): BarSegment[] => categorySegments(counts).map((segment) => ({ ...segment, color: SEGMENT_COLORS[segment.key] }));

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
 * they are, how many are arriving, being prepared and being grouped, and the ways into it: its
 * page, Import, and its settings.
 */
export function CategoryCard({ category, eta, uploads, onOpen }: Props) {
  const held = heldFiles(category.counts);
  return (
    <Card withBorder radius='md' padding='md'>
      <Stack gap='sm' h='100%'>
        <Group justify='space-between' wrap='nowrap' align='flex-start'>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text fw={600} truncate>{category.label}</Text>
            <Text size='xs' c='dimmed' truncate>{KIND_LABELS[category.kind]} · files/{category.name}</Text>
          </Stack>
          <Tooltip label='Category settings'>
            <ActionIcon variant='subtle' color='gray' aria-label={`Settings of ${category.label}`} onClick={() => openDialog(settingsRoute(category.name))}>
              <TablerIcon name='settings' size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {held > 0
          ? <StackedBar segments={barSegments(category.counts).filter((segment) => segment.value > 0)} height={10} />
          : <Text size='sm' c='dimmed'>Nothing here yet.</Text>}
        <Text size='xs' c='dimmed'>
          {countOf(held, 'file', 'files')} · {formatBytes(category.counts.bytes)}
          {category.destination ? ` · filed into ${category.destination.title}` : ''}
        </Text>
        <ArrivalStages stages={categoryStages(category, uploads)} eta={eta} />
        <Group justify='flex-end' gap='xs' mt='auto'>
          <Button variant='default' size='xs' leftSection={<TablerIcon name='cloud-upload' size={14} />} onClick={() => openDialog(importRoute(category.name))}>
            Import
          </Button>
          <Button size='xs' rightSection={<TablerIcon name='arrow-right' size={14} />} onClick={onOpen}>
            {held > 0 ? 'Continue' : 'Open'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
