import type { DuplicateSet } from '@archive/media/api';
import type { StagingCategoryStatus } from '@archive/staging/api';
import type { FindEntry } from '@ein/api';
import { EmptyState, NodeBrowser, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { baseName, countOf, parentPath, type SearchFilters, shq } from '@ein/ui/lib';
import { addToQueue, invalidateListing, type MediaItem } from '@ein/ui/signals';
import { ActionIcon, Box, Button, FileButton, Group, Menu, SimpleGrid, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { DIRECTORY_GRID_COLS, DirectoryCard } from '../../media/components/DirectoryCard.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { cleanDir, dirOf, folderPath, NODES_VIEW, parentDir } from '../lib/folders.ts';
import { heldFiles } from '../lib/overview.ts';
import type { DetectHint } from '../lib/detect-hint.ts';
import { useDetectHints } from '../hooks/useDetectHints.ts';
import { useFileDuplicates } from '../hooks/useFileDuplicates.ts';
import { useSetActions } from '../hooks/useSetActions.ts';
import { CompareDialog } from './CompareDialog.tsx';
import { DetectHints } from './DetectHints.tsx';
import { DiscardDialog } from './DiscardDialog.tsx';
import { duplicateBadge } from './DuplicateBadge.tsx';
import { MoveDialog } from './MoveDialog.tsx';

/**
 * What the media view leaves out: the exact copies of an original their owner can read, which are
 * never indexed and are shown, with their original, on the Duplicates tab.
 */
const INDEXED_ONLY: SearchFilters = { missing: ['duplicate.deferred'] };

/** What a folder action asks for, and of which entries. */
type Pending = { action: 'folder' | 'category' | 'discard'; paths: string[]; what: string };

type Props = {
  category: StagingCategoryStatus;
  /** Every category, for Move to category. */
  categories: StagingCategoryStatus[];
  /** The default category's name: only there do folders arrive to be sorted, so only its tab gives hints. */
  defaultCategory: string;
  /** Changed after an upload, or a move or discard of the folder on screen, so the lists read again. */
  reloadToken: number;
  /** Files were moved, discarded or given a time. */
  onChanged: () => void;
};

/**
 * One category's files, a folder at a time (`?dir=` below the category, which the page's header
 * names in its trail): its subfolders as cards, then either its pictures, videos and recordings
 * however deep, by day (`search --within`, the exact copies that are not indexed left out), or with
 * **Nodes** in the header the Nodes page's pane over the folder (`?view=nodes`), every entry
 * whatever its type, held to the category and filling the page below its header, with a side panel
 * that moves the selection to another folder or category or discards it (as Delete does there). A
 * subfolder can be moved or discarded from its card; the folder on screen from the header's ⋮. A picture with identical files, in the
 * library or here, carries the Sort stream's badge with how many there are, which compares them. In the default category, a newly arrived folder that
 * looks like it came from one source (`staging detect`) says so above the folders, with a move to a
 * category and a new category for it.
 */
export function FilesTab({ category, categories, defaultCategory, reloadToken, onChanged }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  // A touch screen picks rows by a long press (NodeBrowser), so the hint says that instead of the keys.
  const touch = useMediaQuery('(pointer: coarse)', false, { getInitialValueInEffect: false });
  const location = useLocation();
  const dir = cleanDir(searchParams.get('dir'));
  const folderView = searchParams.get('view') === NODES_VIEW;
  const current = folderPath(category.path, dir);
  const [changes, setChanges] = useState(0);
  const reload = reloadToken + changes;
  const [pending, setPending] = useState<Pending | null>(null);

  const setParams = useCallback((change: (next: URLSearchParams) => void) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      change(next);
      return next;
    }, { replace: true, state: location.state });
  }, [setSearchParams, location.state]);
  const openDir = useCallback((next: string) => setParams((params) => next ? params.set('dir', next) : params.delete('dir')), [setParams]);

  const folders = useCommand<FindEntry[]>(`find ${shq(current)} -mindepth 1 -maxdepth 1 -type d`);
  // The folders are read again when what they hold changed; a new folder reads its own.
  const refetchFolders = folders.refetch;
  const readAt = useRef(reload);
  useEffect(() => {
    if (readAt.current === reload) return;
    readAt.current = reload;
    refetchFolders();
  }, [reload, refetchFolders]);
  const subfolders = useMemo(() => (folders.data ?? []).toSorted((a, b) => a.name.localeCompare(b.name)), [folders.data]);

  const { hints, dismiss } = useDetectHints(category.name === defaultCategory, defaultCategory, reload);
  const shownHints = useMemo(() => hints.filter((hint) => hint.path === current || hint.path.slice(0, hint.path.lastIndexOf('/')) === current), [hints, current]);
  const moveByHint = (hint: DetectHint) => setPending({ action: 'category', paths: [hint.path], what: `“${hint.name}”` });

  // What moved or went may be the folder on screen, or above it: then the page goes up to the
  // nearest folder that is still here.
  const changed = (paths: string[]) => {
    const gone = paths.map((path) => dirOf(category.path, path)).filter((each): each is string => each !== undefined);
    const leaving = gone.find((each) => dir === each || dir.startsWith(`${each}/`));
    if (leaving !== undefined) openDir(parentDir(leaving));
    // The Nodes view's listing is read again now, not when the folder's watch next reports.
    invalidateListing(...new Set(paths.map(parentPath)));
    setChanges((value) => value + 1);
    onChanged();
  };

  // The drawn tiles' copies and look-alikes, compared and resolved here; the files dropped leave the list.
  const duplicates = useFileDuplicates(reload);
  const [comparing, setComparing] = useState<DuplicateSet | null>(null);
  const rereadDuplicates = duplicates.reread;
  const setActions = useSetActions(
    category.path,
    useCallback(() => {
      rereadDuplicates();
      onChanged();
    }, [rereadDuplicates, onChanged]),
  );
  const renderOverlay = (item: MediaItem) => {
    const badge = duplicates.badge(item);
    return badge ? duplicateBadge(badge, () => setComparing(duplicates.setOf(item.path) ?? null)) : null;
  };

  const canChangeCategory = categories.length > 1;
  const actionItems = (paths: string[], what: string) => (
    <>
      <Menu.Item leftSection={<TablerIcon name='folder-symlink' size={16} />} onClick={() => setPending({ action: 'folder', paths, what })}>Move to folder…</Menu.Item>
      {canChangeCategory && (
        <Menu.Item leftSection={<TablerIcon name='category' size={16} />} onClick={() => setPending({ action: 'category', paths, what })}>Move to category…</Menu.Item>
      )}
      <Menu.Item leftSection={<TablerIcon name='trash' size={16} />} color='red' onClick={() => setPending({ action: 'discard', paths, what })}>Discard…</Menu.Item>
    </>
  );
  const actionsMenu = (paths: string[], what: string) => (
    <Menu position='bottom-end' shadow='md' withinPortal>
      <Menu.Target>
        <ActionIcon variant='subtle' color='gray' size='sm' aria-label={`Actions for ${what}`}>
          <TablerIcon name='dots' size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{actionItems(paths, what)}</Menu.Dropdown>
    </Menu>
  );

  const empty = heldFiles(category.counts) === 0 && dir === '';
  /** The selected entries in words: one by its name, more by how many. */
  const named = (paths: string[]) => paths.length === 1 ? `“${baseName(paths[0])}”` : countOf(paths.length, 'item', 'items');

  return (
    <Stack gap='md' px='md' style={folderView ? { flex: 1, minHeight: 0 } : undefined}>
      {empty
        ? (
          <EmptyState
            title={`Nothing in ${category.label} yet`}
            actions={
              <FileButton multiple onChange={(files) => files.length > 0 && addToQueue(files, category.uploadPath, { label: category.label })}>
                {(props) => <Button {...props} variant='light' leftSection={<TablerIcon name='upload' size={16} />}>Upload</Button>}
              </FileButton>
            }
          >
            <Stack gap='xs' align='center'>
              <Text size='sm'>
                Upload pictures, videos and recordings, or drop them anywhere on this page. They wait here, seen only by you, until you put them in an album.
              </Text>
              <Text size='sm' c='dimmed'>See Info for SFTP and phone backup.</Text>
            </Stack>
          </EmptyState>
        )
        : (
          <>
            <DetectHints hints={shownHints} onMove={canChangeCategory ? moveByHint : undefined} onDismiss={dismiss} />
            {!folderView && subfolders.length > 0 && (
              <SimpleGrid cols={DIRECTORY_GRID_COLS} spacing='sm'>
                {subfolders.map((folder) => (
                  <DirectoryCard
                    key={folder.path}
                    directory={{ name: folder.name, title: folder.name, path: folder.path, childCount: folder.childCount }}
                    menu={actionsMenu([folder.path], `“${folder.name}”`)}
                    onClick={() => openDir(dir ? `${dir}/${folder.name}` : folder.name)}
                  />
                ))}
              </SimpleGrid>
            )}
            {folderView
              ? (
                <Box
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    border: '1px solid var(--mantine-color-default-border)',
                    borderRadius: 'var(--mantine-radius-sm)',
                    overflow: 'hidden',
                  }}
                >
                  <NodeBrowser
                    path={current}
                    root={category.path}
                    onNavigate={(to) => openDir(dirOf(category.path, to) ?? '')}
                    onDelete={(paths) => setPending({ action: 'discard', paths, what: named(paths) })}
                    actions={({ selection }) => (
                      <Stack gap='xs'>
                        <Text size='sm'>
                          {selection.length > 0
                            ? `${named(selection)} selected.`
                            : touch
                            ? 'Select what to move or discard: press and hold one, then tap the others.'
                            : 'Select what to move or discard: click, Ctrl or Shift and click for more, Ctrl+A for all.'}
                        </Text>
                        <Group gap='xs'>
                          <Button
                            size='xs'
                            variant='default'
                            disabled={selection.length === 0}
                            onClick={() => setPending({ action: 'folder', paths: selection, what: named(selection) })}
                          >
                            Move to folder…
                          </Button>
                          {canChangeCategory && (
                            <Button
                              size='xs'
                              variant='default'
                              disabled={selection.length === 0}
                              onClick={() => setPending({ action: 'category', paths: selection, what: named(selection) })}
                            >
                              Move to category…
                            </Button>
                          )}
                          <Button
                            size='xs'
                            variant='light'
                            color='red'
                            disabled={selection.length === 0}
                            onClick={() => setPending({ action: 'discard', paths: selection, what: named(selection) })}
                          >
                            Discard…
                          </Button>
                        </Group>
                      </Stack>
                    )}
                  />
                </Box>
              )
              : (
                <MediaTimeline
                  key={current}
                  within={current}
                  filters={INDEXED_ONLY}
                  granularity='day'
                  reloadToken={reload}
                  emptyMessage={category.counts.other > 0 || subfolders.length > 0
                    ? 'No pictures, videos or recordings here. Nodes shows every file, whatever its type.'
                    : 'No pictures, videos or recordings here.'}
                  renderOverlay={renderOverlay}
                  selectionActions={({ selection, items, reload: reloadList }) => <SetTimeAction selection={selection} items={items} onApplied={reloadList} />}
                />
              )}
          </>
        )}

      {pending && pending.action !== 'discard' && (
        <MoveDialog
          paths={pending.paths}
          what={pending.what}
          categories={categories}
          from={category}
          toCategory={pending.action === 'category'}
          onClose={() => setPending(null)}
          onMoved={() => changed(pending.paths)}
        />
      )}
      <CompareDialog
        set={comparing}
        onClose={() => setComparing(null)}
        onResolve={(set, keep) => {
          setComparing(null);
          void setActions.resolve(set, keep);
        }}
        onSeparate={(set) => {
          setComparing(null);
          void setActions.keepApart(set);
        }}
      />
      {pending?.action === 'discard' && (
        <DiscardDialog
          paths={pending.paths}
          what={pending.what}
          onClose={() => setPending(null)}
          onChanged={() => changed(pending.paths)}
        />
      )}
    </Stack>
  );
}
