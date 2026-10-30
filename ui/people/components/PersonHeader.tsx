import { EntityDetailHeader, HeaderDescription, type PageActions, TablerIcon } from '@ein/ui/components';
import { Anchor, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PersonContact, PersonInfo } from '../hooks/usePeople.ts';
import { NodeLabels } from '../../components/NodeLabels.tsx';

/** Just the year — a header is about a life, not about a Tuesday. */
const year = (date?: string): string | undefined => date?.slice(0, 4);

/**
 * The one line that places a person in time.
 *
 * Written as a span when both ends are known, because "1948 – 2011" is how a
 * life is written down everywhere else; a living person gets their birth year
 * and their age instead. `approx` is worn openly: a birth date with no day
 * cannot support an exact age, and quietly rounding it would be the header
 * asserting something it guessed.
 */
export function lifeLine(person: PersonInfo): string | undefined {
  const born = year(person.born);
  const died = year(person.died);
  const age = person.age;
  const about = age?.approx ? '~' : '';

  if (born && died) return age ? `${born} – ${died} · died aged ${about}${age.years}` : `${born} – ${died}`;
  if (died) return `Died ${died}`;
  if (born) return age ? `Born ${born} · ${about}${age.years}` : `Born ${born}`;
  return undefined;
}

/** Where they live now: a home whose span has not been closed. */
export function currentHome(person: PersonInfo): { path: string; label: string } | undefined {
  const open = person.homes.find((home) => !home.to);
  if (!open) return undefined;
  return { path: open.path, label: open.name ?? open.path.split('/').pop() ?? open.path };
}

/**
 * `mailto:` for something that looks like an address, `tel:` for something that
 * looks like a number, plain text otherwise.
 *
 * The `type` is free text entered by whoever recorded it, so it is a hint and
 * not a schema — the shape of the data is the more reliable signal.
 */
export function contactLink(contact: PersonContact): { href?: string; icon: string } {
  if (contact.data.includes('@')) return { href: `mailto:${contact.data}`, icon: 'mail' };
  if (/^[+\d][\d\s()-]{5,}$/.test(contact.data)) return { href: `tel:${contact.data.replace(/\s/g, '')}`, icon: 'phone' };
  return { icon: 'user' };
}

type PersonHeaderProps = {
  person: PersonInfo;
  /** How much media they appear in, and over what years. Absent while it loads. */
  media?: { total: number; range: { min: number; max: number } | null };
  /** What can be done to the person, in the header's corner. */
  actions?: PageActions;
  /** The page's `Tabs.List`, on the header's bottom edge. */
  tabs?: ReactNode;
};

/**
 * Who this person is, over the tabs.
 *
 * What places a person: names, years, where they live, how to reach them. The
 * rest of what the node records is on the Info tab. It is deliberately one band
 * rather than a card in a column: the tabs below own the width, and a sidebar
 * would take it from them on every tab including the ones that need it most.
 */
export function PersonHeader({ person, media, actions, tabs }: PersonHeaderProps) {
  const life = lifeLine(person);
  const home = currentHome(person);
  // The name under the name.
  const alsoKnown = person.fullname && person.fullname !== person.name ? person.fullname : undefined;
  // A birth name only says something when it is not already on screen; it often
  // equals `fullname`, and shown unguarded it would repeat the line above it.
  const bornAs = person.birthname && person.birthname !== person.name && person.birthname !== person.fullname ? person.birthname : undefined;

  return (
    <EntityDetailHeader
      path={person.path}
      pattern='person'
      title={person.name}
      fallback={<TablerIcon name='user' size={56} />}
      coverSize={152}
      actions={actions}
      tabs={tabs}
      subtitle={
        <>
          {alsoKnown && <Text c='dimmed'>{alsoKnown}</Text>}
          {bornAs && <Text size='sm' c='dimmed'>Born as {bornAs}</Text>}
          {life && <Text size='sm'>{life}</Text>}
        </>
      }
      meta={
        <>
          <Group gap='lg' wrap='wrap' mt={4}>
            {home && (
              <Group gap={6} wrap='nowrap'>
                <TablerIcon name='home' size={15} color='var(--mantine-color-dimmed)' />
                <Anchor component={Link} to={`/locations/${encodeURIComponent(home.path.split('/').pop() ?? '')}`} size='sm'>
                  {home.label}
                </Anchor>
              </Group>
            )}

            {(person.contact ?? []).map((contact) => {
              const { href, icon } = contactLink(contact);
              return (
                // Not on a phone, where a person with several numbers and addresses
                // pushes their own name off the cover; the Info tab lists them all.
                <Group gap={6} wrap='nowrap' key={`${contact.type}-${contact.data}`} visibleFrom='sm'>
                  <TablerIcon name={icon} size={15} color='var(--mantine-color-dimmed)' />
                  {href ? <Anchor href={href} size='sm'>{contact.data}</Anchor> : <Text size='sm'>{contact.data}</Text>}
                </Group>
              );
            })}

            {
              /* The count comes from the same facets the media tab's rail is sized
              from, so opening that tab costs nothing extra. */
            }
            {media && media.total > 0 && (
              <Group gap={6} wrap='nowrap'>
                <TablerIcon name='photo' size={15} color='var(--mantine-color-dimmed)' />
                <Text size='sm' c='dimmed'>
                  {media.total.toLocaleString()} photos
                  {media.range ? ` · ${media.range.min}–${media.range.max}` : ''}
                </Text>
              </Group>
            )}
          </Group>

          {person.allergies && (
            <Group gap={6} wrap='nowrap' mt={4}>
              <TablerIcon name='alert-triangle' size={15} color='var(--mantine-color-yellow-6)' />
              <Text size='sm'>{person.allergies}</Text>
            </Group>
          )}

          <NodeLabels path={person.path} mt={4} />

          {person.description && <HeaderDescription text={person.description} heading={person.name} pattern='person' />}
        </>
      }
    />
  );
}
