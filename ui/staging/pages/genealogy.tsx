import type { GedcomChoice, GedcomImportResult, GedcomPlan } from '@archive/people/api';
import { stagingRoots } from '@archive/staging/paths';
import { EmptyState, EntityDetailHeader, FamilyTree, PageLoader, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { countOf, type FamilyNode, type NodeChildEntry, shq } from '@ein/ui/lib';
import { currentUser, execCommand } from '@ein/ui/signals';
import { Alert, Box, Button, Card, Group, LoadingOverlay, ScrollArea, SegmentedControl, SimpleGrid, Stack, Text } from '@mantine/core';
import { useElementSize, useMediaQuery } from '@mantine/hooks';
import { useSignals } from '@preact/signals-react/runtime';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GedcomChoicePanel } from '../../people/components/GedcomChoicePanel.tsx';
import { GedcomMergeCard, MERGE_KINDS } from '../../people/components/GedcomMergeCard.tsx';
import { buildMerge, choiceWords, type MergeKind } from '../../people/lib/gedcom-merge.ts';
import { refreshStagingStatus } from '../hooks/useStagingStatus.ts';

export const handle = { fullBleed: true, signedIn: true };

const SUBTITLE = 'Say who each person in the family tree is before it joins the archive. Nothing is written until you import.';

/** No card is expanded: the merged tree is drawn whole. */
const NONE = { up: new Set<string>(), down: new Set<string>() };
const ignore = () => {};
/** A lone individual's card: as tall as the tree's. */
const LOOSE_CARD_HEIGHT = 64;
/** How wide the selected person's panel floats over the tree, and how far from its edges. */
const PANEL_WIDTH = 380;
const PANEL_GAP = 12;

type Choices = Record<string, GedcomChoice>;

/** The choices made for a file in this browser, kept until it is imported. */
const storeKey = (path: string) => `ein.gedcom-choices:${path}`;
const readChoices = (path: string): Choices => {
  try {
    return JSON.parse(localStorage.getItem(storeKey(path)) ?? '{}') as Choices;
  } catch {
    return {};
  }
};
const keepChoices = (path: string, choices: Choices) => {
  try {
    if (Object.keys(choices).length === 0) localStorage.removeItem(storeKey(path));
    else localStorage.setItem(storeKey(path), JSON.stringify(choices));
  } catch {
    // Not kept: the choices last as long as the page.
  }
};

/**
 * `/staging/genealogy`: the GEDCOM files waiting in the reader's staging area (`genealogy/`, where
 * `gedcom-stage` puts a staged one), one at a time (`?file=` names it). The file's family tree is
 * drawn with the archive's people it matches (`gedcom-read`): each card is an individual, found in
 * the archive, to decide between people who fit, or new; a matched one brings their relatives in
 * the archive along. Selecting a card says who they are — one of the people who fit, anyone else,
 * a new person, or nobody — and the tree is read again with that choice, so a choice can settle
 * relatives too. Import runs `gedcom-import` with every choice.
 */
export default function GenealogyPage() {
  useSignals();
  const user = currentUser.value?.username;
  if (!user) return <Alert color='yellow' m='lg'>Sign in to import a family tree.</Alert>;
  return <Genealogy user={user} />;
}

function Genealogy({ user }: { user: string }) {
  const { genealogyPath } = stagingRoots(user);
  const [params, setParams] = useSearchParams();
  const listing = useCommand<NodeChildEntry[]>(`ls -l ${shq(genealogyPath)}`);
  const waiting = useMemo(
    () => (listing.data ?? []).filter((entry) => entry.node.type === 'file').map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
    [listing.data],
  );
  const asked = params.get('file');
  const name = asked && waiting.includes(asked) ? asked : waiting[0];

  if (listing.loading && !listing.data) return <PageLoader label='Reading your staging area…' />;
  if (!name) {
    return (
      <>
        <EntityDetailHeader eyebrow='Staging' title='Family trees' pattern='mixed' subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>} flowContent />
        <Box p='lg'>
          <EmptyState title='No family tree waits'>A GEDCOM (.ged) file uploaded to staging waits here to be looked over and imported.</EmptyState>
        </Box>
      </>
    );
  }
  return (
    <Review
      key={name}
      path={`${genealogyPath}/${name}`}
      name={name}
      waiting={waiting}
      onFile={(next) => {
        setParams({ file: next }, { replace: true });
        listing.refetch();
      }}
    />
  );
}

type ReviewProps = {
  path: string;
  name: string;
  /** Every waiting file's name, this one among them. */
  waiting: string[];
  /** Open another waiting file; the list is read again, since an imported one has gone from it. */
  onFile: (name: string) => void;
};

function Review({ path, name, waiting, onFile }: ReviewProps) {
  const navigate = useNavigate();
  const [choices, setChoices] = useState<Choices>(() => readChoices(path));
  const [plan, setPlan] = useState<GedcomPlan | null>(null);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<GedcomImportResult | null>(null);

  const words = choiceWords(choices).map(shq).join(' ');
  useEffect(() => {
    let live = true;
    setReading(true);
    execCommand<GedcomPlan>(`gedcom-read ${shq(path)} ${words}`)
      .then((answer) => {
        if (!live) return;
        setPlan(answer);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
  }, [path, words]);

  const merge = useMemo(() => (plan ? buildMerge(plan) : null), [plan]);
  // Until a card is pressed, the first one to decide on, else the first of the file.
  const shown = selected && merge?.cards[selected] ? selected : plan?.individuals.find((each) => merge?.cards[each.xref]?.kind === 'unsure')?.xref ??
    plan?.individuals[0]?.xref;
  const card = shown ? merge?.cards[shown] : undefined;

  // The individual chosen for stays selected, so the panel shows what the choice did.
  const choose = useCallback((xref: string, choice: GedcomChoice | undefined) => {
    setSelected(xref);
    setChoices((current) => {
      const next = { ...current };
      // A person is one individual's: choosing them here unsays them for anyone else.
      if (choice?.kind === 'person') {
        for (const [other, said] of Object.entries(next)) if (said.kind === 'person' && said.person === choice.person) delete next[other];
      }
      if (choice) next[xref] = choice;
      else delete next[xref];
      keepChoices(path, next);
      return next;
    });
  }, [path]);

  const forget = () => {
    keepChoices(path, {});
    setChoices({});
  };

  const importNow = async () => {
    setImporting(true);
    setError(null);
    try {
      const answer = await execCommand<GedcomImportResult>(`gedcom-import ${shq(path)} ${words}`);
      keepChoices(path, {});
      setResult(answer);
      refreshStagingStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const counts = useMemo(() => {
    const by: Partial<Record<MergeKind, number>> = {};
    for (const each of Object.values(merge?.cards ?? {})) by[each.kind] = (by[each.kind] ?? 0) + 1;
    return by;
  }, [merge]);

  // A card pressed is selected, and brings back the panel if it was closed.
  const [panelOpen, setPanelOpen] = useState(true);
  const { ref: panelRef, height: panelHeight } = useElementSize();
  const select = useCallback((key: string) => {
    setSelected(key);
    setPanelOpen(true);
  }, []);

  const renderCard = useCallback(
    (node: FamilyNode) => merge?.cards[node.path] && <GedcomMergeCard card={merge.cards[node.path]} selected={node.path === shown} onSelect={select} />,
    [merge, shown, select],
  );

  // The tree drawn is the part of the merged tree the selected card is in; with several parts, a
  // switch over the tree picks another, selecting its first card.
  const parts = useMemo(() => {
    if (!merge) return [];
    const named = (key: string) => (merge.cards[key].individual ?? merge.cards[key].archive)?.name || key;
    return [
      ...merge.trees.map((tree) => ({ value: `tree:${tree.graph.root}`, label: `${named(tree.graph.root)}'s family (${tree.size})`, keys: Object.keys(tree.graph.nodes) })),
      ...(merge.loose.length > 0 ? [{ value: 'loose', label: `Related to nobody (${merge.loose.length})`, keys: merge.loose }] : []),
    ];
  }, [merge]);
  const part = parts.find((each) => shown && each.keys.includes(shown)) ?? parts[0];
  const tree = merge?.trees.find((each) => part?.value === `tree:${each.graph.root}`);

  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const panelShown = Boolean(card && panelOpen);
  const inset = !panelShown ? undefined : phone ? { bottom: panelHeight + 2 * PANEL_GAP } : { right: PANEL_WIDTH + 2 * PANEL_GAP };

  const legend = plan && (
    <Group gap='md' wrap='wrap' mt={6}>
      <Text size='sm' c='gray.2'>{countOf(plan.individuals.length, 'person', 'people')} in the file:</Text>
      {(Object.keys(MERGE_KINDS) as MergeKind[]).filter((kind) => counts[kind]).map((kind) => (
        <Group key={kind} gap={6} wrap='nowrap'>
          <Box w={10} h={10} style={{ borderRadius: 2, background: `var(--mantine-color-${MERGE_KINDS[kind].color}-6)` }} />
          <Text size='sm' c='gray.2'>{counts[kind]} {counts[kind] === 1 ? MERGE_KINDS[kind].label.toLowerCase() : MERGE_KINDS[kind].many}</Text>
        </Group>
      ))}
    </Group>
  );

  const header = (
    <EntityDetailHeader
      eyebrow='Staging · Family tree'
      title={name}
      pattern='mixed'
      subtitle={
        <Stack gap={0}>
          <Text size='sm' c='gray.2'>{SUBTITLE}</Text>
          {!result && legend}
          {!result && waiting.length > 1 && (
            <SegmentedControl size='xs' mt='xs' data={waiting} value={name} onChange={onFile} style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }} />
          )}
        </Stack>
      }
      flowContent
      actions={result ? undefined : {
        items: [
          {
            label: importing ? 'Importing…' : 'Import',
            icon: 'file-import',
            button: true,
            disabled: !plan || reading || importing || Boolean(error),
            onClick: () => void importNow(),
          },
          ...(Object.keys(choices).length > 0 ? [{ label: 'Forget my choices', icon: 'eraser', onClick: forget }] : []),
          { label: 'Back to staging', icon: 'arrow-left', onClick: () => navigate('/staging') },
        ],
        trash: { path, name, leaveTo: '/staging' },
      }}
    />
  );

  if (result) {
    const rest = waiting.filter((each) => each !== name);
    return (
      <>
        {header}
        <Box p='lg'>
          <Alert color='teal' icon={<TablerIcon name='check' size={18} />} title='Imported'>
            <Stack gap='xs'>
              <Text size='sm'>
                {countOf(result.matched.length, 'person', 'people')} found in the archive, {countOf(result.created.length, 'person', 'people')} made,{' '}
                {countOf(result.parents + result.partners, 'relation', 'relations')} added. The file is kept in {result.source}.
              </Text>
              {result.skipped.length > 0 && (
                <Text size='sm' c='dimmed'>
                  {countOf(result.skipped.length, 'thing was', 'things were')} left out: {result.skipped.map((skip) => `${skip.xref} ${skip.reason}`).join('; ')}.
                </Text>
              )}
              <Group gap='xs'>
                <Button size='xs' variant='light' onClick={() => navigate('/people')}>People</Button>
                {rest.length > 0 && <Button size='xs' variant='light' onClick={() => onFile(rest[0])}>Next family tree</Button>}
                <Button size='xs' variant='subtle' onClick={() => navigate('/staging')}>Back to staging</Button>
              </Group>
            </Stack>
          </Alert>
        </Box>
      </>
    );
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - var(--app-shell-header-height))' }}>
      {header}
      <Box style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {!plan || !merge ? (!error && <PageLoader label='Reading the family tree…' />) : tree
          ? (
            <FamilyTree
              key={tree.graph.root}
              graph={tree.graph}
              loading={false}
              expanded={NONE}
              expanding={null}
              onExpand={ignore}
              editable={false}
              onAddRelation={ignore}
              onRemoveRelation={ignore}
              renderCard={renderCard}
              fit
              fill
              inset={inset}
            />
          )
          : (
            <ScrollArea style={{ flex: 1 }} pr={inset?.right} pb={inset?.bottom}>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 4 }} spacing='xs' p='md' pt={parts.length > 1 ? 56 : 'md'}>
                {merge.loose.map((key) => (
                  <Card key={key} withBorder radius='md' p={0} h={LOOSE_CARD_HEIGHT}>
                    <GedcomMergeCard card={merge.cards[key]} selected={key === shown} onSelect={select} />
                  </Card>
                ))}
              </SimpleGrid>
            </ScrollArea>
          )}
        <LoadingOverlay visible={reading && Boolean(plan)} overlayProps={{ blur: 1, backgroundOpacity: 0.2 }} loaderProps={{ size: 'sm' }} />

        <Stack gap='xs' style={{ position: 'absolute', top: PANEL_GAP, left: PANEL_GAP, right: (inset?.right ?? 0) + PANEL_GAP + 56, zIndex: 3, pointerEvents: 'none' }}>
          {parts.length > 1 && part && (
            <SegmentedControl
              size='xs'
              data={parts.map((each) => ({ value: each.value, label: each.label }))}
              value={part.value}
              onChange={(value) => {
                const next = parts.find((each) => each.value === value);
                if (next) select(next.keys.find((key) => merge?.cards[key]?.individual) ?? next.keys[0]);
              }}
              style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto', pointerEvents: 'auto' }}
            />
          )}
          {error && (
            <Alert color='red' title='The family tree could not be read' style={{ pointerEvents: 'auto' }}>
              <Stack gap='xs' align='flex-start'>
                <Text size='sm'>{error}</Text>
                {Object.keys(choices).length > 0 && <Button size='xs' variant='light' color='red' onClick={forget}>Forget my choices</Button>}
              </Stack>
            </Alert>
          )}
        </Stack>

        {plan && merge && card && panelOpen && (
          <Box
            ref={panelRef}
            style={{
              position: 'absolute',
              zIndex: 3,
              overflowY: 'auto',
              borderRadius: 'var(--mantine-radius-md)',
              boxShadow: 'var(--mantine-shadow-lg)',
              ...(phone
                ? { left: PANEL_GAP, right: PANEL_GAP, bottom: PANEL_GAP, maxHeight: '55%' }
                : { top: PANEL_GAP, right: PANEL_GAP, width: PANEL_WIDTH, maxHeight: `calc(100% - ${2 * PANEL_GAP}px)` }),
            }}
          >
            <GedcomChoicePanel plan={plan} merge={merge} card={card} onChoose={choose} onSelect={select} onClose={() => setPanelOpen(false)} busy={reading || importing} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
