import { Alert, Box, Button, Group, SegmentedControl, Stack } from '@mantine/core';
import { EmptyState, PageLoader, TablerIcon } from '@ein/ui/components';
import { useAccessIds } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TrackEditModal } from '../components/TrackEditModal.tsx';
import { TrackInfo } from '../components/TrackInfo.tsx';
import { TrackTripsTab } from '../components/TrackTripsTab.tsx';
import { TrackView } from '../components/TrackView.tsx';
import { useTrackDetail } from '../hooks/useTrackDetail.ts';
import { useTrackUpload } from '../hooks/useTrackUpload.tsx';

type View = 'trips' | 'travel' | 'fixes';

const VIEWS: { value: View; label: string }[] = [
  { value: 'trips', label: 'Trips' },
  { value: 'travel', label: 'Travel' },
  { value: 'fixes', label: 'Fixes' },
];

/** How tall the map of the fixes is: the tab sits under the device's header, so it gets a share of the window. */
const FIXES_HEIGHT = 'calc(100dvh - 260px)';

/**
 * `/trips?device=<path>`: what a device travelled, as the Trips tab of its page (a `device.tabs`
 * panel). Its track's trips, newest first, with joining and parting them, their albums and moving
 * one to another device; how it travels (its kind, else its class; its timezone; its home bases);
 * and its route with the fixes it left out, to reject or accept by hand. Whoever may change the
 * track uploads GPX files into it and edits how it travels.
 */
export default function TripsPage() {
  const [params] = useSearchParams();
  const device = params.get('device') ?? undefined;
  const { track, loading, error, refetch, save } = useTrackDetail(device);
  const access = useAccessIds();
  const [view, setView] = useState<View>('trips');
  const [editing, setEditing] = useState(false);
  // Raised by an upload, so the route is read again.
  const [trackRead, setTrackRead] = useState(0);
  const upload = useTrackUpload(track?.path ?? '', () => {
    setTrackRead((n) => n + 1);
    refetch();
  });

  if (loading && !track) return <PageLoader label='Loading trips…' />;
  if (!track) {
    return error
      ? <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>
      : <EmptyState title='No track'>This device keeps no positions.</EmptyState>;
  }

  const editable = canWrite(track.ownership, access);
  const uploadButton = editable && (
    <Button size='xs' variant='light' leftSection={<TablerIcon name='upload' size={14} />} loading={upload.sending} onClick={upload.open}>Upload GPX</Button>
  );

  return (
    <Stack gap='md'>
      <Group justify='space-between' wrap='wrap' gap='xs'>
        <SegmentedControl size='xs' value={view} onChange={(value) => setView(value as View)} data={VIEWS} />
        {editable && (
          <Group gap='xs'>
            {uploadButton}
            <Button size='xs' variant='default' leftSection={<TablerIcon name='pencil' size={14} />} onClick={() => setEditing(true)}>How it travels</Button>
          </Group>
        )}
      </Group>

      {view === 'trips' && <TrackTripsTab track={track.path} editable={editable} />}
      {view === 'travel' && <TrackInfo track={track} editable={editable} />}
      {view === 'fixes' && (
        <Box h={FIXES_HEIGHT} mih={360}>
          <TrackView key={trackRead} path={track.path} editable={editable} emptyActions={uploadButton || undefined} />
        </Box>
      )}

      {editable && upload.input}
      <TrackEditModal opened={editing} onClose={() => setEditing(false)} track={track} save={save} />
    </Stack>
  );
}
