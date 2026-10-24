import { Badge, Button, Group } from '@mantine/core';
import { Link } from 'react-router-dom';
import type { LabelEntry } from '@ein/api';
import type { LabelModelSummary } from '@archive/labels/api';
import { ExploreSection, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { paramsFromFilters } from '@ein/ui/lib';

/** A vocabulary word is offered as a label once this many pictures look like it. */
const MIN_SUGGESTED = 5;

/** The Search page asking for one label: the albums that carry it or hold a picture that does. */
const labelTo = (label: string): string => `/search?${paramsFromFilters({ tags: [label] })}`;

/**
 * The Search landing's Labels section (`archive.explore-labels`): every label, the most used first,
 * then the vocabulary's words that pictures look like but nothing carries yet (`label-model list`),
 * most matched first. Either opens the Search page asking for it, where what else looks like it can
 * be labeled. Nothing while there is neither.
 */
export default function ExploreLabels() {
  const { data, loading } = useCommand<LabelEntry[]>('label list');
  const { data: models, loading: modelsLoading } = useCommand<LabelModelSummary[]>('label-model list');
  const labels = (data ?? []).toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const inUse = new Set(labels.map((entry) => entry.label));
  const offered = (models ?? [])
    .filter((model) => model.source === 'vocabulary' && !inUse.has(model.label) && model.matches >= MIN_SUGGESTED)
    .toSorted((a, b) => b.matches - a.matches || a.label.localeCompare(b.label));
  if (!loading && !modelsLoading && labels.length === 0 && offered.length === 0) return null;

  return (
    <ExploreSection icon='tag' title='Labels'>
      <Group gap='xs'>
        {labels.map((entry) => (
          <Button
            key={entry.label}
            component={Link}
            to={labelTo(entry.label)}
            variant='light'
            color='pink'
            radius='xl'
            size='sm'
            leftSection={<TablerIcon name='tag' size={14} />}
            rightSection={<Badge size='xs' variant='transparent' color='pink'>{entry.count}</Badge>}
          >
            {entry.label}
          </Button>
        ))}
        {offered.map((model) => (
          <Button
            key={model.label}
            component={Link}
            to={labelTo(model.label)}
            variant='outline'
            color='pink'
            radius='xl'
            size='sm'
            title={`A suggested label: ${model.matches}${model.matchesCapped ? '+' : ''} pictures look like it, and nothing carries it yet`}
            leftSection={<TablerIcon name='sparkles' size={14} />}
          >
            {model.label}
          </Button>
        ))}
      </Group>
    </ExploreSection>
  );
}
