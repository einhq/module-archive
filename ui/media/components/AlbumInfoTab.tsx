import { CoverAvatar, formatRange, TablerIcon } from '@ein/ui/components';
import { Anchor, Badge, Button, Group, Loader, SimpleGrid, Text } from '@mantine/core';
import { countOf, paramsFromFilters, type SearchFilters, subjectArg } from '@ein/ui/lib';
import type { SubjectTally } from '@archive/media/api';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';
import { useContainerSubjects } from '../hooks/useContainerSubjects.ts';

type AlbumInfoTabProps = {
  path: string;
  title: string;
  description?: string;
  timeStart?: string;
  timeEnd?: string;
  /** What the album holds by kind, and the labels its media carry; absent while they load. */
  facets?: { kinds: { kind: string; count: number }[]; labels: { label: string; count: number }[] } | null;
};

/** How a kind of media is counted. */
const KIND_WORDS: Record<string, [string, string]> = {
  photo: ['photo', 'photos'],
  video: ['video', 'videos'],
  audio: ['recording', 'recordings'],
  document: ['document', 'documents'],
};

/** Rows a list shows before it is opened in full. */
const SHOWN = 10;

/** Where a subject's own page is, by the root it is under. */
const ROUTES: Record<string, string> = { person: '/people', location: '/locations', device: '/devices' };

const ICONS: Record<string, string> = { person: 'user', location: 'map-pin', device: 'device-camera-phone' };

const slugOf = (path: string): string => encodeURIComponent(path.split('/').pop() ?? path);

/** A search of this album's media, narrowed by `filters`. */
const searchIn = (under: string, filters: SearchFilters): string => `/search?${paramsFromFilters({ ...filters, under })}`;

/**
 * The subjects of one kind, the most counted first: each opens its page, and its count the album's
 * media that have it, when `search` can ask for that (`subject`).
 */
function SubjectList({ under, kind, rows, subject }: { under: string; kind: 'person' | 'location' | 'device'; rows: SubjectTally[]; subject: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <>
      {shown.map((row) => (
        <Group key={row.path} gap='sm' wrap='nowrap' justify='space-between'>
          <Group gap='sm' wrap='nowrap' style={{ minWidth: 0 }}>
            <CoverAvatar path={row.path} size={28} radius='xl' alt='' fallback={<TablerIcon name={ICONS[kind]} size={16} />} />
            <Anchor component={Link} to={`${ROUTES[kind]}/${slugOf(row.path)}`} size='sm' truncate>{row.name}</Anchor>
          </Group>
          {subject
            ? (
              <Anchor component={Link} to={searchIn(under, { subjects: [subjectArg(kind, row.path)] })} size='xs' c='dimmed' style={{ flexShrink: 0 }}>
                {row.count.toLocaleString()}
              </Anchor>
            )
            : <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{row.count.toLocaleString()}</Text>}
        </Group>
      ))}
      {rows.length > SHOWN && (
        <Button variant='subtle' size='compact-xs' onClick={() => setAll(!all)} style={{ alignSelf: 'flex-start' }}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}
    </>
  );
}

/**
 * What an album is and what is in it: its dates, its media by kind and how many have a position,
 * and who and what its media have — the people in them, where they were taken, the devices that
 * took them, who held the camera and the labels they carry (`subjects-in`). Each opens its own page,
 * and its count a search of this album's media that have it.
 */
export function AlbumInfoTab({ path, title, description, timeStart, timeEnd, facets }: AlbumInfoTabProps) {
  const { subjects, loading } = useContainerSubjects(path);
  const kinds = (facets?.kinds ?? []).filter((bucket) => KIND_WORDS[bucket.kind]);

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md' maw={1100}>
      <InfoSection title='Album'>
        <InfoFact label='Name'>{title}</InfoFact>
        {timeStart && <InfoFact label='When'>{formatRange(timeStart, timeEnd)}</InfoFact>}
        {kinds.length > 0 && <InfoFact label='Holds'>{kinds.map((bucket) => countOf(bucket.count, ...KIND_WORDS[bucket.kind])).join(' · ')}</InfoFact>}
        {subjects && subjects.total > 0 && (
          <InfoFact label='On the map'>
            {subjects.positioned === subjects.total ? 'All of them' : `${subjects.positioned.toLocaleString()} of ${subjects.total.toLocaleString()}`}
          </InfoFact>
        )}
        {subjects?.truncated && <Text size='xs' c='dimmed'>The album holds more than could be read; what is shown here counts the first 20,000.</Text>}
      </InfoSection>

      {description && (
        <InfoSection title='About'>
          <UserText text={description} size='sm' />
        </InfoSection>
      )}

      {loading && (
        <InfoSection title='People and places'>
          <Group gap='xs'>
            <Loader size='xs' />
            <Text size='sm' c='dimmed'>Reading who and what is in it…</Text>
          </Group>
        </InfoSection>
      )}

      {subjects && subjects.people.length > 0 && (
        <InfoSection title='People'>
          <SubjectList under={path} kind='person' rows={subjects.people} subject />
        </InfoSection>
      )}

      {subjects && subjects.locations.length > 0 && (
        <InfoSection title='Places'>
          <SubjectList under={path} kind='location' rows={subjects.locations} subject />
        </InfoSection>
      )}

      {subjects && subjects.devices.length > 0 && (
        <InfoSection title='Devices'>
          <SubjectList under={path} kind='device' rows={subjects.devices} subject />
        </InfoSection>
      )}

      {subjects && subjects.photographers.length > 0 && (
        <InfoSection title='Photographers'>
          <SubjectList under={path} kind='person' rows={subjects.photographers} subject={false} />
        </InfoSection>
      )}

      {facets && facets.labels.length > 0 && (
        <InfoSection title='Labels'>
          <Group gap={6}>
            {facets.labels.map(({ label, count }) => (
              <Badge key={label} variant='default' tt='none' fw={500}>
                <Anchor component={Link} to={searchIn(path, { tags: [label] })} size='xs' fw={500} c='inherit' underline='hover'>
                  {label} <Text span size='xs' c='dimmed'>{count.toLocaleString()}</Text>
                </Anchor>
              </Badge>
            ))}
          </Group>
        </InfoSection>
      )}

      {subjects && !loading && subjects.people.length + subjects.locations.length + subjects.devices.length + subjects.photographers.length === 0 && (
        <InfoSection title='People and places'>
          <Text size='sm' c='dimmed'>Nobody is tagged in this album's media yet, and none of it is linked to a location or a device.</Text>
        </InfoSection>
      )}
    </SimpleGrid>
  );
}
