import type { StagingStatus } from '@archive/staging/api';
import { stagingRoots } from '@archive/staging/paths';
import { TablerIcon } from '@ein/ui/components';
import { uploadsUnder } from '@ein/ui/lib';
import { openDialog, uploadSummaryByTarget } from '@ein/ui/signals';
import { Alert, Button, Card, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useState } from 'react';
import { refreshStagingStatus } from '../hooks/useStagingStatus.ts';
import { useDetectHints } from '../hooks/useDetectHints.ts';
import type { DetectHint } from '../lib/detect-hint.ts';
import { KIND_LABELS, NEW_KINDS } from '../lib/overview.ts';
import { CategoryCard } from './CategoryCard.tsx';
import { DetectHints } from './DetectHints.tsx';
import { MoveDialog } from './MoveDialog.tsx';
import { SftpPath } from './SftpPath.tsx';

type Props = {
  status: StagingStatus;
  /** How long each category's files still being prepared take, in ms, by name. */
  eta: Record<string, number | undefined>;
  /** Open a category's page, on a tab when one is named. */
  onOpen: (category: string, tab?: string) => void;
};

/**
 * `/staging` without a category: a card per category, with the uploads into it from this browser,
 * a card that starts a new one of a kind, the folders newly arrived in the default category that
 * look like they came from one source (`staging detect`), with the way to its category, what waits
 * for a person outside every category (GPS tracks), and where to copy files over SFTP.
 */
export function CategoryOverview({ status, eta, onOpen }: Props) {
  useSignals();
  const uploads = uploadSummaryByTarget.value;
  const { hints, reload, dismiss } = useDetectHints(status.initialized, status.categories, status.defaultCategory);
  const [moving, setMoving] = useState<DetectHint | null>(null);
  const inbox = status.categories.find((category) => category.name === status.defaultCategory);
  return (
    <Stack gap='lg' px='md'>
      <DetectHints hints={hints} onMove={setMoving} onDismiss={dismiss} />
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing='md'>
        {status.categories.map((category) => (
          <CategoryCard
            key={category.name}
            category={category}
            eta={eta[category.name]}
            uploads={uploadsUnder(uploads, category.path)}
            onOpen={() => onOpen(category.name)}
          />
        ))}
        <Card withBorder radius='md' padding='md' style={{ borderStyle: 'dashed' }}>
          <Stack gap='sm'>
            <Group gap={6}>
              <TablerIcon name='folder-plus' size={18} />
              <Text fw={600}>New category</Text>
            </Group>
            <Text size='xs' c='dimmed'>Keep one source together: a Google Photos export, a box of scanned prints, a phone.</Text>
            <Group gap='xs'>
              {NEW_KINDS.map((kind) => (
                <Button
                  key={kind}
                  size='compact-xs'
                  variant='light'
                  onClick={() => openDialog(`/staging/categories/new?kind=${encodeURIComponent(kind)}`)}
                >
                  {KIND_LABELS[kind]}
                </Button>
              ))}
            </Group>
          </Stack>
        </Card>
      </SimpleGrid>
      {status.routesWaiting > 0 && (
        <Alert color='yellow' icon={<TablerIcon name='route' size={16} />} title='Needs you'>
          <Group justify='space-between' gap='sm'>
            <Text size='sm'>
              {status.routesWaiting === 1
                ? '1 GPS track waits for the device that recorded it.'
                : `${status.routesWaiting} GPS tracks wait for the devices that recorded them.`}
            </Text>
            <Button size='xs' variant='light' onClick={() => onOpen(status.defaultCategory, 'files')}>Choose device</Button>
          </Group>
        </Alert>
      )}
      <Stack gap={4}>
        <Text size='sm' c='dimmed'>Tens of thousands of files? Copy them over SFTP into a category's folder:</Text>
        <SftpPath path={`${stagingRoots(status.user).filesPath}/<category>/`} />
      </Stack>
      {moving && inbox && moving.action.type === 'move' && (
        <MoveDialog
          paths={[moving.path]}
          what={`“${moving.name}”`}
          categories={status.categories}
          from={inbox}
          toCategory
          initialCategory={moving.action.category}
          onClose={() => setMoving(null)}
          onMoved={() => {
            refreshStagingStatus();
            reload();
          }}
        />
      )}
    </Stack>
  );
}
