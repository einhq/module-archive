import { FamilyTree } from '@ein/ui/components';
import { type FamilyGraph, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { Center, Loader, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GraphResponse } from '@archive/people/api';

const ignore = () => {};

/**
 * A family tree of chosen people: `person`, the `people` named, and the line of relations from
 * `person` to each `to` — what the chat draws under an answer about family (a card archive offers
 * in its `etc/assistant.d/cards.json`), and a page of its own at the same URL. It is the People
 * page's tree, but whole: the answer is the people it names, so no card expands into relations it
 * was not asked to show.
 */
export default function FamilyPage() {
  const [params] = useSearchParams();
  const person = params.get('person') ?? '';
  const people = params.getAll('people');
  const to = params.getAll('to');
  const key = JSON.stringify([person, people, to]);
  const [graph, setGraph] = useState<FamilyGraph | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setGraph(null);
    setFailed(false);
    if (!person) {
      setFailed(true);
      return;
    }
    let live = true;
    // Asked for nobody else, it is the person's own family, as person-graph walks it.
    const chosen = [...people.map((path) => `--only ${shq(path)}`), ...to.map((path) => `--to ${shq(path)}`)].join(' ');
    execCommand<GraphResponse>(`person-graph ${shq(person)} ${chosen || '--up 1 --down 1'}`)
      .then((answer) => live && setGraph(answer.nodes[answer.root] ? answer : null))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [key]);

  const expanded = useMemo(() => new Set(Object.keys(graph?.nodes ?? {})), [graph]);

  if (failed) return <Text size='sm' c='dimmed'>No family to draw.</Text>;
  if (!graph) {
    return (
      <Center mih={120}>
        <Loader size='sm' />
      </Center>
    );
  }
  return (
    <FamilyTree
      graph={graph}
      loading={false}
      expanded={expanded}
      expanding={null}
      onExpand={ignore}
      editable={false}
      onAddRelation={ignore}
      onRemoveRelation={ignore}
      fit
      expandable
    />
  );
}
