import type { StagingCategoryStatus, StagingStatus } from '@archive/staging/api';
import { stagingRoots } from '@archive/staging/paths';
import { EntityDetailHeader, type PageActions, PageLoader, TablerIcon, UploadDropzone } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { formatCount, type NodeChildEntry, shq } from '@ein/ui/lib';
import { currentUser, openDialog } from '@ein/ui/signals';
import { Alert, Badge, Box, Button, Group, Menu, Tabs, Text, UnstyledButton } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CategoryOverview } from '../components/CategoryOverview.tsx';
import { DoneTab } from '../components/DoneTab.tsx';
import { importRoute, settingsRoute } from '../components/CategoryCard.tsx';
import { FilesTab } from '../components/FilesTab.tsx';
import { GroupStream } from '../components/GroupStream.tsx';
import { DuplicatesTab } from '../components/DuplicatesTab.tsx';
import { ProgressStrip } from '../components/ProgressStrip.tsx';
import { useStagingStatus } from '../hooks/useStagingStatus.ts';
import { heldFiles } from '../lib/overview.ts';
import { mediaMoved } from '../../media/signals/album.ts';

const TABS = ['sort', 'duplicates', 'files', 'done'] as const;
type StagingTab = typeof TABS[number];
const isTab = (value: string | null): value is StagingTab => TABS.includes(value as StagingTab);

// Not `circle`: that fixes the badge's width to its height, which clips 1,903 to "1".
const Count = ({ value }: { value: number | undefined }) => value ? <Badge size='xs' variant='light'>{value.toLocaleString()}</Badge> : null;

const SUBTITLE = 'New media to sort before it joins the shared library. Only you can see it.';

/** The page of `category`, on `tab` when one is named. */
const categoryRoute = (category: string, tab?: string): string =>
  `/staging?c=${encodeURIComponent(category)}${tab && tab !== 'sort' ? `&tab=${encodeURIComponent(tab)}` : ''}`;

export const handle = { fullBleed: true, signedIn: true };

/**
 * `/staging`: the reader's private staging area. Without `?c=` it is the overview of its
 * categories, or with only one category that category's page. A category's page (`?c=<name>`) has
 * Sort, the stream of its suggested groups to decide one by one (`?g=` is the group under the
 * cursor); Duplicates, its exact copies to resolve; Files, its folders and files
 * (`?dir=`); and Done, what was decided in it, with Undo. Its header's Upload adds to today's
 * folder of the category, folders and all, and its title — the category's label, which names the
 * page — switches category. On the overview, files
 * dragged over the window raise a tile per category, and go into the folder of today of the one
 * they are dropped on.
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
  const open = useCallback((name: string | null, tab?: string) => navigate(name ? categoryRoute(name, tab) : '/staging'), [navigate]);

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
      eta={status.eta[category.name]}
      refetchStatus={refetch}
      onOpen={open}
    />
  );
}

type OverviewProps = {
  status: StagingStatus;
  eta: Record<string, number | undefined>;
  onOpen: (category: string, tab?: string) => void;
};

function Overview({ status, eta, onOpen }: OverviewProps) {
  return (
    <>
      <UploadDropzone
        keepFolders
        disabled={status.categories.length === 0}
        targets={status.categories.map((category) => ({ path: category.uploadPath, label: category.label, description: `files/${category.name}` }))}
      />
      <EntityDetailHeader
        title='Staging'
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>}
        flowContent
        actions={{
          items: [
            { label: 'Import media', icon: 'cloud-upload', button: true, onClick: () => openDialog(importRoute()) },
            { label: 'New category', icon: 'folder-plus', onClick: () => openDialog('/staging/categories/new') },
          ],
        }}
      />
      <Box py='lg'>
        <CategoryOverview status={status} eta={eta} onOpen={onOpen} />
      </Box>
    </>
  );
}

/** The header's title: the category's label, which opens a menu of the others, the overview and a new one. */
function CategorySwitcher({ status, category, onOpen }: { status: StagingStatus; category: StagingCategoryStatus; onOpen: (name: string | null) => void }) {
  return (
    <Menu position='bottom-start' shadow='md' withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label={`${category.label}: switch category`} style={{ font: 'inherit', color: 'inherit' }}>
          <Group gap={6} wrap='nowrap'>
            {category.label}
            <TablerIcon name='chevron-down' size={22} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {status.categories.map((each) => (
          <Menu.Item
            key={each.name}
            leftSection={<TablerIcon name={each.name === category.name ? 'check' : 'folder'} size={16} />}
            rightSection={<Text size='xs' c='dimmed'>{formatCount(heldFiles(each.counts))}</Text>}
            onClick={() => each.name !== category.name && onOpen(each.name)}
          >
            {each.label}
          </Menu.Item>
        ))}
        <Menu.Divider />
        {status.categories.length > 1 && <Menu.Item leftSection={<TablerIcon name='layout-grid' size={16} />} onClick={() => onOpen(null)}>All categories</Menu.Item>}
        <Menu.Item leftSection={<TablerIcon name='folder-plus' size={16} />} onClick={() => openDialog('/staging/categories/new')}>New category…</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

type CategoryPageProps = {
  user: string;
  status: StagingStatus;
  category: StagingCategoryStatus;
  eta?: number;
  refetchStatus: () => void;
  onOpen: (name: string | null, tab?: string) => void;
};

function CategoryPage({ user, status, category, eta, refetchStatus, onOpen }: CategoryPageProps) {
  useSignals();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const requested = searchParams.get('tab');
  const tab: StagingTab = isTab(requested) ? requested : 'sort';
  const roots = stagingRoots(user);
  // How many groups the category holds, for the Sort tab's badge: the child count of its directory
  // of groups, from one listing of the directories of groups.
  const groupDirs = useCommand<NodeChildEntry[]>(`ls -l ${shq(roots.albumsPath)}`);
  const refetchGroups = groupDirs.refetch;
  const [reloadToken, setReloadToken] = useState(0);
  const isDefault = category.name === status.defaultCategory;

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

  // Every change of tab replaces the entry and keeps its state, so Back leaves the page.
  const showTab = useCallback((value: string | null) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (!value || value === 'sort') next.delete('tab');
      else next.set('tab', value);
      return next;
    }, { replace: true, state: location.state });
  }, [setSearchParams, location.state]);

  const groupCount = groupDirs.data?.find((entry) => entry.name === category.name)?.childCount;
  const counts = category.counts;
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
    items: [
      { label: 'Import media…', icon: 'cloud-upload', onClick: () => openDialog(importRoute(category.name)) },
      { label: 'Category settings', icon: 'settings', onClick: () => openDialog(settingsRoute(category.name)) },
      ...(status.categories.length > 1 ? [{ label: 'All categories', icon: 'layout-grid', onClick: () => onOpen(null) }] : []),
    ],
  };

  return (
    <Tabs value={tab} keepMounted={false} onChange={showTab}>
      <EntityDetailHeader
        tabs={
          <Tabs.List>
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
            <Tabs.Tab value='files' leftSection={<TablerIcon name='files' size={16} />}>
              <Group gap={6}>
                Files <Count value={heldFiles(counts)} />
              </Group>
            </Tabs.Tab>
            <Tabs.Tab value='done' leftSection={<TablerIcon name='checks' size={16} />}>
              <Group gap={6}>
                Done <Count value={category.decided.filed + category.decided.discarded} />
              </Group>
            </Tabs.Tab>
          </Tabs.List>
        }
        eyebrow='Staging'
        title={<CategorySwitcher status={status} category={category} onOpen={onOpen} />}
        name={category.label}
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>}
        flowContent
        actions={actions}
      />

      <Box py='lg' style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <ProgressStrip category={category} eta={eta} />

        <Tabs.Panel value='sort'>
          <GroupStream
            category={category}
            onChanged={changed}
            onShowFiles={() => showTab('files')}
            stillIndexing={counts.indexing}
          />
        </Tabs.Panel>
        <Tabs.Panel value='duplicates'>
          <DuplicatesTab category={category} onChanged={refetchStatus} />
        </Tabs.Panel>
        <Tabs.Panel value='done'>
          <DoneTab category={category.name} onChanged={changed} />
        </Tabs.Panel>
        <Tabs.Panel value='files'>
          <FilesTab
            category={category}
            categories={status.categories}
            routesPath={isDefault ? roots.routesPath : undefined}
            reloadToken={reloadToken}
            onChanged={changed}
          />
        </Tabs.Panel>
      </Box>
    </Tabs>
  );
}
