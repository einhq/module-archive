import { Button, Skeleton } from '@mantine/core';
import { Link } from 'react-router-dom';
import { ExploreRow, ExploreSection } from '@ein/ui/components';
import { useTimelineFacets } from '../hooks/useTimelineFacets.ts';

/**
 * Every year the archive holds something from, newest first, each opening the Year view: the
 * Search landing's Years section (`archive.explore-years`).
 */
export default function ExploreYears() {
  const { facets, loading } = useTimelineFacets(undefined, undefined);
  const years = (facets?.years ?? []).filter(({ count }) => count > 0).toSorted((a, b) => b.year - a.year);
  if (!loading && years.length === 0) return null;

  return (
    <ExploreSection icon='calendar' title='Years' to='/year'>
      <ExploreRow>
        {loading && Array.from({ length: 10 }, (_, i) => <Skeleton key={i} width={72} height={30} radius='xl' />)}
        {years.map(({ year, count }) => (
          <Button key={year} component={Link} to={`/year?year=${year}`} variant='light' color='gray' radius='xl' size='sm' title={`${count} albums and people`}>
            {year}
          </Button>
        ))}
      </ExploreRow>
    </ExploreSection>
  );
}
