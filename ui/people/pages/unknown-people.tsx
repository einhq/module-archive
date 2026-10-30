import { UnknownPersonModal } from '../components/UnknownPersonModal.tsx';
import { QuickName } from '../components/QuickName.tsx';
import { UnknownSelectionBar } from '../components/UnknownSelectionBar.tsx';
import { EntityDetailHeader, HeaderChoice, HeaderChoices, HeaderFilterBar, HeaderStats, PageLoader, TablerIcon } from '@ein/ui/components';
import { Alert, Badge, Box, Button, Card, Center, Checkbox, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { usePeople } from '../hooks/usePeople.ts';
import { UnknownPerson, UnknownSort, useUnknownPeople, useUnknownPerson } from '../hooks/useUnknownPeople.ts';
import { useSelection } from '@ein/ui/hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FaceCrop } from '../components/FaceCrop.tsx';
import { VoiceClip } from '../components/VoiceClip.tsx';
import { stopClip } from '../lib/clip-player.ts';
import './unknown-people.css';

/** What a card shows of someone, a face or a voice: one big, then up to three small. */
type Glimpse = { key: string; face?: string; voice?: UnknownPerson['voices'][number] };

/** The best faces first, then the voices heard longest. */
const glimpsesOf = (person: UnknownPerson): Glimpse[] =>
  [
    ...person.faces.map((face) => ({ key: face.facePath, face: face.facePath })),
    ...person.voices.map((voice) => ({ key: voice.voicePath, voice })),
  ].slice(0, 4);

function GlimpseView({ glimpse, size, name }: { glimpse: Glimpse; size: number; name: string }) {
  if (glimpse.face) return <FaceCrop facePath={glimpse.face} size={size} alt={size > 40 ? name : ''} />;
  const voice = glimpse.voice!;
  return <VoiceClip clip={{ key: voice.voicePath, ...voice }} size={size} label={voice.filePath?.split('/').pop()} />;
}

export const handle = { fullBleed: true };

// `person-unknown` counts faces and the recordings a voice is heard in together, so the choices
// speak of how often someone was found rather than of faces.
const SORTS = [
  { value: 'faces', label: 'Most found', icon: <TablerIcon name='sort-descending-numbers' size={18} /> },
  { value: 'created', label: 'Newest', icon: <TablerIcon name='clock' size={18} /> },
];

// Short, as a header select is narrow; the choice's label, "Found", says what is counted.
const MIN_FACES = [
  { value: '0', label: 'Any count' },
  { value: '2', label: '2+ times' },
  { value: '5', label: '5+ times' },
  { value: '10', label: '10+ times' },
  { value: '50', label: '50+ times' },
].map((option) => ({ ...option, icon: <TablerIcon name='filter' size={18} /> }));

/** A card's picture: one big face or voice, and up to three small under it. */
function CardGlimpses({ person }: { person: UnknownPerson }) {
  const [lead, ...rest] = glimpsesOf(person);
  return (
    <>
      <Card.Section inheritPadding py='md'>
        <Group justify='center'>
          {lead ? <GlimpseView glimpse={lead} size={96} name={person.name} /> : (
            <Center w={96} h={96}>
              <TablerIcon name='user-question' size={40} />
            </Center>
          )}
        </Group>
      </Card.Section>
      {rest.length > 0 && (
        <Group justify='center' gap='xs' mb='xs'>
          {rest.map((glimpse) => <GlimpseView key={glimpse.key} glimpse={glimpse} size={28} name={person.name} />)}
        </Group>
      )}
    </>
  );
}

export default function UnknownPeoplePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sort: UnknownSort = searchParams.get('sort') === 'created' ? 'created' : 'faces';
  const minFaces = MIN_FACES.some((option) => option.value === searchParams.get('min')) ? Number(searchParams.get('min')) : 0;
  const { people, total, loading, loadingMore, hasMore, loadMore, error, refetch, namePerson, mergeInto, discard, reconcileFaces, reconcileMerge } = useUnknownPeople({
    sort,
    minFaces,
  });
  const { people: named } = usePeople();
  const reviewId = searchParams.get('person');
  const listedReview = reviewId ? people.find((person) => person.id === reviewId) ?? null : null;
  const { person: linkedReview, refetch: refetchLinkedReview } = useUnknownPerson(reviewId ?? undefined, Boolean(reviewId && !listedReview));
  const reviewing: UnknownPerson | null = listedReview ?? linkedReview;

  const openReview = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('person', id);
    setSearchParams(next);
  };

  const setView = (key: 'sort' | 'min', value: string, fallback: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const closeReview = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('person');
    setSearchParams(next, { replace: true });
  };

  // A clip started from a card stops when the page goes.
  useEffect(() => stopClip, []);

  const paths = useMemo(() => people.map((p) => p.path), [people]);
  const selection = useSelection(paths);
  /** The cards whose name box is saving: they pulse until they leave the grid. */
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const markSaving = useCallback((path: string, busy: boolean) =>
    setSaving((current) => {
      const next = new Set(current);
      if (busy) next.add(path);
      else next.delete(path);
      return next;
    }), []);
  const selected = useMemo(() => people.filter((p) => selection.selected.has(p.path)), [people, selection.selected]);

  // The review modal binds Escape itself; clearing the selection from under it would make one
  // key press do two things. Not prevented, so a full-screen surface over the page still closes on it.
  useHotkeys([
    ['Escape', () => !reviewing && selection.clear(), { preventDefault: false }],
    ['mod+A', () => !reviewing && selection.selectAll()],
  ]);

  return (
    <Box>
      <EntityDetailHeader
        title='Unidentified people'
        pattern='person'
        subtitle={
          <Text size='sm' c='gray.2'>
            Faces and voices recognized as the same person, but nobody has said who they are. Click one to see everything found, or tick several to fold them together or say
            they are not a person.
          </Text>
        }
        meta={!loading && (
          <HeaderStats
            items={[
              `${total.toLocaleString()} unidentified`,
              // "Select all" covers only what is loaded, so say how much that is while pages remain.
              people.length < total ? `${people.length.toLocaleString()} loaded` : undefined,
            ]}
          />
        )}
        flowContent
        controls={
          <HeaderFilterBar>
            <HeaderChoices>
              <HeaderChoice label='Sort' value={sort} onChange={(value) => setView('sort', value, 'faces')} options={SORTS} />
              <HeaderChoice label='Found' value={String(minFaces)} onChange={(value) => setView('min', value, '0')} options={MIN_FACES} />
            </HeaderChoices>
          </HeaderFilterBar>
        }
      />

      <Stack gap='lg' px='md' py='lg'>
        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error.message}</Alert>}

        {loading ? <PageLoader label='Loading people…' /> : (
          <>
            {people.length === 0
              ? (
                <Box ta='center' py='xl'>
                  <Text c='dimmed'>
                    {minFaces > 0 ? `Nobody unidentified found ${minFaces} or more times.` : 'Nobody unidentified. Everyone recognized so far has a name.'}
                  </Text>
                </Box>
              )
              : (
                <>
                  <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }}>
                    {people.map((person) => (
                      <Card
                        key={person.id}
                        radius='md'
                        p='md'
                        className='mrx-unknown-card'
                        data-selected={selection.isSelected(person.path) || undefined}
                        data-saving={saving.has(person.path) || undefined}
                        style={{
                          position: 'relative',
                          // A column, so the name box sits at the foot of every card in a row,
                          // whatever is above it: a face and its preview row, or a voice alone.
                          display: 'flex',
                          flexDirection: 'column',
                          cursor: 'pointer',
                          outline: selection.isSelected(person.path) ? '2px solid var(--mantine-primary-color-filled)' : undefined,
                        }}
                        onClick={(event) => {
                          // A pick in the name box's dropdown bubbles here through its portal.
                          if (!event.currentTarget.contains(event.target as Node)) return;
                          // Once anything is ticked the grid is in selection mode, the same
                          // rule the media grid uses: a plain click keeps picking.
                          if (selection.active) selection.toggle(person.path, { range: event.shiftKey, additive: true });
                          else openReview(person.id);
                        }}
                      >
                        <Box
                          style={{ position: 'absolute', top: 8, left: 8, zIndex: 1 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            selection.toggle(person.path, { range: event.shiftKey, additive: true });
                          }}
                        >
                          <Checkbox
                            checked={selection.isSelected(person.path)}
                            readOnly
                            size='sm'
                            radius='xl'
                            aria-label={`Select ${person.name}`}
                            styles={{ input: { cursor: 'pointer' } }}
                          />
                        </Box>

                        {
                          /* A preview only — the review is where all of them are. Enough to tell
                            one card from another at a glance, and a voice can be heard from here. */
                        }
                        <CardGlimpses person={person} />

                        <Stack gap='xs' align='center' mt='auto'>
                          <Group gap={4} justify='center'>
                            {(person.faceCount > 0 || person.voiceCount === 0) && <Badge variant='light'>{person.faceCount} {person.faceCount === 1 ? 'face' : 'faces'}
                            </Badge>}
                            {person.voiceCount > 0 && (
                              <Badge variant='light' color='grape' leftSection={<TablerIcon name='microphone' size={12} />}>
                                heard in {person.voiceCount}
                              </Badge>
                            )}
                          </Group>
                          {!selection.active && (
                            <QuickName
                              path={person.path}
                              named={named}
                              onName={namePerson}
                              onMerge={mergeInto}
                              onBusy={(busy) => markSaving(person.path, busy)}
                            />
                          )}
                        </Stack>
                      </Card>
                    ))}
                  </SimpleGrid>

                  {hasMore && (
                    <Group justify='center'>
                      <Button size='xs' variant='light' onClick={loadMore} loading={loadingMore}>
                        Load more ({people.length} of {total})
                      </Button>
                    </Group>
                  )}
                </>
              )}
          </>
        )}
      </Stack>

      <UnknownPersonModal
        person={reviewing}
        named={named}
        onClose={closeReview}
        onName={namePerson}
        onMerge={mergeInto}
        onDiscard={(path) => discard([path])}
        onFacesChanged={(change) => {
          if (change) reconcileFaces(change);
          else refetch();
          if (!listedReview) refetchLinkedReview();
        }}
      />

      <UnknownSelectionBar
        people={selected}
        onClear={selection.clear}
        onMerged={(change) => change ? reconcileMerge(change) : refetch()}
        onDiscard={(chosen) => discard(chosen.map((person) => person.path))}
      />
    </Box>
  );
}
