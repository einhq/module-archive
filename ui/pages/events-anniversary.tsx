import { Avatar, Box, Group, Text } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { isTimelineKind } from '@archive/timeline/api';
import { CoverAvatar, TablerIcon } from '@ein/ui/components';
import { entryRoute, KIND_STYLE } from '../components/TimelineEntryCard.tsx';

/**
 * One `events-anniversaries` entry, as the home page's Events draws it: the faces of whoever it is
 * about (both partners for a wedding) and its sentence, a milestone's in bold, linking to the
 * person. Missing portraits keep the kind's icon. Everything it shows is in its query (`kind`,
 * `path`, `title`, `people`, `milestone`), so it runs nothing; the page beside it says when.
 */
export default function EventsAnniversaryEntry() {
  const [params] = useSearchParams();
  const rawKind = params.get('kind') ?? '';
  const kind = isTimelineKind(rawKind) ? rawKind : 'event';
  const path = params.get('path') ?? '';
  const title = params.get('title') ?? '';
  const people = params.getAll('people');
  const { icon, color } = KIND_STYLE[kind];

  return (
    <Box component={Link} to={entryRoute({ kind, key: path, date: '', path, title })} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
        <Avatar.Group spacing={8} style={{ flexShrink: 0 }}>
          {(people.length > 0 ? people : [path]).map((face) => (
            <CoverAvatar key={face} path={face} fallback={<TablerIcon name={icon} size={16} />} size={34} color={color} alt='' />
          ))}
        </Avatar.Group>
        <Text size='sm' fw={params.has('milestone') ? 600 : undefined} lineClamp={2}>{title}</Text>
      </Group>
    </Box>
  );
}
