import { EventModal } from '../components/EventModal.tsx';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import { SetCoverAction } from '../../media/components/SetCoverAction.tsx';
import { SetTimeAction } from '../../media/components/SetTimeAction.tsx';
import { SplitPersonModal } from '../components/SplitPersonModal.tsx';
import { TimelineFeed } from '../../components/TimelineFeed.tsx';
import { FamilyTree, PageLoader, TablerIcon } from '@ein/ui/components';
import { Anchor, Container, Stack, Tabs, Text } from '@mantine/core';
import { PersonFacesTab } from '../components/PersonFacesTab.tsx';
import { PersonVoices } from '../components/PersonVoices.tsx';
import { PersonHeader } from '../components/PersonHeader.tsx';
import { PersonHomesTab } from '../components/PersonHomesTab.tsx';
import { PersonInfoTab } from '../components/PersonInfoTab.tsx';
import { PersonEditModal } from '../components/PersonEditModal.tsx';
import { type RelationKind, RelationModal } from '../components/RelationModal.tsx';
import { RemoveRelationModal } from '../components/RemoveRelationModal.tsx';
import { usePeople, usePerson } from '../hooks/usePeople.ts';
import { forgetSubjectFacets, useSubjectFacets } from '../../hooks/useSubjectFacets.ts';
import { useSubjectTimeline } from '../../hooks/useSubjectTimeline.ts';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite, mediaItemFrom, subjectArg } from '@ein/ui/lib';
import { openMediaAt } from '@ein/ui/signals';
import { usePersonGraph } from '../hooks/usePersonGraph.ts';
import { type CSSProperties, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

const TABS = ['timeline', 'info', 'media', 'faces', 'voices', 'family', 'homes'] as const;
type PersonTab = typeof TABS[number];

const isTab = (value: string | null): value is PersonTab => value !== null && (TABS as readonly string[]).includes(value);

/** Neither sub-feed here pages, so the sentinels have nothing to observe. */
const noSentinel = () => {};

export const handle = { fullBleed: true };

export default function PersonDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { person, loading, refetch } = usePerson(id);
  const access = useAccessIds();
  const isAdmin = access?.admin === true;
  // Their profile, events, the cover and sharing hang off the person node, so they are for whoever
  // may write it.
  const editable = person ? canWrite(person.ownership, access) : false;
  // Merge targets for a group that turns out to be somebody the archive knows.
  const { people: named } = usePeople();
  const [splitting, setSplitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const tab: PersonTab = isTab(searchParams.get('tab')) ? searchParams.get('tab') as PersonTab : 'timeline';

  // The same question the media tab's rail is sized from, so the header's count
  // and the rail can never disagree, and the rail takes this answer rather than
  // asking again.
  const facetFilters = useMemo(() => ({ subjects: id ? [subjectArg('person', id)] : undefined }), [id]);
  const { facets } = useSubjectFacets(facetFilters, Boolean(id));

  const { groups, loading: feedLoading, refetch: refetchFeed } = useSubjectTimeline('person-timeline', person?.path ?? null);

  // Family changes affect the graph, header and feed, so all three are
  // re-read after an edit.
  const { graph, loading: graphLoading, expand, collapse, expanded, expanding, refetch: refetchGraph } = usePersonGraph(
    tab === 'family' ? person?.path ?? null : null,
  );
  const [adding, setAdding] = useState<{ subject: { path: string; name: string }; kind: RelationKind } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const afterEdit = () => {
    refetchGraph();
    refetch();
    refetchFeed();
  };

  if (loading) {
    return <PageLoader label='Loading person…' />;
  }

  if (!person) {
    return (
      <Container size='xl' py='md' px='md'>
        <Stack gap='lg'>
          <Anchor onClick={() => navigate('/people')} c='dimmed' size='sm'>
            ← People
          </Anchor>
          <Text c='dimmed'>Person not found.</Text>
        </Stack>
      </Container>
    );
  }

  // The tab lives in the URL so a person's family or photos can be
  // linked to directly. `keepMounted={false}` because the media tab is
  // the expensive one and its rail is fixed to the viewport — mounted
  // behind another tab it would both fetch and draw.
  return (
    <Tabs
      value={tab}
      onChange={(value) => setSearchParams(value && value !== 'timeline' ? { tab: value } : {}, { replace: true })}
      keepMounted={false}
    >
      <PersonHeader
        person={person}
        tabs={
          <Tabs.List>
            <Tabs.Tab value='timeline' leftSection={<TablerIcon name='calendar-event' size={16} />}>Timeline</Tabs.Tab>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
            <Tabs.Tab value='media' leftSection={<TablerIcon name='photo' size={16} />}>Media</Tabs.Tab>
            <Tabs.Tab value='faces' leftSection={<TablerIcon name='face-id' size={16} />}>Faces</Tabs.Tab>
            <Tabs.Tab value='voices' leftSection={<TablerIcon name='microphone' size={16} />}>Heard in</Tabs.Tab>
            <Tabs.Tab value='family' leftSection={<TablerIcon name='users' size={16} />}>Family</Tabs.Tab>
            <Tabs.Tab value='homes' leftSection={<TablerIcon name='home' size={16} />}>Homes</Tabs.Tab>
          </Tabs.List>
        }
        media={facets ? { total: facets.total, range: facets.range } : undefined}
        // The person node and what hangs off it. The photos they appear in are not below them — a
        // face links the other way — so Share shares the person, not their media.
        actions={{
          share: editable ? person.path : undefined,
          edit: editable ? () => setEditing(true) : undefined,
          items: [
            ...(editable ? [{ label: 'Add event', icon: 'calendar-event', onClick: () => setAddingEvent(true) }] : []),
            // Naming a cluster endorses whatever was in it. When that turns out to have been two
            // people, this is the way back — same dialog as the unidentified popup, pointed at a
            // named person.
            ...(isAdmin ? [{ label: 'Split faces…', icon: 'cut', onClick: () => setSplitting(true) }] : []),
          ],
          trash: editable ? { path: person.path, name: person.name, leaveTo: '/people' } : undefined,
        }}
      />

      {
        /* The body pads itself (AppShell's padding is off so the header can bleed); the
          variable tells the media tab's grid how much to cancel on a phone. */
      }
      <Container size='xl' py='md' px='md' style={{ '--mrx-body-padding': 'var(--mantine-spacing-md)' } as CSSProperties}>
        <Stack gap='lg'>
          <Tabs.Panel value='timeline'>
            <TimelineFeed
              groups={groups}
              loading={feedLoading}
              hasMore={false}
              hasNewer={false}
              sentinelRef={noSentinel}
              topSentinelRef={noSentinel}
              emptyMessage={`Nothing recorded for ${person.name} yet. Add an event to record something.`}
            />
          </Tabs.Panel>

          <Tabs.Panel value='info'>
            <PersonInfoTab person={person} media={facets ? { total: facets.total, range: facets.range } : undefined} />
          </Tabs.Panel>

          <Tabs.Panel value='media'>
            <MediaTimeline
              key={reloadKey}
              person={person.id}
              emptyMessage={`No photos of ${person.name} yet. They appear here once tagged, or once a detected face is assigned to them.`}
              selectionActions={({ selection, items, reload }) => (
                <>
                  <SetTimeAction selection={selection} items={items} onApplied={reload} />
                  {editable && <SetCoverAction selection={selection} items={items} owner={person.path} />}
                </>
              )}
            />
          </Tabs.Panel>

          <Tabs.Panel value='faces'>
            {/* Keyed like the media tab, so a split that took faces away is not still drawn. */}
            <PersonFacesTab key={reloadKey} person={person} named={named} />
          </Tabs.Panel>

          <Tabs.Panel value='voices'>
            <PersonVoices
              key={reloadKey}
              personPath={person.path}
              maxHeight={600}
              emptyText='Not heard in any recording yet.'
              // `atSeconds` is what the lightbox seeks to once the recording loads.
              onPlay={(filePath, atSeconds) => openMediaAt(0, [mediaItemFrom({ path: filePath, atSeconds })])}
            />
          </Tabs.Panel>

          <Tabs.Panel value='family'>
            <FamilyTree
              graph={graph}
              loading={graphLoading}
              expanded={expanded}
              expanding={expanding}
              onExpand={expand}
              onCollapse={collapse}
              editable={isAdmin}
              onAddRelation={(path, kind) => setAdding({ subject: { path, name: graph?.nodes[path]?.name ?? path }, kind })}
              onRemoveRelation={setRemoving}
              emptyMessage={isAdmin
                ? `No family recorded for ${person.name} yet. Use the menu on their card to add a parent, partner or child.`
                : `No family recorded for ${person.name} yet.`}
            />
          </Tabs.Panel>

          <Tabs.Panel value='homes'>
            <PersonHomesTab
              person={person}
              editable={isAdmin}
              onApplied={() => {
                refetch();
                refetchFeed();
              }}
            />
          </Tabs.Panel>
        </Stack>

        <RelationModal
          subject={adding?.subject ?? null}
          kind={adding?.kind ?? 'parent'}
          people={named}
          onClose={() => setAdding(null)}
          onApplied={afterEdit}
        />

        <RemoveRelationModal
          subject={removing ? graph?.nodes[removing] ?? null : null}
          nodes={graph?.nodes ?? {}}
          onClose={() => setRemoving(null)}
          onApplied={afterEdit}
        />

        <SplitPersonModal
          personPath={splitting ? person.path : null}
          personName={person.name}
          named={named}
          onClose={() => setSplitting(false)}
          // Faces that left take their photos with them, so the timeline has to
          // be rebuilt rather than left showing pictures of somebody else.
          onApplied={() => {
            setReloadKey((key) => key + 1);
            forgetSubjectFacets();
            refetch();
          }}
        />

        <PersonEditModal opened={editing} onClose={() => setEditing(false)} person={person} onApplied={afterEdit} />

        <EventModal
          ownerPath={person.path}
          ownerName={person.name}
          opened={addingEvent}
          onClose={() => setAddingEvent(false)}
          onApplied={() => {
            refetch();
            refetchFeed();
          }}
        />
      </Container>
    </Tabs>
  );
}
