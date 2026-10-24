import type { DuplicateSet } from '@archive/media/api';
import type { StagingCategoryStatus } from '@archive/staging/api';
import type { FindEntry } from '@ein/api';
import { EmptyState, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { countOf, type SearchFilters, shq } from '@ein/ui/lib';
import { type MediaItem, openDialog } from '@ein/ui/signals';
import { ActionIcon, Anchor, Box, Breadcrumbs, Button, Group, Menu, SegmentedControl, SimpleGrid, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { StagedRoutes } from '../../location/components/StagedRoutes.tsx';
import { DIRECTORY_GRID_COLS, DirectoryCard } from '../../media/components/DirectoryCard.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { cleanDir, crumbs, dirOf, folderPath, parentDir } from '../lib/folders.ts';
import { heldFiles, KIND_LABELS } from '../lib/overview.ts';
import type { DetectHint } from '../lib/detect-hint.ts';
import { useDetectHints } from '../hooks/useDetectHints.ts';
import { useFileDuplicates } from '../hooks/useFileDuplicates.ts';
import { useSetActions } from '../hooks/useSetActions.ts';
import { importRoute } from './CategoryCard.tsx';
import { CompareDialog } from './CompareDialog.tsx';
import { DetectHints } from './DetectHints.tsx';
import { DiscardDialog } from './DiscardDialog.tsx';
import { duplicateBadge } from './DuplicateBadge.tsx';
import { FolderList } from './FolderList.tsx';
import { MoveDialog } from './MoveDialog.tsx';
import { SftpPath } from './SftpPath.tsx';

/**
 * What the media view leaves out: the exact copies of an original their owner can read, which are
 * never indexed and are shown, with their original, on the Duplicates tab.
 */
const INDEXED_ONLY: SearchFilters = { missing: ['duplicate.deferred'] };

/** What a folder action asks for, and of which entries; a move to a category may name the one to offer first. */
type Pending = { action: 'folder' | 'category' | 'discard'; paths: string[]; what: string; category?: string };

type Props = {
  category: StagingCategoryStatus;
  /** Every category, for Move to category. */
  categories: StagingCategoryStatus[];
  /** The staging area's `routes/`, where GPX files wait for their device; asked about here when given. */
  routesPath?: string;
  /** Changed after an upload, so the lists read again. */
  reloadToken: number;
  /** Files were moved, discarded or given a time, or a route was given to its device. */
  onChanged: () => void;
};

/**
 * One category's files, a folder at a time (`?dir=` below the category): its subfolders as cards,
 * then either its pictures, videos and recordings however deep, by day (`search --within`, the
 * exact copies that are not indexed left out), or with **Folder** every entry of the folder
 * itself, whatever its type (`?view=folder`). A folder, or a selection in the folder list, can be
 * moved to another folder or category, or discarded. A picture that copies or looks like another,
 * in the library or here, or is kept over copies left out of the list, carries the Sort stream's
 * badge, which compares it with its set. In the default category, a newly arrived folder that
 * looks like it came from one source (`staging detect`) says so on its card and above the folders,
 * with the way to that source's category.
 */
export function FilesTab({ category, categories, routesPath, reloadToken, onChanged }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const dir = cleanDir(searchParams.get('dir'));
  const folderView = searchParams.get('view') === 'folder';
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
  const setView = (view: string) => setParams((params) => view === 'folder' ? params.set('view', 'folder') : params.delete('view'));

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

  // Only the default category is of the inbox kind, and only there do folders arrive to be sorted.
  const { hints, dismiss } = useDetectHints(category.kind === 'inbox', categories, category.name, reload);
  const shownHints = useMemo(() => hints.filter((hint) => hint.path === current || hint.path.slice(0, hint.path.lastIndexOf('/')) === current), [hints, current]);
  const hintAt = useMemo(() => new Map(shownHints.map((hint) => [hint.path, hint])), [shownHints]);
  const moveByHint = (hint: DetectHint) =>
    hint.action.type === 'move' && setPending({ action: 'category', paths: [hint.path], what: `“${hint.name}”`, category: hint.action.category });

  // What moved or went may be the folder on screen, or above it: then the page goes up to the
  // nearest folder that is still here.
  const changed = (paths: string[]) => {
    const gone = paths.map((path) => dirOf(category.path, path)).filter((each): each is string => each !== undefined);
    const leaving = gone.find((each) => dir === each || dir.startsWith(`${each}/`));
    if (leaving !== undefined) openDir(parentDir(leaving));
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
  const actionsMenu = (paths: string[], what: string, target: 'icon' | 'button') => (
    <Menu position='bottom-end' shadow='md' withinPortal>
      <Menu.Target>
        {target === 'icon'
          ? (
            <ActionIcon variant='subtle' color='gray' size='sm' aria-label={`Actions for ${what}`}>
              <TablerIcon name='dots' size={16} />
            </ActionIcon>
          )
          : <Button size='xs' variant='default' rightSection={<TablerIcon name='chevron-down' size={14} />}>Actions</Button>}
      </Menu.Target>
      <Menu.Dropdown>{actionItems(paths, what)}</Menu.Dropdown>
    </Menu>
  );

  const empty = heldFiles(category.counts) === 0 && dir === '';

  return (
    <Stack gap='md' px='md'>
      {routesPath && <StagedRoutes routes={routesPath} reloadToken={reload} onImported={onChanged} />}
      <Group justify='space-between' gap='sm' wrap='wrap'>
        <Breadcrumbs separator='›'>
          <Anchor component='button' type='button' size='sm' onClick={() => openDir('')}>{category.label}</Anchor>
          {crumbs(dir).map((crumb) => <Anchor key={crumb.dir} component='button' type='button' size='sm' onClick={() => openDir(crumb.dir)}>{crumb.name}</Anchor>)}
        </Breadcrumbs>
        <Group gap='xs'>
          {dir !== '' && actionsMenu([current], `“${crumbs(dir).at(-1)?.name}”`, 'button')}
          <SegmentedControl
            size='xs'
            value={folderView ? 'folder' : 'media'}
            onChange={setView}
            data={[{ value: 'media', label: 'Media' }, { value: 'folder', label: 'Folder' }]}
            aria-label='Show the media below this folder, or every entry in it'
          />
        </Group>
      </Group>

      {empty
        ? (
          <EmptyState
            title={`Nothing in ${category.label} yet`}
            actions={
              <Button variant='light' leftSection={<TablerIcon name='cloud-upload' size={16} />} onClick={() => openDialog(importRoute(category.name))}>Import media</Button>
            }
          >
            <Stack gap='xs' align='center'>
              <Text size='sm'>
                Upload pictures, videos and recordings, or drop them anywhere on this page. They wait here, seen only by you, until you put them in an album.
              </Text>
              <Text size='sm' c='dimmed'>Or copy them over SFTP into</Text>
              <SftpPath path={`${category.path}/`} />
            </Stack>
          </EmptyState>
        )
        : (
          <>
            <DetectHints hints={shownHints} onMove={moveByHint} onDismiss={dismiss} />
            {!folderView && subfolders.length > 0 && (
              <SimpleGrid cols={DIRECTORY_GRID_COLS} spacing='sm'>
                {subfolders.map((folder) => (
                  <DirectoryCard
                    key={folder.path}
                    directory={{ name: folder.name, title: folder.name, path: folder.path, childCount: folder.childCount }}
                    menu={actionsMenu([folder.path], `“${folder.name}”`, 'icon')}
                    note={hintAt.has(folder.path) ? KIND_LABELS[hintAt.get(folder.path)!.kind] : undefined}
                    onClick={() => openDir(dir ? `${dir}/${folder.name}` : folder.name)}
                  />
                ))}
              </SimpleGrid>
            )}
            {folderView
              ? (
                <Box>
                  <FolderList
                    key={current}
                    dir={current}
                    reloadToken={reload}
                    onOpen={(name) => openDir(dir ? `${dir}/${name}` : name)}
                    actions={(paths) => actionsMenu(paths, countOf(paths.length, 'item', 'items'), 'button')}
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
                    ? 'No pictures, videos or recordings here. Folder shows every file, whatever its type.'
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
          initialCategory={pending.category}
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
