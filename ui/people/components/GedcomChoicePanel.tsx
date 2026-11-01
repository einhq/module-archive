import type { GedcomChoice, GedcomPlan, GedcomPlanPerson } from '@archive/people/api';
import { lifeSpan, TablerIcon } from '@ein/ui/components';
import { openRoute } from '@ein/ui/signals';
import { Alert, Anchor, Badge, Button, Card, Group, Select, Stack, Table, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { usePeople } from '../hooks/usePeople.ts';
import { attrFate, type Merge, type MergeCard } from '../lib/gedcom-merge.ts';
import { MERGE_KINDS } from './GedcomMergeCard.tsx';

type Individual = GedcomPlan['individuals'][number];

type Props = {
  plan: GedcomPlan;
  merge: Merge;
  card: MergeCard;
  /** Say who an individual is; undefined lets the import decide again. */
  onChoose: (xref: string, choice: GedcomChoice | undefined) => void;
  onSelect: (key: string) => void;
  /** Waiting on a choice just made. */
  busy: boolean;
};

const ATTRS = [
  ['name', 'Name'],
  ['fullname', 'Full name'],
  ['birthname', 'Birth name'],
  ['born', 'Born'],
  ['died', 'Died'],
  ['gender', 'Gender'],
] as const;

const personLink = (path: string, children: ReactNode) => <Anchor component={Link} to={openRoute('person', path) ?? '#'} size='sm'>{children}</Anchor>;

/**
 * The card selected in the merged tree, and what can be said of it. For an individual: what the
 * file says beside what the archive has of the person they are matched to, which of the file's
 * values the import would add, the people who could be them, and the choice of one of those,
 * anyone else, a new person, or leaving them out. For a person only the archive has: which of the
 * file's individuals they are.
 */
export function GedcomChoicePanel({ plan, merge, card, onChoose, onSelect, busy }: Props) {
  const kind = MERGE_KINDS[card.kind];
  return (
    <Card withBorder radius='md' padding='md'>
      <Stack gap='md'>
        <Group justify='space-between' align='flex-start' wrap='nowrap' gap='xs'>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Title order={4} style={{ overflowWrap: 'anywhere' }}>{(card.individual ?? card.archive)?.name || card.key}</Title>
            <Text size='xs' c='dimmed'>{card.individual ? `${card.individual.xref} in the file` : 'In the archive, not in the file'}</Text>
          </Stack>
          <Badge color={kind.color} variant='light' style={{ flex: 'none' }}>{kind.label}</Badge>
        </Group>
        {card.individual
          ? <IndividualChoice plan={plan} merge={merge} individual={card.individual} onChoose={onChoose} onSelect={onSelect} busy={busy} />
          : card.person && <ArchiveOnly plan={plan} merge={merge} path={card.person} onChoose={onChoose} busy={busy} />}
      </Stack>
    </Card>
  );
}

function IndividualChoice({ plan, merge, individual, onChoose, onSelect, busy }: Omit<Props, 'card'> & { individual: Individual }) {
  const { people } = usePeople();
  const person = individual.person ? plan.people[individual.person] : undefined;
  const matchedBy = new Map(plan.individuals.flatMap((each) => each.person && each.xref !== individual.xref ? [[each.person, each]] : []));
  const choose = (choice: GedcomChoice | undefined) => onChoose(individual.xref, choice);
  const isNew = individual.action === 'new';
  const isSkipped = individual.action === 'skip';

  return (
    <>
      <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing='xs' fz='sm' layout='fixed'>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w='28%' />
            <Table.Th>In the file</Table.Th>
            {person && <Table.Th>{personLink(individual.person!, 'In the archive')}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {ATTRS.map(([key, label]) => {
            const theirs = individual[key];
            const ours = person?.[key];
            if (!theirs && !ours) return null;
            const fate = person ? attrFate(theirs, ours) : null;
            return (
              <Table.Tr key={key}>
                <Table.Td c='dimmed'>{label}</Table.Td>
                <Table.Td c={fate === 'differs' ? 'orange.7' : undefined} style={{ overflowWrap: 'anywhere' }}>{theirs ?? '—'}</Table.Td>
                {person && (
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    {fate === 'added' ? <Text span size='sm' c='teal.7' title='The import adds it'>+ {theirs}</Text> : ours ?? '—'}
                  </Table.Td>
                )}
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {person && (
        <Text size='xs' c='dimmed'>
          The import fills in what the archive lacks (<Text span c='teal.7' size='xs'>+</Text>) and never changes what it has.
        </Text>
      )}
      {person && !person.writable && (
        <Alert color='yellow' variant='light' p='xs'>
          <Text size='sm'>You may not change {person.name}: the import finds them, but adds nothing to them.</Text>
        </Alert>
      )}

      <Stack gap='xs'>
        <Text fw={600} size='sm'>Who is this?</Text>
        {individual.candidates.length === 0 && !person && <Text size='sm' c='dimmed'>Nobody in the archive fits the name and dates.</Text>}
        {individual.candidates.map((fit) => (
          <Candidate
            key={fit.person}
            path={fit.person}
            person={plan.people[fit.person]}
            score={fit.score}
            matched={individual.person === fit.person}
            other={matchedBy.get(fit.person)}
            busy={busy}
            onChoose={() => choose({ kind: 'person', person: fit.person })}
          />
        ))}
        {person && !individual.candidates.some((fit) => fit.person === individual.person) && (
          <Candidate path={individual.person!} person={person} matched busy={busy} onChoose={() => {}} />
        )}
        <EntityPicker
          kind='person'
          size='sm'
          placeholder='Someone else in the archive…'
          aria-label='Someone else in the archive'
          data={personOptions(people, individual.person)}
          value={null}
          disabled={busy}
          onChange={(path) => path && choose({ kind: 'person', person: path })}
        />
        <Group gap='xs'>
          <Button
            size='xs'
            variant={isNew ? 'filled' : 'default'}
            color='grape'
            leftSection={<TablerIcon name='user-plus' size={14} />}
            disabled={busy || (isNew && individual.chosen)}
            onClick={() => choose({ kind: 'new' })}
          >
            New person
          </Button>
          <Button
            size='xs'
            variant={isSkipped ? 'filled' : 'default'}
            color='red'
            leftSection={<TablerIcon name='user-off' size={14} />}
            disabled={busy || isSkipped}
            onClick={() => choose({ kind: 'skip' })}
          >
            Leave out
          </Button>
          {individual.chosen && (
            <Button size='xs' variant='subtle' leftSection={<TablerIcon name='wand' size={14} />} disabled={busy} onClick={() => choose(undefined)}>
              Let the import decide
            </Button>
          )}
        </Group>
      </Stack>

      <Relatives merge={merge} individual={individual} onSelect={onSelect} />
    </>
  );
}

type CandidateProps = {
  path: string;
  person?: GedcomPlanPerson;
  score?: number;
  /** They are who the individual is now. */
  matched: boolean;
  /** Another individual they are matched to now, whom choosing them here takes them from. */
  other?: Individual;
  busy: boolean;
  onChoose: () => void;
};

function Candidate({ path, person, score, matched, other, busy, onChoose }: CandidateProps) {
  const span = person ? lifeSpan(person) : undefined;
  return (
    <Group gap='xs' wrap='nowrap' justify='space-between'>
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Group gap={6} wrap='nowrap'>
          {personLink(path, person?.name ?? path)}
          {span && <Text size='xs' c='dimmed' style={{ flex: 'none' }}>{span}</Text>}
        </Group>
        <Text size='xs' c='dimmed'>
          {[score !== undefined ? `fits ${score}` : undefined, other ? `now ${other.name} (${other.xref})` : undefined].filter(Boolean).join(' · ')}
        </Text>
      </Stack>
      {matched
        ? <Badge color='teal' variant='light' style={{ flex: 'none' }}>This is them</Badge>
        : (
          <Button size='compact-xs' variant='light' disabled={busy} onClick={onChoose} style={{ flex: 'none' }}>
            This is them
          </Button>
        )}
    </Group>
  );
}

/** The individual's parents, partners and children in the merged tree, each selecting their card. */
function Relatives({ merge, individual, onSelect }: { merge: Merge; individual: Individual; onSelect: (key: string) => void }) {
  const node = merge.trees.map((tree) => tree.graph.nodes[individual.xref]).find(Boolean);
  if (!node) return null;
  const rows = [
    ['Parents', node.parents],
    ['Partners', node.partners.map((partner) => partner.path)],
    ['Children', node.children],
  ] as const;
  return (
    <Stack gap={4}>
      {rows.filter(([, keys]) => keys.length > 0).map(([label, keys]) => (
        <Group key={label} gap={6} align='baseline' wrap='wrap'>
          <Text size='xs' c='dimmed' w={60}>{label}</Text>
          {keys.map((key) => {
            const card = merge.cards[key];
            return (
              <Anchor key={key} component='button' type='button' size='sm' onClick={() => onSelect(key)}>
                {(card.individual ?? card.archive)?.name || key}
              </Anchor>
            );
          })}
        </Group>
      ))}
    </Stack>
  );
}

function ArchiveOnly({ plan, merge, path, onChoose, busy }: { plan: GedcomPlan; merge: Merge; path: string; onChoose: Props['onChoose']; busy: boolean }) {
  const person = plan.people[path];
  const related = Object.values(merge.cards).filter((card) =>
    card.individual && card.archive && [...card.archive.parents, ...card.archive.children, ...card.archive.partners].includes(path)
  );
  const open = plan.individuals.filter((each) => each.action !== 'match');
  return (
    <>
      <Text size='sm'>
        {personLink(path, 'Open their page')} · {lifeSpan(person) ?? 'no dates'}
      </Text>
      {related.length > 0 && (
        <Text size='sm' c='dimmed'>
          Drawn here because the archive relates them to {related.map((card) => card.archive!.name).join(', ')}.
        </Text>
      )}
      <Select
        label='Is one of the file’s individuals'
        placeholder={open.length > 0 ? 'Pick an individual' : 'Every individual is matched'}
        searchable
        size='sm'
        disabled={busy || open.length === 0}
        data={open.map((each) => ({ value: each.xref, label: `${each.name || each.xref}${lifeSpan(each) ? ` (${lifeSpan(each)})` : ''}` }))}
        value={null}
        onChange={(xref) => xref && onChoose(xref, { kind: 'person', person: path })}
      />
    </>
  );
}
