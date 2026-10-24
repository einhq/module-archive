import { Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { PersonListEntry } from '@archive/people/api';
import { CoverAvatar, ExploreRow, ExploreSection, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';

/** How many people the row offers. */
const LIMIT = 24;
const FACE = 88;

/**
 * The people the archive shows most, as a row of faces: the Search landing's People section
 * (`archive.explore-people`, a `search.explore` panel). Nothing while nobody named has a face.
 */
export default function ExplorePeople() {
  const { data, loading } = useCommand<PersonListEntry[]>(`person-list --sort count --min 1 --limit ${LIMIT}`);
  if (!loading && !data?.length) return null;

  return (
    <ExploreSection icon='users' title='People' to='/people'>
      <ExploreRow>
        {loading && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} circle height={FACE} />)}
        {data?.map((person) => (
          <UnstyledButton key={person.id} component={Link} to={`/people/${encodeURIComponent(person.id)}`} w={FACE + 16}>
            <Stack gap={6} align='center'>
              <CoverAvatar path={person.path} size={FACE} color='grape' alt={person.name} fallback={<TablerIcon name='user' size={36} />} />
              <Text size='sm' fw={500} ta='center' lineClamp={2} lh={1.25}>{person.name}</Text>
            </Stack>
          </UnstyledButton>
        ))}
      </ExploreRow>
    </ExploreSection>
  );
}
