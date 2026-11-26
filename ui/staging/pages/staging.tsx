import type { StagingCategoryStatus, StagingStatus } from '@archive/staging/api';
import { stagingRoots } from '@archive/staging/paths';
import { EntityDetailHeader, HeaderChoice, HeaderChoices, type PageAction, type PageActions, PageLoader, TablerIcon } from '@ein/ui/components';
import { useCommand, usePhone } from '@ein/ui/hooks';
import { type NodeChildEntry, parentPath, shq } from '@ein/ui/lib';
import { currentUser, invalidateListing, openDialog, openShortcutHelp } from '@ein/ui/signals';
import { Alert, Badge, Box, Button, Group, Tabs, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BackLink } from '../components/BackLink.tsx';
import { CategoryOverview } from '../components/CategoryOverview.tsx';
import { DoneTab } from '../components/DoneTab.tsx';
import { editRoute } from '../components/CategoryCard.tsx';
import { DiscardDialog } from '../components/DiscardDialog.tsx';
import { FilesTab } from '../components/FilesTab.tsx';
import { GenealogyCard } from '../components/GenealogyCard.tsx';
import { GroupStream, type SortBar } from '../components/GroupStream.tsx';
import { InfoTab } from '../components/InfoTab.tsx';
import { DuplicatesTab } from '../components/DuplicatesTab.tsx';
import { MoveDialog } from '../components/MoveDialog.tsx';
import { RoutesCard } from '../components/RoutesCard.tsx';
import { useStagingStatus } from '../hooks/useStagingStatus.ts';
import { cleanDir, crumbs, folderPath, NODES_VIEW, parentDir } from '../lib/folders.ts';
import { heldFiles } from '../lib/overview.ts';
import type { StagingLane } from '../lib/lanes.ts';
import { mediaMoved } from '../../media/signals/album.ts';

/** The tabs in the order they stand; the first is the one a category's page opens on. */
const TABS = ['files', 'sort', 'duplicates', 'done', 'info'] as const;
type StagingTab = typeof TABS[number];
const isTab = (value: string | null): value is StagingTab => TABS.includes(value as StagingTab);

// Not `circle`: that fixes the badge's width to its height, which clips 1,903 to "1".
const Count = ({ value }: { value: number | undefined }) => value ? <Badge size='xs' variant='light'>{value.toLocaleString()}</Badge> : null;

const SUBTITLE = 'New media to sort before it joins the shared library. Only you can see it.';

const LANE_ICONS: Record<StagingLane, string> = { sort: 'arrows-sort', everyday: 'calendar', undated: 'calendar-question', clutter: 'photo-x' };

/** The page of `category`: its Files tab, at the folder `dir` below it (none: the category itself), in the Nodes view when asked. */
const categoryRoute = (category: string, dir = '', nodes = false): string => {
  const params = new URLSearchParams({ c: category });
  if (dir) params.set('dir', dir);
  if (nodes) params.set('view', NODES_VIEW);
  return `/staging?${params}`;
};

export const handle = { fullBleed: true, signedIn: true };

/**
 * `/staging`: the reader's private staging area. Without `?c=` it is the overview of its
 * categories, or with only one category that category's page. A category's page (`?c=<name>`) has
 * Files, its folders and files (`?dir=`), the tab it opens on; Sort, the stream of its suggested
 * groups to decide one by one (`?tab=sort`, `?g=` the group under the cursor), whose lane
 * (`?lane=`) and order (`?order=new`) are chosen at the right of the header's tabs; Duplicates, its
 * exact copies to resolve; Done, what was decided in it, with Undo; and Info, how files get into
 * it. Its header's back link leads to Staging, and on Files inside a folder to the folder above
 * the one on screen, which then names the page; its Upload adds files to today's folder of the
 * category, and a drop on it folders and all; its Edit renames or removes the category. The
 * overview uploads nothing: its one action is New category.
 */
export default function StagingPage() {
  useSignals();
  const user = currentUser.value?.username;
  if (!user) return <Alert color='yellow' m='lg'>Sign in to use your private staging area.</Alert>;
  return <Staging user={user} />;
}

function Staging({ user }: { user: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const status = useStagingStatus(user);
  const { data, refetch } = status;
  const slug = searchParams.get('c');
  const category = slug ? data?.categories.find((each) => each.name === slug) : undefined;

  // With one category there is nothing to choose between: its page stands in for the overview.
  const only = data?.initialized && data.categories.length === 1 ? data.categories[0].name : undefined;
  useEffect(() => {
    if (!slug && only) setSearchParams({ c: only }, { replace: true, state: location.state });
  }, [slug, only, setSearchParams, location.state]);

  // A category made since the status was read (in a dialog, or from a terminal) is read once more.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !slug || category || askedFor.current === slug) return;
    askedFor.current = slug;
    refetch();
  }, [data, slug, category, refetch]);

  // Leaving the overview for a category, or one category for another, is a step Back undoes.
  const open = useCallback((name: string | null) => navigate(name ? categoryRoute(name) : '/staging'), [navigate]);

  if (status.error && !data) return <Alert color='red' m='lg'>{status.error.message}</Alert>;
  if (!data || (!slug && only) || (slug && !category && (status.loading || askedFor.current !== slug))) return <PageLoader label='Reading your staging area…' />;
  if (!slug) return <Overview status={data} eta={status.eta} onOpen={open} />;
  if (!category) {
    return (
      <Alert color='yellow' m='lg' title={`No category ${slug}`}>
        <Button mt='sm' size='xs' variant='light' onClick={() => open(null)}>All categories</Button>
      </Alert>
    );
  }
  return (
    <CategoryPage
      key={category.name}
      user={user}
      status={data}
      category={category}
      refetchStatus={refetch}
    />
  );
}

type OverviewProps = {
  status: StagingStatus;
  eta: Record<string, number | undefined>;
  onOpen: (category: string) => void;
};

function Overview({ status, eta, onOpen }: OverviewProps) {
  return (
    <>
      <EntityDetailHeader
        title='Staging'
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>}
        flowContent
        actions={{
          items: [{ label: 'New category', icon: 'folder-plus', button: true, onClick: () => openDialog('/staging/categories/new') }],
        }}
      />
      <Box py='lg'>
        <CategoryOverview status={status} eta={eta} onOpen={onOpen} />
      </Box>
    </>
  );
}

type CategoryPageProps = {
  user: string;
  status: StagingStatus;
  category: StagingCategoryStatus;
  refetchStatus: () => void;
};

/** What a header action on the folder on screen asks for: a move to a folder or a category, or the discard. */
type FolderAction = 'folder' | 'category' | 'discard';

function CategoryPage({ user, status, category, refetchStatus }: CategoryPageProps) {
  useSignals();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const requested = searchParams.get('tab');
  const tab: StagingTab = isTab(requested) ? requested : TABS[0];
  const nodes = searchParams.get('view') === NODES_VIEW;
  // The folder the Files tab is on, which names the page and its ⋮ acts on.
  const dir = tab === 'files' ? cleanDir(searchParams.get('dir')) : '';
  const folders = crumbs(dir);
  const folder = folders.at(-1);
  // The Files tab's Nodes view is a file manager's pane, and the Sort tab on a wider screen is a
  // stream scrolled by itself: the page is the window's height, and the tab takes what the header
  // leaves rather than the page scrolling.
  const phone = usePhone();
  const fill = (tab === 'files' && nodes) || (tab === 'sort' && !phone);
  const filling: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
  const roots = stagingRoots(user);
  // How many groups the category holds, for the Sort tab's badge: the child count of its directory
  // of groups, from one listing of the directories of groups.
  const groupDirs = useCommand<NodeChildEntry[]>(`ls -lC ${shq(roots.albumsPath)}`);
  const refetchGroups = groupDirs.refetch;
  const [reloadToken, setReloadToken] = useState(0);
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [sortBar, setSortBar] = useState<SortBar | null>(null);

  // A staged file put in an album from a list on this page has left the inbox.
  const moved = mediaMoved.value;
  const handledMove = useRef(moved?.at);
  useEffect(() => {
    if (!moved || moved.at === handledMove.current) return;
    handledMove.current = moved.at;
    refetchStatus();
  }, [moved, refetchStatus]);

  const changed = useCallback(() => {
    refetchStatus();
    refetchGroups();
  }, [refetchStatus, refetchGroups]);

  // GPX and GEDCOM files wait outside every category, to be sorted like what arrives in the default
  // category: its Sort tab heads its groups with a card for each, as does a category that is the only one.
  const waiting = (category.name === status.defaultCategory || status.categories.length === 1) && (
    <>
      {status.routesWaiting > 0 && <RoutesCard user={user} onChanged={refetchStatus} />}
      <GenealogyCard count={status.genealogyWaiting} />
    </>
  );

  // Every change of tab, view or folder here replaces the entry and keeps its state, so Back leaves the page.
  const setParams = useCallback((change: (next: URLSearchParams) => void) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      change(next);
      return next;
    }, { replace: true, state: location.state });
  }, [setSearchParams, location.state]);
  const showTab = useCallback((value: string | null) => {
    setParams((next) => {
      if (!value || value === TABS[0]) next.delete('tab');
      else next.set('tab', value);
    });
  }, [setParams]);
  const setView = (view: string) => setParams((next) => view === NODES_VIEW ? next.set('view', NODES_VIEW) : next.delete('view'));
  const order = searchParams.get('order') === 'new' ? 'new' : 'old';
  const setLane = (value: string) => setParams((next) => value === 'sort' ? next.delete('lane') : next.set('lane', value));
  const setOrder = (value: string) => setParams((next) => value === 'new' ? next.set('order', 'new') : next.delete('order'));

  // The folder `gone` moved or went (or came back, undone): a page still on it, or below it, goes up
  // to the folder that held it, and the lists are read again.
  const folderGone = (gone: string) => () => {
    setParams((next) => {
      const now = cleanDir(next.get('dir'));
      if (now !== gone && !now.startsWith(`${gone}/`)) return;
      const up = parentDir(gone);
      if (up) next.set('dir', up);
      else next.delete('dir');
    });
    invalidateListing(parentPath(folderPath(category.path, gone)));
    setReloadToken((value) => value + 1);
    changed();
  };

  // A category's groups, without the organizer's own files beside them (`.organizer`, `.request`).
  const groupCount = groupDirs.data?.find((entry) => entry.name === category.name)?.children?.filter((child) => !child.name.startsWith('.')).length;
  const counts = category.counts;
  const folderItems: PageAction[] = folder
    ? [
      { label: 'Move to folder…', icon: 'folder-symlink', onClick: () => setFolderAction('folder') },
      ...(status.categories.length > 1 ? [{ label: 'Move to category…', icon: 'category', onClick: () => setFolderAction('category') }] : []),
      { label: 'Discard…', icon: 'trash', color: 'red', onClick: () => setFolderAction('discard') },
    ]
    : [];
  const actions: PageActions = {
    // In the header rather than one tab, so its drop target covers the window on every tab:
    // whatever is being sorted, new files land in the category on screen.
    upload: {
      path: category.uploadPath,
      name: category.label,
      keepFolders: true,
      onUploaded: () => {
        refetchStatus();
        setReloadToken((value) => value + 1);
      },
    },
    edit: () => openDialog(editRoute(category.name)),
    items: [
      ...folderItems,
      { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: openShortcutHelp },
    ],
  };
  // Back to Staging; inside a folder, to the folder above it, the category itself at the first level.
  const up = folders.at(-2);
  const back = !folder
    ? { label: 'Staging', to: '/staging' }
    : up
    ? { label: up.name, to: categoryRoute(category.name, up.dir, nodes) }
    : { label: category.label, to: categoryRoute(category.name, '', nodes) };

  return (
    <Tabs
      value={tab}
      keepMounted={false}
      onChange={showTab}
      style={fill ? { height: 'calc(100dvh - var(--app-shell-header-height))', display: 'flex', flexDirection: 'column' } : undefined}
    >
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='files' leftSection={<TablerIcon name='files' size={16} />}>
              <Group gap={6}>
                Files <Count value={heldFiles(counts)} />
              </Group>
            </Tabs.Tab>
            <Tabs.Tab value='sort' leftSection={<TablerIcon name='arrows-sort' size={16} />}>
              <Group gap={6}>
                Sort <Count value={groupCount} />
              </Group>
            </Tabs.Tab>
            <Tabs.Tab value='duplicates' leftSection={<TablerIcon name='copy' size={16} />}>
              <Group gap={6}>
                Duplicates <Count value={counts.copies.library + counts.copies.inbox} />
              </Group>
            </Tabs.Tab>
            <Tabs.Tab value='done' leftSection={<TablerIcon name='checks' size={16} />}>
              <Group gap={6}>
                Done <Count value={category.decided.filed + category.decided.discarded} />
              </Group>
            </Tabs.Tab>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
          </Tabs.List>
        }
        controls={tab === 'files'
          ? (
            <HeaderChoice
              label='Show'
              variant='segmented'
              value={nodes ? NODES_VIEW : 'media'}
              onChange={setView}
              options={[
                { value: 'media', label: 'Media', icon: <TablerIcon name='photo' size={18} /> },
                { value: NODES_VIEW, label: 'Nodes', icon: <TablerIcon name='list-tree' size={18} /> },
              ]}
            />
          )
          : tab === 'sort' && sortBar
          ? (
            <>
              {sortBar.applying > 0 && <Text size='xs' c='dimmed'>◌ {sortBar.applying.toLocaleString()} applying</Text>}
              {sortBar.lanes.length < 2 && <Text size='sm' c='dimmed'>{sortBar.summary}</Text>}
              <HeaderChoices label='Lane and order'>
                {sortBar.lanes.length > 1 && (
                  <HeaderChoice
                    label='Show'
                    variant='segmented'
                    value={sortBar.lane}
                    onChange={setLane}
                    options={sortBar.lanes.map((each) => ({
                      value: each.id,
                      label: `${each.label} ${each.groups.toLocaleString()}`,
                      icon: <TablerIcon name={LANE_ICONS[each.id]} size={18} />,
                    }))}
                  />
                )}
                <HeaderChoice
                  label='Order'
                  value={order}
                  onChange={setOrder}
                  options={[
                    { value: 'old', label: 'Oldest first', icon: <TablerIcon name='sort-ascending' size={18} /> },
                    { value: 'new', label: 'Newest first', icon: <TablerIcon name='sort-descending' size={18} /> },
                  ]}
                />
              </HeaderChoices>
            </>
          )
          : undefined}
        eyebrow={<BackLink to={back.to} label={back.label} />}
        title={folder ? folder.name : category.label}
        name={folder ? `${category.label}/${dir}` : category.label}
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>}
        flowContent
        actions={actions}
      />

      {/* On a wider screen the Sort tab's stream reaches from the header to the window's foot. */}
      <Box
        pt={tab === 'sort' && fill ? 0 : 'lg'}
        pb={tab === 'sort' && fill ? 0 : fill ? 'md' : 'lg'}
        style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)', ...(fill ? filling : {}) } as CSSProperties}
      >
        <Tabs.Panel value='files' style={fill ? filling : undefined}>
          <FilesTab
            category={category}
            categories={status.categories}
            defaultCategory={status.defaultCategory}
            reloadToken={reloadToken}
            onChanged={changed}
          />
        </Tabs.Panel>
        <Tabs.Panel value='sort' style={fill ? filling : undefined}>
          <GroupStream
            category={category}
            onChanged={changed}
            onShowFiles={() => showTab('files')}
            stillIndexing={counts.indexing}
            onBar={setSortBar}
            lead={waiting}
          />
        </Tabs.Panel>
        <Tabs.Panel value='duplicates'>
          <DuplicatesTab category={category} onChanged={refetchStatus} />
        </Tabs.Panel>
        <Tabs.Panel value='done'>
          <DoneTab category={category.name} onChanged={changed} />
        </Tabs.Panel>
        <Tabs.Panel value='info'>
          <InfoTab category={category} />
        </Tabs.Panel>
      </Box>

      {folder && folderAction && folderAction !== 'discard' && (
        <MoveDialog
          paths={[folderPath(category.path, dir)]}
          what={`“${folder.name}”`}
          categories={status.categories}
          from={category}
          toCategory={folderAction === 'category'}
          onClose={() => setFolderAction(null)}
          onMoved={folderGone(dir)}
        />
      )}
      {folder && folderAction === 'discard' && (
        <DiscardDialog
          paths={[folderPath(category.path, dir)]}
          what={`“${folder.name}”`}
          onClose={() => setFolderAction(null)}
          onChanged={folderGone(dir)}
        />
      )}
    </Tabs>
  );
}
