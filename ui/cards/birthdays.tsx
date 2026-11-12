import { Avatar, Group, Skeleton, Stack, Text } from '@mantine/core';
import { CoverAvatar, TablerIcon } from '@ein/ui/components';
import { useLocalDay, usePolledCommand } from '@ein/ui/hooks';
import { useSearchParams } from 'react-router-dom';
import type { AnniversaryEntry } from '../../lib/timeline/api.ts';

/** When it falls, as a person says it. */
const whenText = (days: number): string => days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 14 ? `in ${days} days` : `in ${Math.round(days / 7)} weeks`;

/**
 * `/cards/archive/birthdays`: the birthdays coming up — and wedding anniversaries and memorials
 * too when `kinds` says — nearest first: the first large, its face and sentence, the rest as rows
 * with their faces; a milestone in bold, today's in the accent. Read on the viewer's own day.
 */
export default function BirthdaysCard() {
  const [params] = useSearchParams();
  const today = useLocalDay();
  const days = Number(params.get('days') ?? 30) || 30;
  const limit = Number(params.get('limit') ?? 8) || 8;
  const kinds = params.getAll('kinds');
  const command = `anniversaries --today ${today} --days-ahead ${days} --limit ${limit}${kinds.length ? ` --kind ${kinds.join(',')}` : ' --kind birthday'}`;
  const found = usePolledCommand<AnniversaryEntry[]>(command, true, 60 * 60_000);

  if (!found.data) return found.error ? <Text size='sm' c='dimmed' ta='center' mt='lg'>{found.error.message}</Text> : <Skeleton height='60%' radius='md' />;
  if (found.data.length === 0) {
    return (
      <Stack h='100%' align='center' justify='center' gap={6} c='dimmed'>
        <TablerIcon name='cake' size={26} stroke={1.5} />
        <Text size='sm'>No birthdays in the next {days} days</Text>
      </Stack>
    );
  }
  const [first, ...rest] = found.data;
  const tone = (entry: AnniversaryEntry) => (entry.daysAway === 0 ? 'color-mix(in srgb, var(--dash-accent, var(--mrx-accent)) 75%, white)' : 'dimmed');

  return (
    <Stack gap='0.7em' h='100%' style={{ overflow: 'auto', fontSize: 'clamp(0.85rem, 4.2cqmin, 1.4rem)' }}>
      <Group gap='md' wrap='nowrap'>
        <Avatar.Group spacing={10}>
          {first.people.map((face) => <CoverAvatar key={face} path={face} size={56} color='grape' alt='' fallback={<TablerIcon name='user' size={24} />} />)}
        </Avatar.Group>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text inherit size='1.15em' fw={first.milestone ? 750 : 600} lineClamp={2}>{first.title}</Text>
          <Text inherit size='0.85em' c={tone(first)} fw={first.daysAway === 0 ? 650 : 500}>{whenText(first.daysAway)}</Text>
        </Stack>
      </Group>
      {rest.map((entry) => (
        <Group key={`${entry.path}\n${entry.date}`} gap='sm' wrap='nowrap'>
          <Avatar.Group spacing={8}>
            {entry.people.map((face) => <CoverAvatar key={face} path={face} size={32} color='grape' alt='' fallback={<TablerIcon name='user' size={16} />} />)}
          </Avatar.Group>
          <Text inherit fw={entry.milestone ? 650 : undefined} lineClamp={1} style={{ flex: 1, minWidth: 0 }}>{entry.title}</Text>
          <Text inherit size='0.8em' c={tone(entry)} style={{ flex: 'none' }}>{whenText(entry.daysAway)}</Text>
        </Group>
      ))}
    </Stack>
  );
}
