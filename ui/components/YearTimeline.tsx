import {
  CardGrid,
  EntityDetailHeader,
  entityKindIcon,
  HeaderChoice,
  HeaderChoices,
  HeaderFilterBar,
  InterpretedFilter,
  PageLoader,
  SearchInput,
  TablerIcon,
} from '@ein/ui/components';
import { PEOPLE_ROOT } from '@archive/paths';
import { Alert, Box, Center, Pill, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useYearTimeline } from '../hooks/useYearTimeline.ts';
import { useTimelineFacets } from '../hooks/useTimelineFacets.ts';
import { usePeople } from '../people/hooks/usePeople.ts';
import { useLocations } from '../location/hooks/useLocations.ts';
import { usePersistedState } from '@ein/ui/hooks';
import { filtersFromMentions, type Mention, type MentionKind, naturalSearchDetails, splitSubject, subjectRefs } from '@ein/ui/lib';
import { subjectsOf } from '../lib/subjects.ts';
import type { TimelineEntry, TimelineKind } from '@archive/timeline/api';
import type { TimelineFilters } from '../lib/timeline-entries.ts';
import { YearEntryCard, yearEntryCardText } from './YearEntryCard.tsx';
import { YearHistogram, type YearPickerProps, YearSlider, YearStepper } from './YearPicker.tsx';

/**
 * What a year can show, as one exclusive choice like the Search page's type
 * filter. A person is here for being born or dying that year; the card's badge
 * says which.
 */
const YEAR_FILTERS = [
  { value: 'all', label: 'All', kinds: ['album', 'auto-album', 'birth', 'death'], nouns: { one: 'entry', many: 'entries' } },
  { value: 'album', label: 'Albums', kinds: ['album', 'auto-album'], nouns: { one: 'album', many: 'albums' } },
  { value: 'person', label: 'People', kinds: ['birth', 'death'], nouns: { one: 'person', many: 'people' } },
] as const satisfies readonly { value: string; label: string; kinds: readonly TimelineKind[]; nouns: { one: string; many: string } }[];
type YearFilter = typeof YEAR_FILTERS[number]['value'];

const SORTS = [
  { value: 'oldest', label: 'Oldest first' },
  { value: 'newest', label: 'Newest first' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'size', label: 'Most items' },
] as const;
type YearSort = typeof SORTS[number]['value'];

/** Each sort as its collapsed control shows it on a phone. */
const SORT_ICONS: Record<YearSort, ReactNode> = {
  oldest: <TablerIcon name='sort-ascending' size={18} />,
  newest: <TablerIcon name='sort-descending' size={18} />,
  name: <TablerIcon name='sort-ascending-letters' size={18} />,
  size: <TablerIcon name='sort-descending-numbers' size={18} />,
};

/** Albums by how much they hold; a person holds nothing and goes last, by date. */
const sortEntries = (entries: readonly TimelineEntry[], sort: YearSort, name: (entry: TimelineEntry) => string): TimelineEntry[] => {
  const byDate = (a: TimelineEntry, b: TimelineEntry) => (a.exactDate ?? a.date).localeCompare(b.exactDate ?? b.date);
  switch (sort) {
    case 'newest':
      return entries.toSorted((a, b) => byDate(b, a));
    case 'name':
      return entries.toSorted((a, b) => name(a).localeCompare(name(b)));
    case 'size':
      return entries.toSorted((a, b) => (b.count ?? -1) - (a.count ?? -1) || byDate(a, b));
    default:
      return entries.toSorted(byDate);
  }
};

/** What an `@` may resolve to: the subjects an album can hold media of. */
const MENTION_KINDS: readonly MentionKind[] = ['person', 'location', 'label'];

/**
 * How long the picker must rest before the year is asked for. Long enough that
 * a drag across a century fetches once, short enough that a single step feels
 * immediate.
 */
const QUERY_DEBOUNCE_MS = 250;

/** Where the slider starts when the facets have not said how far back the archive goes. */
const FALLBACK_MIN_YEAR = 1900;

const parseYear = (raw: string | null): number | undefined => {
  if (!raw || !/^\d{4}$/.test(raw)) return undefined;
  return Number(raw);
};

/**
 * The timeline as a year at a time: pick a year, see what it holds — the albums
 * with media from it, and the people born or died in it — as the same cards the
 * albums and people pages draw.
 *
 * The year lives in the URL (`?year=1998`) so a year can be linked to and
 * survives a reload; it replaces rather than pushes, so leaving the page is one
 * back press however many years were visited. The picker moves a draft year that
 * the number and the histogram follow at once; only the debounced value reaches
 * the URL, and the URL is what the feed reads.
 */
export function YearTimeline() {
  const thisYear = new Date().getFullYear();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlYear = parseYear(searchParams.get('year')) ?? thisYear;

  const [draft, setDraft] = useState(urlYear);
  const [debounced] = useDebouncedValue(draft, QUERY_DEBOUNCE_MS);

  // A URL change the picker did not make — back, forward, a followed link —
  // moves the picker to it. One the picker did make already matches `debounced`.
  const [seenUrlYear, setSeenUrlYear] = useState(urlYear);
  if (urlYear !== seenUrlYear) {
    setSeenUrlYear(urlYear);
    if (urlYear !== debounced) setDraft(urlYear);
  }

  // Only a settled draft writes. Read through a ref, because the URL moving on
  // its own must not re-run this and write the stale draft back over it.
  const urlRef = useRef({ urlYear, searchParams });
  urlRef.current = { urlYear, searchParams };
  useEffect(() => {
    if (debounced === urlRef.current.urlYear) return;
    const next = new URLSearchParams(urlRef.current.searchParams);
    next.set('year', String(debounced));
    setSearchParams(next, { replace: true });
  }, [debounced, setSearchParams]);

  // The box and what it resolved to. Not URL state: it narrows what the year
  // shows rather than naming a place to come back to.
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [filters, setFilters] = useState<TimelineFilters>({});
  const [unresolved, setUnresolved] = useState<string[]>([]);

  const { people } = usePeople();
  const { locations } = useLocations();

  // Which kinds are showing, and in what order: per-browser preferences, like
  // the albums page's sort, rather than part of a link to a year.
  const [typeFilter, setTypeFilter] = usePersistedState<YearFilter>('timeline.year.type', 'all');
  const [sort, setSort] = usePersistedState<YearSort>('timeline.year.sort', 'oldest');
  const type = YEAR_FILTERS.find((entry) => entry.value === typeFilter) ?? YEAR_FILTERS[0];
  const kinds = type.kinds;

  const { entries, loading, error } = useYearTimeline(urlYear, kinds, filters);
  const { facets } = useTimelineFacets(kinds, undefined, filters);

  const nameByPath = useMemo(() => new Map(people.map((person) => [`${PEOPLE_ROOT}/${person.id}`, person.name])), [people]);
  const nameOf = useCallback((entry: TimelineEntry) => nameByPath.get(entry.path) ?? entry.title, [nameByPath]);
  const sorted = useMemo(() => sortEntries(entries, sort, nameOf), [entries, sort, nameOf]);

  const counts = useMemo(() => new Map((facets?.years ?? []).map(({ year, count }) => [year, count])), [facets]);
  // The rail reaches back to the oldest album, and never hides the year in the
  // URL even when it lies outside what the archive holds.
  const minYear = Math.min(facets?.range?.min ?? FALLBACK_MIN_YEAR, urlYear, draft);
  const maxYear = Math.max(thisYear, urlYear, draft);

  /**
   * The filters in the box's own shape, so a new mention merges with the ones
   * already showing as pills rather than replacing all of them.
   */
  const boxFilters = useMemo(() => ({
    query: filters.query,
    subjects: subjectsOf(filters),
    tags: filters.tag ? [filters.tag] : undefined,
  }), [filters]);

  /**
   * The command takes one person, one location and one label, so the last one
   * mentioned wins. As on the Search page, what resolved becomes a pill and only
   * the free text stays in the field.
   */
  const commit = useCallback((next: ReturnType<typeof filtersFromMentions>, missed: string[]) => {
    setUnresolved(missed);
    setText([next.query, ...(next.subjectNames ?? []).map((name) => `@${splitSubject(name).ref}`)].filter(Boolean).join(' '));
    setFilters({
      query: next.query,
      person: subjectRefs(next.subjects, 'person').at(-1),
      location: subjectRefs(next.subjects, 'location').at(-1),
      tag: next.tags?.at(-1),
    });
  }, []);

  const drop = (key: 'person' | 'location' | 'tag') => setFilters((current) => ({ ...current, [key]: undefined }));

  // What the box narrowed the year to; the year and the type have their own controls.
  const filtered = Boolean(filters.query || filters.person || filters.location || filters.tag);
  const details = useMemo(
    () =>
      naturalSearchDetails(
        boxFilters,
        undefined,
        (kind, value) => kind === 'person' ? people.find((person) => person.id === value)?.name : locations.find((location) => location.id === value)?.name,
      ),
    [boxFilters, people, locations],
  );

  const pills = filters.person || filters.location || filters.tag
    ? (
      <>
        {filters.person && (
          <Pill withRemoveButton onRemove={() => drop('person')}>
            @{people.find((person) => person.id === filters.person)?.name ?? filters.person}
          </Pill>
        )}
        {filters.location && (
          <Pill withRemoveButton onRemove={() => drop('location')}>
            @{locations.find((location) => location.id === filters.location)?.name ?? filters.location}
          </Pill>
        )}
        {filters.tag && (
          <Pill withRemoveButton onRemove={() => drop('tag')}>
            #{filters.tag}
          </Pill>
        )}
      </>
    )
    : undefined;

  // One control drawn in three locations: the year at the top of the header, the
  // histogram in its background and the slider on its bottom edge.
  const picker: YearPickerProps = { value: draft, onChange: setDraft, min: minYear, max: maxYear, counts, nouns: type.nouns };

  // Still showing the year before while the next one loads — dimmed, so a drag
  // does not blank the page on every stop.
  const settling = loading || draft !== urlYear;

  return (
    <Box>
      <EntityDetailHeader
        title='Year'
        pattern='mixed'
        subtitle={
          <Text size='sm' c='gray.2'>
            Everything from one year
          </Text>
        }
        flowContent
        top={<YearStepper {...picker} />}
        edge={<YearSlider {...picker} />}
        backdrop={<YearHistogram {...picker} />}
        controls={
          // The Search page's arrangement: the box fills the left, the type and
          // the sort sit together on the right, as icon menus on a phone.


            <HeaderFilterBar
              wide
              input={
                <>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <SearchInput
                      value={text}
                      onChange={setText}
                      mentions={mentions}
                      onMentionsChange={setMentions}
                      onCommit={(next, missed) => commit(next, missed)}
                      filters={boxFilters}
                      pills={pills}
                      kinds={MENTION_KINDS}
                      size='md'
                      placeholder='Narrow the year — type @ for a person, location or label'
                      shortPlaceholder='Narrow the year…'
                    />
                  </Box>
                  {filtered && <InterpretedFilter details={details} />}
                </>
              }
            >
              <HeaderChoices>
                <HeaderChoice
                  label='Show'
                  variant='segmented'
                  value={type.value}
                  onChange={(value) => setTypeFilter(value as YearFilter)}
                  options={YEAR_FILTERS.map(({ value, label }) => ({ value, label, icon: entityKindIcon(value) }))}
                />
                <HeaderChoice
                  label='Sort'
                  value={sort}
                  onChange={(value) => setSort(value as YearSort)}
                  options={SORTS.map(({ value, label }) => ({ value, label, icon: SORT_ICONS[value] }))}
                />
              </HeaderChoices>
            </HeaderFilterBar>

        }
      />

      <Box px='md' py='lg'>
        <Stack gap='md'>
          {unresolved.length > 0 && (
            <Alert color='yellow' icon={<TablerIcon name='alert-triangle' size={16} />} onClose={() => setUnresolved([])} withCloseButton>
              No match for {unresolved.map((name) => `@${name}`).join(' or ')} — searched as plain text instead.
            </Alert>
          )}

          {facets?.truncated && <Alert color='orange'>The histogram counts only the first {facets.total} matches.</Alert>}

          {error && <Alert color='red'>{error.message}</Alert>}

          {loading && entries.length === 0
            ? <PageLoader label='Loading the year…' />
            : (
              <Box style={{ opacity: settling && entries.length > 0 ? 0.5 : 1, transition: 'opacity 150ms' }}>
                <CardGrid items={sorted} itemKey={(entry) => entry.key} textParts={yearEntryCardText}>
                  {(entry) => <YearEntryCard entry={entry} personName={nameByPath.get(entry.path)} />}
                </CardGrid>
                {!loading && entries.length === 0 && (
                  <Center py='xl'>
                    <Text c='dimmed' size='sm'>
                      {filters.query || filters.person || filters.location || filters.tag
                        ? `Nothing from ${urlYear} matches — the histogram shows the years that do.`
                        : `Nothing from ${urlYear}.`}
                    </Text>
                  </Center>
                )}
              </Box>
            )}
        </Stack>
      </Box>
    </Box>
  );
}
