import { Anchor, Button, Container, Stack, Tabs, Text } from '@mantine/core';
import { EntityDetailHeader, PageLoader, TablerIcon } from '@ein/ui/components';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { TrackEditModal } from '../components/TrackEditModal.tsx';
import { TrackInfo } from '../components/TrackInfo.tsx';
import { TrackTripsTab } from '../components/TrackTripsTab.tsx';
import { TrackView } from '../components/TrackView.tsx';
import { useTrackDetail } from '../hooks/useTrackDetail.ts';
import { useTrackUpload } from '../hooks/useTrackUpload.tsx';

const TABS = ['track', 'trips', 'info'] as const;
type TrackTab = typeof TABS[number];

const isTab = (value: string | null): value is TrackTab => value !== null && (TABS as readonly string[]).includes(value);

/** The track's map runs edge to edge under its header. */
export const handle = { fullBleed: true };

/**
 * `/tracks/:id`: one track, `id` its path URI-encoded. Its route on a map (with the fixes it left
 * out, and a GPX upload for whoever may change it), its trips, and what is known about it: how it
 * travels, its timezone, its home bases and its description.
 */
export default function TrackPage() {
  const { id } = useParams();
  const path = id ? decodeURIComponent(id) : undefined;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { track, loading, error, refetch, save } = useTrackDetail(path);
  const access = useAccessIds();

  // The route is what the page opens on; the other tabs are linkable.
  const asked = searchParams.get('tab');
  const tab: TrackTab = isTab(asked) ? asked : 'track';
  const setTab = (value: string | null) => setSearchParams(value && value !== 'track' ? { tab: value } : {}, { replace: true });

  const [editing, setEditing] = useState(false);
  // Raised by an upload, so the map reads the track again.
  const [trackRead, setTrackRead] = useState(0);
  const upload = useTrackUpload(path ?? '', () => {
    setTrackRead((n) => n + 1);
    refetch();
  });

  if (loading && !track) return <PageLoader label='Loading track…' />;

  if (!track) {
    return (
      <Container size='xl' py='md'>
        <Stack gap='lg'>
          <Anchor onClick={() => navigate('/tracks')} c='dimmed' size='sm'>
            ← Tracks
          </Anchor>
          <Text c='dimmed'>{error ?? 'Track not found.'}</Text>
        </Stack>
      </Container>
    );
  }

  const editable = canWrite(track.ownership, access);

  return (
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <EntityDetailHeader
        tabs={
          <Tabs.List>
            <Tabs.Tab value='track' leftSection={<TablerIcon name='route' size={16} />}>Track</Tabs.Tab>
            <Tabs.Tab value='trips' leftSection={<TablerIcon name='map-route' size={16} />}>Trips</Tabs.Tab>
            <Tabs.Tab value='info' leftSection={<TablerIcon name='info-circle' size={16} />}>Info</Tabs.Tab>
          </Tabs.List>
        }
        path={track.path}
        pattern='track'
        title={track.name}
        fallback={<TablerIcon name='route' size={52} />}
        actions={editable
          ? {
            share: track.path,
            edit: () => setEditing(true),
            items: [{ label: upload.sending ? 'Uploading GPX…' : 'Upload GPX', icon: 'upload', button: true, lead: true, disabled: upload.sending, onClick: upload.open }],
          }
          : undefined}
      />

      {/* The body pads itself (AppShell's padding is off so the header can bleed); the map has none. */}
      <Container size='xl' py='md' px='md' display={tab === 'track' ? 'none' : undefined}>
        <Tabs.Panel value='trips'>
          <TrackTripsTab track={track.path} editable={editable} />
        </Tabs.Panel>
        <Tabs.Panel value='info'>
          <TrackInfo track={track} editable={editable} />
        </Tabs.Panel>
      </Container>

      {/* The track's map takes the window below the header, edge to edge, outside the body's padding. */}
      <Tabs.Panel value='track'>
        <TrackView
          key={trackRead}
          path={track.path}
          editable={editable}
          emptyActions={editable && (
            <Button variant='light' leftSection={<TablerIcon name='upload' size={16} />} loading={upload.sending} onClick={upload.open}>Upload GPX</Button>
          )}
        />
      </Tabs.Panel>

      {editable && upload.input}
      <TrackEditModal opened={editing} onClose={() => setEditing(false)} track={track} save={save} />
    </Tabs>
  );
}
