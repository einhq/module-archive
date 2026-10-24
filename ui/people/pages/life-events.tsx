import { Alert } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { execCommand } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import type { LifeEventStats } from '@archive/people/api';
import { LifeEventsByMonth, LifeEventsByMonthSkeleton } from '../components/LifeEventsByMonth.tsx';

/**
 * Births, engagements, marriages and deaths folded into calendar months (`person-stats`). The
 * statistics page shows it as a section (`archive.life-events`, a `stats.sections` panel in
 * archive's `nav.json`); opened by its URL it is a page of its own.
 */
export default function LifeEventsPage() {
  const [events, setEvents] = useState<LifeEventStats | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let live = true;
    execCommand<LifeEventStats>('person-stats').then(
      (answer) => live && setEvents(answer),
      (err) => live && setError(err instanceof Error ? err : new Error(String(err))),
    );
    return () => {
      live = false;
    };
  }, []);

  if (error) return <Alert color='red' variant='light' icon={<TablerIcon name='alert-triangle' size={16} />}>{error.message}</Alert>;
  if (!events) return <LifeEventsByMonthSkeleton />;
  return <LifeEventsByMonth events={events} />;
}
