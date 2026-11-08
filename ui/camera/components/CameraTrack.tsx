import { ActionIcon, Alert, Anchor, Button, Group, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TablerIcon } from '@ein/ui/components';
import { EntityPicker } from '../../components/EntityPicker.tsx';
import { InfoSection } from '../../components/InfoSection.tsx';
import { useTracks } from '../../location/hooks/useTracks.ts';

const trackRoute = (path: string): string => `/tracks/${encodeURIComponent(path)}`;

/**
 * The track a camera records into, as a section of its Info tab: a link to the track's page, and
 * for the camera's editors the way to set it, from the tracks there are (`track-list`), or clear it.
 * `track` is the track's path; `setTrack` writes the link (`camera-track`).
 */
export function CameraTrack({ track, editable, setTrack }: { track?: string; editable: boolean; setTrack: (track: string | null) => Promise<void> }) {
  const { tracks } = useTracks();
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!track && !editable) return null;
  const name = tracks.find((entry) => entry.path === track)?.name ?? track;

  const run = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await setTrack(next);
      setPicking(false);
      setPick(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoSection title='Track'>
      <Text size='xs' c='dimmed'>A phone or camera that also records where it was keeps that in a track.</Text>
      {track
        ? (
          <Group gap='xs' wrap='nowrap' justify='space-between'>
            <Group gap='xs' wrap='nowrap' style={{ minWidth: 0 }}>
              <TablerIcon name='route' size={16} color='gray' style={{ flexShrink: 0 }} />
              <Anchor component={Link} to={trackRoute(track)} size='sm' lineClamp={1}>{name}</Anchor>
            </Group>
            {editable && (
              <ActionIcon variant='subtle' color='gray' size='sm' aria-label='Take the track away' disabled={busy} onClick={() => run(null)}>
                <TablerIcon name='x' size={14} />
              </ActionIcon>
            )}
          </Group>
        )
        : <Text size='sm' c='dimmed'>It records into no track.</Text>}
      {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      {editable && (picking
        ? (
          <Group gap='xs' align='flex-end' wrap='nowrap'>
            <EntityPicker
              kind='track'
              data={tracks.filter((entry) => entry.path !== track).map((entry) => ({ value: entry.path, label: entry.name }))}
              value={pick}
              onChange={setPick}
              style={{ flex: 1 }}
              size='xs'
            />
            <Button size='xs' loading={busy} disabled={!pick} onClick={() => pick && run(pick)}>Set</Button>
            <Button size='xs' variant='default' disabled={busy} onClick={() => setPicking(false)}>Cancel</Button>
          </Group>
        )
        : (
          <Button size='compact-xs' variant='subtle' leftSection={<TablerIcon name='route' size={14} />} onClick={() => setPicking(true)} style={{ alignSelf: 'flex-start' }}>
            {track ? 'Change track' : 'Set track'}
          </Button>
        ))}
    </InfoSection>
  );
}
