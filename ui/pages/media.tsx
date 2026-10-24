import { MediaTimeline } from '../components/MediaTimeline.tsx';
import { MemoryRings } from '../components/MemoryRings.tsx';
import { useDayInHistory } from '../hooks/useDayInHistory.ts';
import { stagingUploadFolder } from '../staging/hooks/useStagingStatus.ts';
import { SetTimeAction } from '../media/components/SetTimeAction.tsx';
import { SearchByPicture } from '../media/components/SearchByPicture.tsx';
import { LabelSuggestions } from '../components/LabelSuggestions.tsx';
import { useSubjectFacets } from '../hooks/useSubjectFacets.ts';
import {
  EntityDetailHeader,
  hasPills,
  HeaderChoice,
  HeaderChoices,
  HeaderFilterBar,
  HeaderToggle,
  InterpretedFilter,
  LabelFacets,
  type PillKind,
  SearchInput,
  SearchPills,
  TablerIcon,
} from '@ein/ui/components';
import { Alert, Box, Loader, Stack, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePeople } from '../people/hooks/usePeople.ts';
import { useLocations } from '../location/hooks/useLocations.ts';
import { FILE_KINDS, hasAnyFilter, MEDIA_KIND_FILTERS, type MediaKindFilter, type SearchFilters, type SearchOutcome, usePersistedState, useSearchBox } from '@ein/ui/hooks';
import { filtersFromParams, naturalSearchDetails, paramsFromFilters } from '@ein/ui/lib';
import { currentUser } from '@ein/ui/signals';
import { LOCATIONS_ROOT } from '@archive/paths';
import { mediaKindIcon } from '../media/components/MediaFilters.tsx';
import { lightboxCountHidden } from '../media/signals/lightbox.ts';

/** Whose media: what the reader added themselves, or everything they may see. */
type Scope = 'my' | 'all';

/**
 * How the feed is laid out. Default: by day in a justified grid, the pictures at
 * their own shapes. Days and Months: by day or by month in square tiles, three or
 * five across a phone, more of them on a screen, for getting around.
 */
type Layout = 'default' | 'days' | 'months';
const LAYOUTS: Record<Layout, { granularity: 'day' | 'month'; square?: number }> = {
  default: { granularity: 'day' },
  days: { granularity: 'day', square: 3 },
  months: { granularity: 'month', square: 5 },
};
const LAYOUT_OPTIONS = [
  { value: 'default', label: 'Default', icon: <TablerIcon name='layout-dashboard' size={18} /> },
  { value: 'days', label: 'Days', icon: <TablerIcon name='calendar-event' size={18} /> },
  { value: 'months', label: 'Months', icon: <TablerIcon name='calendar-month' size={18} /> },
] as const;

/**
 * The reader's words for a provider's stderr line.
 *
 * The one that matters is the content match giving up — the model server did not
 * answer inside the interactive budget — because the page then shows filename
 * matches that look like a complete answer. Anything else is shown as it came.
 */
const describeWarning = (warning: string): string =>
  warning.includes('content match unavailable') ? 'The content match did not answer in time, so these are filename matches only. Try again in a moment.' : warning;

export const handle = { fullBleed: true };

/**
 * Media: the pictures themselves.
 *
 * With nothing in the filter box this is a feed — every file the reader may
 * see, newest first, in dated sections with the time rail — everyone's by
 * default, or with **Show only mine** on the files this user created (by the node's
 * birth uid). The scope is a reader preference, remembered per browser rather
 * than routed: it is not part of the question the way a person or a year is,
 * so a shared link keeps the viewer's own scope.
 *
 * Type into the box and the page becomes a search: best
 * matches first in one continuous justified grid, results paging in as the
 * reader scrolls. On commit, the deterministic parse (years, kinds) sets the
 * filters and the search runs on them at once; the assistant's model then
 * identifies people and locations and re-runs the search only if it changed a
 * filter, so the results never wait on the model. What was understood — a
 * person, a location, a year, or an `@` pick — leaves the box as a chip that can be
 * removed, and the box keeps the words still searched as a description
 * (`useSearchBox`). The URL carries those content filters, so a filtered view is
 * linkable and back/forward work, and the interpretation sits behind the info
 * button beside the box.
 *
 * A picture can ask instead of words (`like`): one sent from the button beside the box, or the
 * one the lightbox's Similar strip was showing. The answer is what looks like it, nearest first,
 * and the chips narrow it as they narrow words.
 *
 * The kind control belongs to both modes: "just the videos" is still the feed.
 */
export default function MediaPage() {
  useSignals();
  const [searchParams, setSearchParams] = useSearchParams();
  // This day in earlier years, as rings above the feed; the feed's own reads do not wait on it.
  const day = useDayInHistory();
  // Uploads from here go to today's folder of the reader's default staging category, where every new file starts.
  const username = currentUser.value?.username;
  const uploadPath = useMemo(() => username ? stagingUploadFolder(username) : undefined, [username]);

  // The feed is loaded a window at a time, so the lightbox cannot know a picture's location in it.
  useEffect(() => {
    lightboxCountHidden.value = true;
    return () => {
      lightboxCountHidden.value = false;
    };
  }, []);

  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  // Reported up from the list, because the indicator belongs where the question
  // was asked — in the box — not only above the results.
  const [searching, setSearching] = useState(false);
  // How the last search was answered: its warnings say when the answer is incomplete.
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);

  const { people } = usePeople();
  // Names only: the chips turn a slug back into a name.
  const { locations } = useLocations(LOCATIONS_ROOT, { withCoordinates: false });
  const nameOf = useCallback((kind: PillKind, value: string): string | undefined => {
    if (kind === 'person') return people.find((person) => person.id === value)?.name;
    if (kind === 'location') return locations.find((location) => location.id === value)?.name;
    return undefined;
  }, [people, locations]);

  // Words and a picture to look like are two questions: words asked while a picture is the
  // question replace it.
  const apply = useCallback((next: SearchFilters) => {
    setSearchParams(paramsFromFilters(next.query?.trim() && next.like ? { ...next, like: undefined } : next), { replace: true });
  }, [setSearchParams]);
  const box = useSearchBox({ filters, apply, natural: { kinds: FILE_KINDS } });
  const patch = box.patch;
  const setText = box.setText;
  const searchLike = useCallback((path: string) => {
    setText('');
    apply({ ...filters, query: undefined, like: path });
  }, [setText, apply, filters]);

  const kindFilter: MediaKindFilter = useMemo(() => {
    const kinds = filters.kinds ?? [];
    const match = MEDIA_KIND_FILTERS.find((entry) => entry.kinds.length === kinds.length && entry.kinds.every((kind) => kinds.includes(kind)));
    return match ?? MEDIA_KIND_FILTERS[0];
  }, [filters.kinds]);

  // ----- Scope -----
  // All by default; a guest has no "my" at all.
  const uid = currentUser.value?.uid;
  const [storedScope, setStoredScope] = usePersistedState<Scope>('media.scope', 'all');
  const scope: Scope = uid === undefined ? 'all' : storedScope;
  // A reader preference like the scope, remembered per browser rather than routed.
  const [storedLayout, setLayout] = usePersistedState<Layout>('media.layout', 'default');
  const layout = LAYOUTS[storedLayout] ?? LAYOUTS.default;

  // The kind control alone does not leave the feed: "just the videos" is still
  // the newest-first list. Anything the box produced does.
  const filtered = hasAnyFilter({ ...filters, kinds: undefined });

  /**
   * Files, always, when the search runs — this page is the half of search that
   * finds the pictures.
   *
   * Left unset, `search` fans out to every provider on PATH and an album, a
   * person or a location ranks above the media it holds, which then lands in the
   * justified grid as a tile with nothing to draw.
   *
   * The feed says it differently: nothing at all for "all kinds", because a
   * kind set the store cannot express would post-filter and cap the rail —
   * and only files carry a capture time anyway.
   */
  const creator = scope === 'my' ? uid : undefined;
  const effective = useMemo(
    (): SearchFilters => ({ ...filters, creator, kinds: filters.kinds?.length ? filters.kinds : [...FILE_KINDS] }),
    [filters, creator],
  );
  const feedFilters = useMemo(
    (): SearchFilters => ({ creator, kinds: filters.kinds?.length ? filters.kinds : undefined }),
    [filters.kinds, creator],
  );
  // The feed's facets are the ones its rail asks for, so the two share an answer.
  const { facets } = useSubjectFacets(filtered ? effective : feedFilters);
  const chooseLabel = useCallback((label: string) => patch({ tags: [...(filters.tags ?? []), label] }), [patch, filters.tags]);
  // A filter on one label offers what else looks like it, to the signed in, who can label it.
  const onlyLabel = filters.tags?.length === 1 && uid !== undefined ? filters.tags[0] : undefined;
  // Bumped when suggestions were given the label, so the filtered grid takes them in.
  const [labeled, setLabeled] = useState(0);
  const details = useMemo(() => naturalSearchDetails(effective, box.interpretation, nameOf), [effective, box.interpretation, nameOf]);

  const scopeControl = uid !== undefined && (
    <HeaderToggle
      label='Show only mine'
      icon={<TablerIcon name='user' size={18} />}
      checked={scope === 'my'}
      onChange={(mine) => setStoredScope(mine ? 'my' : 'all')}
    />
  );

  return (
    <Box>
      <EntityDetailHeader
        title='Media'
        pattern='mixed'
        actions={uploadPath ? { upload: { path: uploadPath, name: 'staging', keepFolders: true } } : undefined}
        subtitle={
          <Text size='sm' c='gray.2'>
            Photos, videos, audio and documents
          </Text>
        }
        flowContent
        controls={
          // The Search page's arrangement: the box fills the left, the scope and
          // the kind sit together on the right.


            <HeaderFilterBar
              wide
              input={
                <>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <SearchInput
                      value={box.text}
                      onChange={box.setText}
                      mentions={box.mentions}
                      onMentionsChange={box.setMentions}
                      onCommit={box.commit}
                      filters={filters}
                      size='md'
                      placeholder='Filter the media — “Anna sailing 2011”, or type @ to pick someone'
                      shortPlaceholder='Filter the media…'
                      rightSection={box.parsing || searching ? <Loader size={16} /> : undefined}
                      pills={hasPills(filters) ? <SearchPills filters={filters} onPatch={patch} nameOf={nameOf} /> : undefined}
                    />
                  </Box>
                  <SearchByPicture onPicked={searchLike} />
                  {filtered && <InterpretedFilter details={details} />}
                </>
              }
            >
              <HeaderChoices label='Filter'>
                {scopeControl}
                {
                  // Only the feed is divided; a filtered search is one continuous grid.
                  !filtered && (
                    <HeaderChoice
                      label='Layout'
                      variant='segmented'
                      value={storedLayout in LAYOUTS ? storedLayout : 'default'}
                      onChange={(value) => setLayout(value in LAYOUTS ? value as Layout : 'default')}
                      options={LAYOUT_OPTIONS}
                    />
                  )
                }
                <HeaderChoice
                  label='Show'
                  variant='segmented'
                  value={kindFilter.value}
                  onChange={(value) => {
                    const chosen = MEDIA_KIND_FILTERS.find((entry) => entry.value === value) ?? MEDIA_KIND_FILTERS[0];
                    patch({ kinds: chosen.kinds.length > 0 ? [...chosen.kinds] : undefined });
                  }}
                  options={MEDIA_KIND_FILTERS.map((entry) => ({ value: entry.value, label: entry.label, icon: mediaKindIcon(entry.value) }))}
                />
              </HeaderChoices>
            </HeaderFilterBar>

        }
      />

      {
        /* The body pads itself (AppShell's padding is off so the header can bleed); the
          variable tells the grid's `bleed` how much to cancel on a phone. */
      }
      <Box px='md' py='lg' style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <Stack gap='md'>
          {box.unresolved.length > 0 && (
            <Alert color='yellow' icon={<TablerIcon name='alert-triangle' size={16} />} onClose={box.dismissUnresolved} withCloseButton>
              No person or location filter matched {box.unresolved.join(' or ')} — searched those words as description instead.
            </Alert>
          )}

          {filtered && outcome && outcome.warnings.length > 0 && (
            <Alert color='yellow' icon={<TablerIcon name='alert-triangle' size={16} />} title='Incomplete answer'>
              <Stack gap={2}>
                {outcome.warnings.map((warning) => <Text key={warning} size='sm'>{describeWarning(warning)}</Text>)}
              </Stack>
            </Alert>
          )}

          {!filtered && day.data && <MemoryRings day={day.data} />}

          {facets && <LabelFacets labels={facets.labels} total={facets.total} chosen={filters.tags ?? []} onChoose={chooseLabel} />}

          {onlyLabel && <LabelSuggestions key={onlyLabel} label={onlyLabel} kinds={filters.kinds} onLabeled={() => setLabeled((n) => n + 1)} />}

          {filtered
            ? (
              <MediaTimeline
                filters={effective}
                rankByRelevance
                reloadToken={labeled}
                onOutcome={setOutcome}
                grouped={false}
                onLoadingChange={setSearching}
                emptyMessage='Nothing matches that filter.'
                selectionActions={({ selection, items, reload }) => <SetTimeAction selection={selection} items={items} onApplied={reload} />}
              />
            )
            : (
              <MediaTimeline
                browseAll={creator === undefined && feedFilters.kinds === undefined}
                filters={feedFilters}
                granularity={layout.granularity}
                square={layout.square}
                onLoadingChange={setSearching}
                emptyMessage={scope === 'my' ? 'Nothing you have added yet.' : 'No media yet.'}
                selectionActions={({ selection, items, reload }) => <SetTimeAction selection={selection} items={items} onApplied={reload} />}
              />
            )}
        </Stack>
      </Box>
    </Box>
  );
}
