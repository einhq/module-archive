import { TablerIcon } from '@ein/ui/components';
import { Anchor, Group, SimpleGrid, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { PersonInfo } from '../hooks/usePeople.ts';
import { formatRange } from '@ein/ui/lib';
import { contactLink } from './PersonHeader.tsx';
import { spanLine } from '../../lib/residence-span.ts';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { UserText } from '../../components/UserText.tsx';

type PersonInfoTabProps = {
  person: PersonInfo;
  /** How much media they appear in, and over what years. Absent while it loads. */
  media?: { total: number; range: { min: number; max: number } | null };
};

/** A date at the precision it was recorded, without any time of day it carries. */
const day = (date?: string): string | undefined => (date ? formatRange(date.split('T')[0]) : undefined);

const slugOf = (path: string): string => encodeURIComponent(path.split('/').pop() ?? path);

/**
 * Everything the person node records, in one place.
 *
 * The header keeps only what places a person — names, years, where they live —
 * and on a phone not even their contact details, which would push the name off
 * the cover. This tab is where the rest lives, on every screen size: every
 * contact with its type, the full dates, homes with their spans, the family
 * the node links to, and the whole description.
 */
export function PersonInfoTab({ person, media }: PersonInfoTabProps) {
  const contacts = person.contact ?? [];
  const homes = [...person.homes].sort((a, b) => {
    if (Boolean(a.to) !== Boolean(b.to)) return a.to ? 1 : -1;
    return (b.from ?? '').localeCompare(a.from ?? '');
  });
  const age = person.age;

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md' maw={1100}>
      <InfoSection title='Person'>
        <InfoFact label='Name'>{person.name}</InfoFact>
        {person.fullname && person.fullname !== person.name && <InfoFact label='Full name'>{person.fullname}</InfoFact>}
        {person.birthname && person.birthname !== person.fullname && person.birthname !== person.name && <InfoFact label='Born as'>{person.birthname}</InfoFact>}
        {person.gender && <InfoFact label='Gender'>{person.gender}</InfoFact>}
        {person.born && <InfoFact label='Born'>{day(person.born)}</InfoFact>}
        {person.died && <InfoFact label='Died'>{day(person.died)}</InfoFact>}
        {age && <InfoFact label={age.atDeath ? 'Age at death' : 'Age'}>{`${age.approx ? '~' : ''}${age.years}`}</InfoFact>}
        {media && media.total > 0 && (
          <InfoFact label='Photos'>
            {media.total.toLocaleString()}
            {media.range ? ` · ${media.range.min}–${media.range.max}` : ''}
          </InfoFact>
        )}
      </InfoSection>

      {contacts.length > 0 && (
        <InfoSection title='Contact'>
          {contacts.map((contact) => {
            const { href, icon } = contactLink(contact);
            return (
              <InfoFact key={`${contact.type}-${contact.data}`} label={contact.type || 'Contact'}>
                <Group gap={6} wrap='nowrap'>
                  <TablerIcon name={icon} size={15} color='var(--mantine-color-dimmed)' style={{ flexShrink: 0 }} />
                  {href ? <Anchor href={href} size='sm'>{contact.data}</Anchor> : contact.data}
                </Group>
              </InfoFact>
            );
          })}
        </InfoSection>
      )}

      {person.allergies && (
        <InfoSection title='Allergies'>
          <Group gap={6} wrap='nowrap' align='flex-start'>
            <TablerIcon name='alert-triangle' size={16} color='var(--mantine-color-yellow-6)' style={{ flexShrink: 0, marginTop: 2 }} />
            <Text size='sm'>{person.allergies}</Text>
          </Group>
        </InfoSection>
      )}

      {homes.length > 0 && (
        <InfoSection title='Homes'>
          {homes.map((home) => (
            <Group key={home.path} gap={6} wrap='nowrap' justify='space-between'>
              <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                <TablerIcon name='home' size={15} color='var(--mantine-color-dimmed)' style={{ flexShrink: 0 }} />
                <Anchor component={Link} to={`/locations/${slugOf(home.path)}`} size='sm' truncate>
                  {home.name ?? home.path.split('/').pop()}
                </Anchor>
              </Group>
              <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{spanLine(home)}</Text>
            </Group>
          ))}
        </InfoSection>
      )}

      {person.relations.length > 0 && (
        <InfoSection title='Family'>
          {person.relations.map((relation) => (
            <InfoFact key={`${relation.role}-${relation.path}`} label={relation.role}>
              <Anchor component={Link} to={`/people/${slugOf(relation.path)}`} size='sm'>
                {relation.name ?? relation.path.split('/').pop()}
              </Anchor>
              {(relation.from || relation.to) && <Text span size='xs' c='dimmed'>{`  ${spanLine(relation)}`}</Text>}
            </InfoFact>
          ))}
        </InfoSection>
      )}

      {person.description && (
        <InfoSection title='About'>
          <UserText text={person.description} size='sm' />
        </InfoSection>
      )}
    </SimpleGrid>
  );
}
