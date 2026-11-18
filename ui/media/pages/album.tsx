import { EventModal } from '../../people/components/EventModal.tsx';
import { AlbumInfoTab } from '../components/AlbumInfoTab.tsx';
import { AlbumMap } from '../components/AlbumMap.tsx';
import { AlbumTripTab } from '../components/AlbumTripTab.tsx';
import { AlbumSeriesLinks } from '../components/AlbumSeriesLinks.tsx';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { NodeLabels } from '../../components/NodeLabels.tsx';
import { MoveToAlbumAction } from '../components/MoveToAlbumAction.tsx';
import { SetCoverAction } from '../components/SetCoverAction.tsx';
import { SetTimeAction } from '../components/SetTimeAction.tsx';
import { StackAction } from '../components/StackAction.tsx';
import {
  EntityDetailHeader,
  FillWindow,
  formatRange,
  GRID_GAP,
  hasPills,
  HeaderChoices,
  HeaderDescription,
  HeaderFilterBar,
  type PillKind,
  SearchInput,
  SearchPills,
  ShareSelectionAction,
  SharingChip,
  TablerIcon,
} from '@ein/ui/components';
import { Alert, Badge, Box, Button, Group, Loader, SimpleGrid, Stack, Tabs, Text, Tooltip } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { AlbumSortSelect, useAlbumSort } from '../components/AlbumSort.tsx';
import { DIRECTORY_GRID_COLS, DirectoryCard } from '../components/DirectoryCard.tsx';
import type { AlbumScores, RawSortReport } from '@archive/media/api';
import { setAutoAlbumPinned, useAutoAlbum } from '../hooks/useAutoAlbums.ts';
import { forgetSubjectFacets, useSubjectFacets } from '../../hooks/useSubjectFacets.ts';
import { hasAnyFilter, MEDIA_KIND_FILTERS, type SearchFilters, type SearchKind, useAccessIds, useSearchBox, useShowOn } from '@ein/ui/hooks';
import { useAlbumDirectories } from '../hooks/useAlbumDirectories.ts';
import { useAlbumInfo } from '../hooks/useAlbumInfo.ts';
import { useAlbumPeople } from '../hooks/useAlbumPeople.ts';
import { useAlbumRaw } from '../hooks/useAlbumRaw.ts';
import { useAlbumSeries } from '../hooks/useAlbumSeries.ts';
import { useFreeEventDate } from '../hooks/useFreeEventDate.ts';
import { AlbumEditModal } from '../components/AlbumEditModal.tsx';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { albumRoute, stagingGroupRoute } from '../lib/album-path.ts';
import { MediaFilters } from '../components/MediaFilters.tsx';
import { mediaTypeFilter } from '../signals/album.ts';
import { screenSlideshow, SLIDESHOW_KEYS } from '../lib/slideshow-search.ts';
import { canWrite, filtersFromParams, isGuest, type MentionChoices, type MentionKind, paramsFromFilters, shq } from '@ein/ui/lib';
import { usePeople } from '../../people/hooks/usePeople.ts';
import { useLocations } from '../../location/hooks/useLocations.ts';
import { LOCATIONS_ROOT } from '@archive/paths';
import { currentUser, execCommand, notify, sharingChanged } from '@ein/ui/signals';

/**
 * The per-signal breakdown behind the overall match, in the order it is worth
 * reading. Each is the album's own cohesion on that signal, not a comparison —
 * "people 100%" means every photo with anyone in it has the same cast.
 */
const SIGNALS: [keyof AlbumScores, string, string][] = [
  ['temporal', 'Time', 'How tightly packed in time these are'],
  ['location', 'Location', 'How close together they were taken'],
  ['people', 'People', 'How consistently the same people appear'],
  ['visual', 'Look', 'How visually similar the images are'],
  ['semantic', 'Subject', 'How closely their descriptions agree'],
];

const TABS = ['media', 'trip', 'map', 'info'] as const;
type AlbumTab = typeof TABS[number];

const isTab = (value: string | null): value is AlbumTab => value !== null && (TABS as readonly string[]).includes(value);

/** What an `@` in the album's search box picks. Not an album: the search stays in this one. */
const MENTION_KINDS: readonly MentionKind[] = ['person', 'location', 'label'];

export const handle = { fullBleed: true };

/** How confidently the organizer grouped a suggested album. */
const matchBadge = (overall: number) => (
  <Tooltip label='How confidently these were grouped together'>
    <Badge size='lg' variant='filled' color={overall >= 0.8 ? 'green' : overall >= 0.6 ? 'yellow' : 'gray'}>
      {Math.round(overall * 100)}% match
    </Badge>
  </Tooltip>
);

export default function AlbumDetailPage() {
  useSignals();

  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // The media are what an album is for, so it opens on them; the trip, the map and the info are linkable.
  const tab: AlbumTab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as AlbumTab : 'media';
  const setTab = (value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== 'media') next.set('tab', value);
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  // The search box narrows the media to the people, locations and labels picked with `@` and ranks
  // them by the words; the URL carries it, so a person's timeline can link to the album narrowed
  // to them. The album itself is not one of its filters: it is always this one.
  const filters = useMemo((): SearchFilters => ({ ...filtersFromParams(searchParams), under: undefined }), [searchParams]);
  // Only the filters' own keys are replaced: the tab and an open lightbox keep theirs.
  const apply = useCallback((next: SearchFilters) => {
    const params = new URLSearchParams(searchParams);
    for (const key of paramsFromFilters(filters).keys()) params.delete(key);
    for (const [key, value] of paramsFromFilters({ ...next, under: undefined })) params.append(key, value);
    setSearchParams(params, { replace: true });
  }, [setSearchParams, searchParams, filters]);
  const box = useSearchBox({ filters, apply });
  const showOn = useShowOn();
  const searched = hasAnyFilter(filters);
  const ranked = Boolean(filters.query?.trim());
  const [searching, setSearching] = useState(false);
  const { people } = usePeople();
  const { locations } = useLocations(LOCATIONS_ROOT, { withCoordinates: false });
  const nameOf = useCallback((kind: PillKind, value: string): string | undefined => {
    if (kind === 'person') return people.find((person) => person.id === value)?.name;
    if (kind === 'location') return locations.find((location) => location.id === value)?.name;
    return undefined;
  }, [people, locations]);

  const albumPath = id ? decodeURIComponent(id) : '/';
  // Another album — a folder, the next in a series — opens with the box as its address has it.
  // `@` offers the people in this album's pictures, not everyone in the archive.
  const albumPeople = useAlbumPeople(albumPath);
  const choices = useMemo((): MentionChoices => ({ person: albumPeople }), [albumPeople]);
  const { setText, setMentions } = box;
  useEffect(() => {
    setText(filters.query ?? '');
    setMentions([]);
  }, [albumPath]);
  const { info, refetch: refetchInfo } = useAlbumInfo(albumPath);
  const { series, refetch: refetchSeries } = useAlbumSeries(albumPath);
  // Changing the album — its details, sharing, events, stacks, cover, uploads, putting it in the
  // trash — is for whoever may write it; anyone else gets it to look at.
  const access = useAccessIds();
  const editable = info.ownership !== undefined && canWrite(info.ownership, access);
  const [editing, setEditing] = useState(false);

  // Non-null only for an album the clusterer made, which is what says whether
  // this page shows the grouping's reasoning and whether an upload belongs here.
  const { autoAlbum: suggested, refetch: refetchSuggested } = useAutoAlbum(albumPath);
  // One of the reader's own suggestions is decided in the Sort stream, which opens on it.
  const sortRoute = suggested ? stagingGroupRoute(albumPath, currentUser.value?.username ?? '') : undefined;

  const [sort, setSort] = useAlbumSort();
  const [addingEvent, setAddingEvent] = useState(false);
  const [eventReload, setEventReload] = useState(0);

  const togglePinned = async () => {
    await setAutoAlbumPinned(albumPath, !suggested?.pinned);
    refetchSuggested();
  };

  // Only the subfolders come from the listing; the media is paged in by the
  // `search --under` facet, which is what orders and dates it. The listing also
  // says where this album keeps its media, which is where an upload belongs.
  const { directories, contentPath, loading: directoriesLoading, refetch: refetchDirectories } = useAlbumDirectories(albumPath);

  // Bumped when what the list shows changed under it, so it reads it again. After an upload, the
  // pipeline has to read each file's date before the timeline can place it, so this catches
  // whatever was quick, not everything.
  const [listChanges, setListChanges] = useState(0);
  const handleUploaded = useCallback(() => {
    setListChanges((n) => n + 1);
    refetchDirectories();
  }, [refetchDirectories]);

  // Camera RAWs that have a picture of the same name are offered to be filed under it, as a
  // version, which takes them out of the album, its search and its people.
  const { sortable: rawSortable, refetch: refetchRaw } = useAlbumRaw(albumPath, editable);
  const hideRaw = async () => {
    try {
      const report = await execCommand<RawSortReport>(`raw --sort ${shq(albumPath)}`);
      const kept = report.left.length + report.ambiguous.length;
      notify({
        message: [
          `${report.sorted.length} RAW ${report.sorted.length === 1 ? 'file' : 'files'} filed under ${report.sorted.length === 1 ? 'its picture' : 'their pictures'}`,
          ...(kept ? [`${kept} without a picture of the same name ${kept === 1 ? 'stays' : 'stay'}`] : []),
          ...(report.errors.length ? [`${report.errors.length} could not be moved: ${report.errors[0].error}`] : []),
        ].join('; '),
        color: report.errors.length ? 'red' : undefined,
      });
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
    setListChanges((n) => n + 1);
    forgetSubjectFacets();
    refetchRaw();
  };

  // The chip under the title says how the album is shared, and the locks on its tiles which of
  // what it holds keeps its own sharing; both are read again when the sharing of the album, of a
  // folder above it, or of something in it changes.
  const changed = sharingChanged.value;
  useEffect(() => {
    if (!changed) return;
    const above = changed.path === albumPath || albumPath.startsWith(`${changed.path}/`);
    if (above) refetchInfo();
    if (above || changed.path.startsWith(`${albumPath}/`)) {
      setListChanges((n) => n + 1);
      refetchDirectories();
    }
  }, [changed]);

  // What this album holds, so its type filter offers only that. Asked without a
  // kind of its own — the counts must not move as the filter is used, or the
  // control would delete its own options as they are chosen.
  const { facets } = useSubjectFacets({ under: albumPath });
  const available = useMemo(() => facets?.kinds.map((bucket) => bucket.kind), [facets]);
  const days = useMemo(() => facets?.days.map((day) => day.key), [facets]);
  const eventDate = useFreeEventDate(albumPath, days, addingEvent);

  const kinds = useMemo((): SearchKind[] | undefined => {
    const entry = MEDIA_KIND_FILTERS.find((filter) => filter.value === mediaTypeFilter.value);
    return !entry || entry.value === 'all' ? undefined : [...entry.kinds];
  }, [mediaTypeFilter.value]);

  // The album's slideshow on a screen or speaker, of the media as narrowed and ordered here, with
  // the slideshow's keys for a screen's controls.
  const slideshowTarget = {
    path: screenSlideshow(paramsFromFilters({ ...filters, under: albumPath, kinds }), { oldest: sort === 'oldest' }),
    title: info.title,
    keys: SLIDESHOW_KEYS,
    kind: 'Album',
  };
  const showOnItems = showOn ? [{ label: 'Show on…', icon: 'device-tv', onClick: () => showOn(slideshowTarget) }] : [];

  // `keepMounted={false}`: the media tab is the expensive one, and a Leaflet map mounted in a
  // hidden panel measures itself as zero-sized.
  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      {/* Header. A suggested album adds why it was grouped and how to take it over. */}
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='media' leftSection={<TablerIcon name='photo' size={16} />}>Media</Tabs.Tab>
            {/* An album made of a trip of a track (`trip-album`). */}
            {info.trip && <Tabs.Tab value='trip' leftSection={<TablerIcon name='map-route' size={16} />}>Trip</Tabs.Tab>}
            <Tabs.Tab value='map' leftSection={<TablerIcon name='map' size={16} />}>Map</Tabs.Tab>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
          </Tabs.List>
        }
        path={albumPath}
        pattern='album'
        // Listing-page height, like Search and Albums: the album's media are what the page is for.
        flowContent
        // The neighbours in a series lead, above the dates and the title, so the series reads as the way in and on.
        eyebrow={
          <>
            <AlbumSeriesLinks series={series} />
            {info.timeStart && <Text size='sm' c='white'>{formatRange(info.timeStart, info.timeEnd)}</Text>}
          </>
        }
        title={info.title}
        fallback={<TablerIcon name='calendar-event' size={52} />}
        subtitle={info.description && <HeaderDescription text={info.description} heading={info.title} c='dimmed' pattern='album' />}
        meta={
          <>
            {suggested && (
              <>
                <Group gap='xs' mt={4}>
                  {suggested.timeStart && (
                    <Badge variant='light' leftSection={<TablerIcon name='calendar-event' size={12} />}>
                      {formatRange(suggested.timeStart, suggested.timeEnd)}
                    </Badge>
                  )}
                  {suggested.kind === 'trip' && (
                    <Tooltip label={`${suggested.days} days away from home, rolled up from ${suggested.parts} parts of a day`}>
                      <Badge variant='light' color='blue' leftSection={<TablerIcon name='route' size={12} />}>
                        Trip · {suggested.days} days · {suggested.parts} parts
                      </Badge>
                    </Tooltip>
                  )}
                  {suggested.locationPath && (
                    <Badge
                      variant='light'
                      color='teal'
                      leftSection={<TablerIcon name='map-pin' size={12} />}
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/locations/${encodeURIComponent(suggested.locationPath!)}`)}
                    >
                      {suggested.locationName}
                    </Badge>
                  )}
                  {suggested.memberCount !== undefined && <Text size='sm' c='dimmed'>{suggested.memberCount} items</Text>}
                  {suggested.pinned && (
                    <Tooltip label='You keep this album as it is, so the organizer leaves it alone'>
                      <Badge variant='light' color='grape' leftSection={<TablerIcon name='pin' size={12} />}>Yours</Badge>
                    </Tooltip>
                  )}
                  {suggested.provisional && (
                    <Tooltip label='Some of this media is still being indexed — the grouping may still change'>
                      <Badge variant='light' color='yellow' leftSection={<TablerIcon name='hourglass' size={12} />}>Still indexing</Badge>
                    </Tooltip>
                  )}
                  {sortRoute && (
                    <Button
                      component={Link}
                      to={sortRoute}
                      size='compact-xs'
                      variant='light'
                      leftSection={<TablerIcon name='arrows-sort' size={12} />}
                    >
                      Sort in Staging
                    </Button>
                  )}
                </Group>
                {/* Why these ended up together, signal by signal. */}
                <Group gap={6} mt={8}>
                  {SIGNALS.map(([key, label, explain]) => {
                    const value = suggested.scores?.[key];
                    if (value === undefined) return null;
                    return (
                      <Tooltip key={key} label={explain}>
                        <Badge size='sm' variant='outline' color={value >= 0.7 ? 'green' : value >= 0.4 ? 'yellow' : 'gray'}>
                          {label} {Math.round(value * 100)}%
                        </Badge>
                      </Tooltip>
                    );
                  })}
                </Group>
              </>
            )}
            <Group gap='xs' mt={8} wrap='wrap'>
              {/* A visitor is not told who else may see it. */}
              {info.ownership && access && !isGuest(access) && <SharingChip path={albumPath} ownership={info.ownership} />}
              <NodeLabels path={albumPath} />
            </Group>
            {/* Unfiltered, the only limit the album's facets can reach is the container's own ceiling. */}
            {facets?.truncated && <Text size='sm' c='dimmed' mt={8}>This album holds more than 20,000 entries; 20,000 of them are shown.</Text>}
          </>
        }
        // A suggested album is the organizer's until it is kept: it takes no uploads, and is dropped
        // by letting the organizer have it rather than by the trash.
        actions={editable
          ? {
            upload: suggested ? undefined : { path: contentPath, name: info.title, disabled: directoriesLoading, onUploaded: handleUploaded },
            share: albumPath,
            edit: () => setEditing(true),
            items: [
              { label: 'Add event', icon: 'calendar-event', onClick: () => setAddingEvent(true) },
              ...(rawSortable > 0 ? [{ label: `Hide RAW files (${rawSortable})`, icon: 'stack-back', onClick: () => void hideRaw() }] : []),
              ...(suggested
                ? [{ label: suggested.pinned ? 'Let the organizer manage album' : 'Keep album as is', icon: suggested.pinned ? 'pinned-off' : 'pin', onClick: togglePinned }]
                : []),
              ...showOnItems,
            ],
            nearby: slideshowTarget,
            trash: suggested ? undefined : { path: albumPath, name: info.title, leaveTo: '/albums' },
          }
          : { items: showOnItems, nearby: slideshowTarget }}
        // The search box above the tabs, where it has the width.
        controlsAbove
        controls={tab === 'media'
          ? (
            // How the media are searched, narrowed and ordered: the other tabs have no list for them to act on.
            <HeaderFilterBar
              wide
              input={
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <SearchInput
                    value={box.text}
                    onChange={box.setText}
                    mentions={box.mentions}
                    onMentionsChange={box.setMentions}
                    onCommit={box.commit}
                    filters={filters}
                    kinds={MENTION_KINDS}
                    choices={choices}
                    size='md'
                    placeholder='Search the album — words, or type @ to pick someone'
                    shortPlaceholder='Search the album…'
                    rightSection={searching ? <Loader size={16} /> : undefined}
                    pills={hasPills(filters) ? <SearchPills filters={filters} onPatch={box.patch} nameOf={nameOf} /> : undefined}
                  />
                </Box>
              }
            >
              {suggested?.overall !== undefined && matchBadge(suggested.overall)}
              <HeaderChoices>
                <MediaFilters available={available} />
                {/* Words rank the media by how well they match, which no order can change. */}
                {!ranked && <AlbumSortSelect value={sort} onChange={setSort} />}
              </HeaderChoices>
            </HeaderFilterBar>
          )
          : suggested?.overall !== undefined && (
            <Group justify='flex-end' gap='xs'>
              {matchBadge(suggested.overall)}
            </Group>
          )}
      />

      {
        /* The body pads itself (AppShell's padding is off so the cover can bleed); the
          variable tells the grid's `bleed` how much to cancel on a phone. The map has none. */
      }
      <Box px='md' py='md' display={tab === 'map' ? 'none' : undefined} style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <Tabs.Panel value='media'>
          <Stack gap='md'>
            {/* Subfolders */}
            {directories.length > 0 && (
              <SimpleGrid cols={DIRECTORY_GRID_COLS} spacing={`${GRID_GAP}px`}>
                {directories.map((dir) => (
                  <DirectoryCard
                    key={dir.path}
                    directory={dir}
                    markPinned={editable}
                    onClick={() => navigate(albumRoute(dir.path))}
                  />
                ))}
              </SimpleGrid>
            )}

            {box.unresolved.length > 0 && (
              <Alert color='yellow' icon={<TablerIcon name='alert-triangle' size={16} />} onClose={box.dismissUnresolved} withCloseButton>
                No match for {box.unresolved.map((name) => `@${name}`).join(' or ')} — searched as words instead.
              </Alert>
            )}

            {/* Media, split by the day it was taken; searched by words, best match first in one grid. */}
            <MediaTimeline
              key={eventReload}
              album={albumPath}
              kinds={kinds}
              filters={searched ? filters : undefined}
              rankByRelevance={ranked}
              grouped={!ranked}
              granularity='day'
              ascending={sort === 'oldest'}
              reloadToken={listChanges}
              markPinned={editable}
              onLoadingChange={setSearching}
              emptyMessage={searched ? 'Nothing in this album matches.' : directories.length > 0 ? 'No media here — open a folder above.' : 'This album is empty'}
              selectionActions={({ selection, items, reload }) => (
                <>
                  {/* A suggested album is the organizer's: its pictures are filed in the Sort stream. */}
                  {editable && !suggested && <MoveToAlbumAction selection={selection} items={items} album={albumPath} />}
                  <SetTimeAction selection={selection} items={items} onApplied={reload} />
                  {/* Stacks and the cover are album-local, so only this page — the one that can name the album — offers them. */}
                  {info.type === 'album' && editable && <StackAction selection={selection} items={items} album={albumPath} />}
                  {info.type === 'album' && editable && <SetCoverAction selection={selection} items={items} owner={albumPath} />}
                  {info.type === 'album' && editable && <ShareSelectionAction selection={selection} items={items} album={{ path: albumPath, title: info.title }} />}
                </>
              )}
            />
          </Stack>
        </Tabs.Panel>

        {info.trip && (
          <Tabs.Panel value='trip'>
            <AlbumTripTab album={albumPath} title={info.title} trip={info.trip} editable={editable && info.type === 'album'} onChanged={refetchInfo} />
          </Tabs.Panel>
        )}

        <Tabs.Panel value='info'>
          <AlbumInfoTab
            path={albumPath}
            editable={editable && info.type === 'album'}
            title={info.title}
            description={info.description}
            timeStart={info.timeStart}
            timeEnd={info.timeEnd}
            facets={facets}
          />
        </Tabs.Panel>
      </Box>

      {/* The map takes the window below the header, edge to edge, outside the body's padding. */}
      <Tabs.Panel value='map'>
        <FillWindow>
          <AlbumMap path={albumPath} from={info.timeStart} to={info.timeEnd} />
        </FillWindow>
      </Tabs.Panel>

      <AlbumEditModal
        opened={editing}
        onClose={() => setEditing(false)}
        path={albumPath}
        name={info.title}
        description={info.description}
        series={series}
        suggested={Boolean(suggested)}
        onSaved={() => {
          refetchInfo();
          refetchSeries();
          refetchSuggested();
        }}
      />
      <EventModal
        ownerPath={albumPath}
        ownerName={info.title}
        genericOnly
        defaultDate={eventDate}
        opened={addingEvent}
        onClose={() => setAddingEvent(false)}
        onApplied={() => setEventReload((value) => value + 1)}
      />
    </Tabs>
  );
}
