import { Box, Text, UnstyledButton } from '@mantine/core';
import './memories.css';
import { gridUrl } from '@ein/ui/lib';
import { openFullscreen } from '@ein/ui/signals';
import type { DayInHistory } from '@archive/media/api';

/** "1 year ago", "12 years ago". */
export const yearsAgo = (years: number): string => (years === 1 ? '1 year ago' : `${years} years ago`);

/**
 * One year of a calendar day: a round cover ringed in the mark's colours over how long ago it was,
 * opening that year's pictures as a story (`/memories/<MM-DD>?year=`) over the page. `role` is
 * `listitem` when it stands straight in a list of its own.
 */
export function MemoryRing({ monthDay, year, cover, role }: { monthDay: string; year: number; cover: string; role?: 'listitem' }) {
  const ago = yearsAgo(new Date().getFullYear() - year);
  return (
    <UnstyledButton
      role={role}
      className='mrx-memory-ring'
      onClick={() => openFullscreen(`/memories/${monthDay}?year=${year}`)}
      aria-label={`${ago}, ${year}`}
    >
      <span className='mrx-memory-ring-art'>
        <img src={gridUrl(cover, true)} alt='' loading='lazy' draggable={false} />
      </span>
      <Text size='xs' fw={600} lh={1.2}>{ago}</Text>
      <Text size='xs' c='dimmed' lh={1.2}>{year}</Text>
    </UnstyledButton>
  );
}

/** This calendar day in earlier years, as a row of rings, one a year that had pictures. */
export function MemoryRings({ day }: { day: DayInHistory }) {
  const years = day.years.filter((year) => year.items.length > 0);
  if (years.length === 0) return null;

  return (
    <Box className='mrx-memory-rings' role='list' aria-label='On this day'>
      {years.map(({ year, items }) => <MemoryRing key={year} monthDay={day.monthDay} year={year} cover={items[0].path} role='listitem' />)}
    </Box>
  );
}
