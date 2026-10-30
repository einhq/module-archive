import {
  BrowseEntityCard,
  CardGrid,
  EmptyState,
  EntityDetailHeader,
  HeaderChoice,
  HeaderFilterBar,
  HeaderStats,
  ListFilterInput,
  PageLoader,
  TablerIcon,
} from '@ein/ui/components';
import { PEOPLE_ROOT } from '@archive/paths';
import { ActionIcon, Box, Button, Indicator, Stack, Text } from '@mantine/core';
import { countOf, matchesText } from '@ein/ui/lib';
import type { PersonListEntry } from '@archive/people/api';
import { useUnknownPeople } from '../hooks/useUnknownPeople.ts';
import { useCommand, usePersistedState, useUrlParam } from '@ein/ui/hooks';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAuthenticated, openDialog } from '@ein/ui/signals';

/** "39K" rather than "38982": the badge sits on a 44px icon button. */
const COMPACT_COUNT = new Intl.NumberFormat(undefined, { notation: 'compact' });

export const handle = { fullBleed: true };

/** Under a person's name: how many pictures they are in, or their full name when it says more. */
const describe = (person: PersonListEntry): string | undefined =>
  person.pictures > 0 ? countOf(person.pictures, 'picture', 'pictures') : person.fullname && person.fullname !== person.name ? person.fullname : undefined;

export default function PeoplePage() {
  const navigate = useNavigate();
  const [search, setSearch] = useUrlParam('q');
  const [sortBy, setSortBy] = usePersistedState<'count' | 'name' | 'name-desc'>('people.list.sort', 'count');
  // Everyone named, with how often the archive shows them: the order most visits want.
  const { data, loading } = useCommand<PersonListEntry[]>('person-list --sort count');
  const people = useMemo(() => data ?? [], [data]);
  // Only the count matters here, so skip the crops.
  const { total: unidentified } = useUnknownPeople({ faces: 0, pageSize: 0 });

  const filteredPeople = useMemo(() => {
    const filtered = people.filter((person) => matchesText([person.name, person.fullname], search));
    if (sortBy === 'count') return filtered;
    // A placeholder name (`? Surname`, known only from a family record) goes after the real names.
    const byName = (a: PersonListEntry, b: PersonListEntry) => Number(a.name.startsWith('?')) - Number(b.name.startsWith('?')) || a.name.localeCompare(b.name);
    return filtered.toSorted((a, b) => (sortBy === 'name-desc' ? byName(b, a) : byName(a, b)));
  }, [people, search, sortBy]);

  return (
    <Box>
      <EntityDetailHeader
        title='People'
        pattern='person'
        meta={!loading && <HeaderStats items={[countOf(people.length, 'person', 'people')]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='people' />}>
            {unidentified > 0 && (
              <>
                <Button
                  className='mrx-header-wide'
                  variant='light'
                  leftSection={<TablerIcon name='user-question' size={16} />}
                  onClick={() => navigate('/people/unknown')}
                >
                  {unidentified} unidentified
                </Button>
                <Indicator className='mrx-header-narrow' label={COMPACT_COUNT.format(unidentified)} size={16} offset={4}>
                  <ActionIcon variant='light' size='lg' aria-label={`${unidentified} unidentified`} onClick={() => navigate('/people/unknown')}>
                    <TablerIcon name='user-question' size={18} />
                  </ActionIcon>
                </Indicator>
              </>
            )}
            <HeaderChoice
              label='Sort'
              value={sortBy}
              onChange={(value) => setSortBy(value === 'name' || value === 'name-desc' ? value : 'count')}
              options={[
                { value: 'count', label: 'Most pictured', icon: <TablerIcon name='photo' size={18} /> },
                { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                { value: 'name-desc', label: 'Name (Z-A)', icon: <TablerIcon name='sort-descending-letters' size={18} /> },
              ]}
            />
          </HeaderFilterBar>
        }
      />

      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {loading ? <PageLoader label='Loading people…' /> : (
            <>
              <CardGrid items={filteredPeople} itemKey={(person) => person.id} textParts={(person) => ({ description: Boolean(describe(person)) })}>
                {(person) => (
                  <BrowseEntityCard
                    title={person.name}
                    description={describe(person)}
                    coverPath={`${PEOPLE_ROOT}/${person.id}`}
                    kind='person'
                    onClick={() => navigate(`/people/${encodeURIComponent(person.id)}`)}
                  />
                )}
              </CardGrid>

              {people.length === 0 && (
                <EmptyState
                  title='No people yet'
                  actions={isAuthenticated.value && (
                    <Button
                      variant='light'
                      onClick={() => openDialog('/people/new')}
                    >
                      New person
                    </Button>
                  )}
                >
                  Face recognition finds people in the pictures; name them under Unidentified, or add someone here.
                </EmptyState>
              )}
              {people.length > 0 && filteredPeople.length === 0 && (
                <Box ta='center' py='xl'>
                  <Text c='dimmed'>No people found matching "{search}"</Text>
                </Box>
              )}
            </>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
