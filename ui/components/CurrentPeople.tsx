import { Anchor, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { PEOPLE_ROOT } from '@archive/paths';
import { openRoute } from '@ein/ui/signals';
import { spanLine } from '../lib/residence-span.ts';

/** Someone tied to the page's subject: a resident of a location, an owner of a device. */
type TiedPerson = {
  /** Person slug, the node's name under /people. */
  id: string;
  name: string;
  from?: string;
  to?: string;
};

/**
 * The ones whose tie is still open — the same rule as a person's current home:
 * no end date. A tie with no dates at all counts, since nothing says it ended.
 */
const currentOf = (people: readonly TiedPerson[]): TiedPerson[] =>
  people.filter((person) => !person.to).sort((a, b) => (b.from ?? '').localeCompare(a.from ?? '') || a.name.localeCompare(b.name));

/** How many names the header shows before it says "and N more"; the tab has the rest. */
const HEADER_LIMIT = 3;

/** A person's page, as whichever module gives one (`ui.open`); without one, nowhere. */
const personRoute = (id: string) => openRoute('person', `${PEOPLE_ROOT}/${id}`) ?? '#';

/**
 * Who lives here, or who has it now, as one line of the header's meta — where a
 * person's header shows their current home.
 */
export function CurrentPeopleLine({ people, label }: { people: readonly TiedPerson[]; label: string }) {
  const current = currentOf(people);
  if (current.length === 0) return null;
  const shown = current.slice(0, HEADER_LIMIT);
  const more = current.length - shown.length;

  return (
    <Group gap={6} wrap='nowrap' mt={4} aria-label={label}>
      <TablerIcon name='user' size={15} color='var(--mantine-color-dimmed)' style={{ flexShrink: 0 }} />
      <Text size='sm' lineClamp={1}>
        {shown.map((person, index) => (
          <Fragment key={person.id}>
            {index > 0 && ', '}
            <Anchor component={Link} to={personRoute(person.id)} size='sm'>{person.name}</Anchor>
          </Fragment>
        ))}
        {more > 0 && <Text span size='sm' c='dimmed'>{` and ${more} more`}</Text>}
      </Text>
    </Group>
  );
}

type CurrentPeopleCardProps = {
  title: string;
  people: readonly TiedPerson[];
  /** Said when nobody's tie is open. */
  emptyText: string;
  /** Opens the tab with everyone, past ones and editing included. */
  onShowAll: () => void;
  showAllLabel: string;
};

/** The current ones on the Info tab, with how long; the full history is its own tab. */
export function CurrentPeopleCard({ title, people, emptyText, onShowAll, showAllLabel }: CurrentPeopleCardProps) {
  const current = currentOf(people);

  return (
    <Card radius='md'>
      <Title order={3} size='h4' mb='sm'>
        {title}
      </Title>
      {current.length === 0 ? <Text size='sm' c='dimmed'>{emptyText}</Text> : (
        <Stack gap='xs'>
          {current.map((person) => (
            <Group key={person.id} gap='xs' wrap='nowrap' justify='space-between'>
              <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
                <TablerIcon name='user' size={16} color='gray' style={{ flexShrink: 0 }} />
                <Anchor component={Link} to={personRoute(person.id)} size='sm' lineClamp={1}>{person.name}</Anchor>
              </Group>
              <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{spanLine(person)}</Text>
            </Group>
          ))}
        </Stack>
      )}
      {people.length > 0 && (
        <Button size='compact-xs' variant='subtle' mt='sm' onClick={onShowAll}>
          {showAllLabel}
        </Button>
      )}
    </Card>
  );
}
