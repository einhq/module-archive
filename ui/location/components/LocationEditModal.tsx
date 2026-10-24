import { Dialog, DialogActions, MapMarkers, MapShapeEditor, MapView, MarkdownEditor, PositionShape, TablerIcon } from '@ein/ui/components';
import { Alert, Box, Button, Card, Group, SegmentedControl, SimpleGrid, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { LocationDetail } from '../hooks/useLocationDetail.ts';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { candidateBounds, candidateMarkers } from './candidates.ts';
import { LabelsField, useLabelsDraft } from '../../components/NodeLabels.tsx';

type LocationEditModalProps = {
  opened: boolean;
  onClose: () => void;
  location: LocationDetail;
  /** `useLocationDetail().saveShape`: writes the shape and marks it drawn by hand, then re-reads. */
  saveShape: (shape: PositionShape) => Promise<void>;
  /** The details were written; the caller re-reads. */
  onApplied: () => void;
};

const TEXT_FIELDS = ['name', 'address', 'city', 'country', 'description'] as const;
type TextField = typeof TEXT_FIELDS[number];
type Fields = Record<TextField, string>;

const fieldsOf = (location: LocationDetail): Fields => ({
  name: location.name,
  address: location.address ?? '',
  city: location.city ?? '',
  country: location.country ?? '',
  description: location.description ?? '',
});

/**
 * Everything written about a location, in one dialog: what it is called and where it is by
 * address, and where it is on the map.
 *
 * Save writes only what changed, and the two halves as their own writes (`location-update` and
 * `position-set`): an address and a shape disagree often enough — the address is how it was
 * written down, the shape where it actually is — that changing one must never quietly rewrite the
 * other.
 */
export function LocationEditModal({ opened, onClose, location, saveShape, onApplied }: LocationEditModalProps) {
  const saved = fieldsOf(location);
  const [fields, setFields] = useState<Fields>(saved);
  const [mode, setMode] = useState<'circle' | 'polygon'>(location.shape?.polygon ? 'polygon' : 'circle');
  const [draft, setDraft] = useState<PositionShape | null>(location.shape);
  const labels = useLabelsDraft(location.path, opened);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setFields(fieldsOf(location));
    setMode(location.shape?.polygon ? 'polygon' : 'circle');
    setDraft(location.shape);
    setError(null);
  }, [opened]);

  // Reference only here: accepting one is a click on the Info tab.
  const candidates = useMemo(() => location.shape ? [] : location.candidates, [location.shape, location.candidates]);
  const markers = useMemo(() => candidateMarkers(candidates), [candidates]);
  const bounds = useMemo(() => candidateBounds(candidates), [candidates]);

  const changed = TEXT_FIELDS.filter((field) => fields[field].trim() !== saved[field]);
  const shapeValid = draft !== null && (draft.polygon ? draft.polygon.length >= 3 : true);
  const shapeChanged = JSON.stringify(draft) !== JSON.stringify(location.shape);

  const setField = (field: TextField, value: string) => setFields((prev) => ({ ...prev, [field]: value }));

  const save = async () => {
    if (busy) return;
    if (!fields.name.trim()) {
      setError('a location needs a name');
      return;
    }
    if (shapeChanged && draft && !shapeValid) {
      setError('a polygon needs at least three corners');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (changed.length > 0) {
        const args = changed.map((field) => fields[field].trim() ? `--${field} ${shq(fields[field].trim())}` : `--clear ${field}`);
        await execCommand(`location-update ${shq(location.path)} ${args.join(' ')}`);
      }
      if (shapeChanged && draft) await saveShape(draft);
      await labels.save();
      onApplied();
      onClose();
      // The upkeep pipeline does the lookup, a few seconds behind this.
      if (changed.includes('address')) notify({ message: 'Saved. The new address is looked up in the background; a location set by hand is kept.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (next: string) => {
    setMode(next as 'circle' | 'polygon');
    setDraft(null); // switching shape kind starts over
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='Edit location' subtitle={location.name} icon='pencil' pattern='location' size='xl' onSubmit={save}>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing='lg'>
        <Stack gap='sm'>
          <TextInput data-autofocus label='Name' required value={fields.name} onChange={(event) => setField('name', event.currentTarget.value)} />
          <Textarea
            label='Address'
            description='As it was written down. A changed address is looked up on the map again, unless the location was set by hand.'
            autosize
            minRows={2}
            value={fields.address}
            onChange={(event) => setField('address', event.currentTarget.value)}
          />
          <SimpleGrid cols={2}>
            <TextInput label='City' value={fields.city} onChange={(event) => setField('city', event.currentTarget.value)} />
            <TextInput label='Country' value={fields.country} onChange={(event) => setField('country', event.currentTarget.value)} />
          </SimpleGrid>
          <MarkdownEditor label='Description' placeholder='Optional' minRows={3} value={fields.description} onChange={(value) => setField('description', value)} />
          <LabelsField draft={labels} />
        </Stack>

        <Stack gap='xs'>
          <Group justify='space-between' wrap='wrap'>
            <Text fw={500} size='sm'>On the map</Text>
            <SegmentedControl
              size='xs'
              value={mode}
              onChange={changeMode}
              data={[
                { label: 'Circle', value: 'circle' },
                { label: 'Polygon', value: 'polygon' },
              ]}
            />
          </Group>
          <Card withBorder radius='md' p={0} style={{ overflow: 'hidden' }}>
            <Box h={380}>
              <MapView
                // Deliberately not the draft: a polygon's lat/lng is its centroid, so
                // feeding it back as the camera would move the map — and reapply this
                // zoom — on every vertex added or dragged.
                center={location.shape ?? undefined}
                zoom={location.shape ? 15 : undefined}
                bounds={bounds}
              >
                {markers.length > 0 && <MapMarkers markers={markers} />}
                <MapShapeEditor mode={mode} value={draft} onChange={setDraft} />
              </MapView>
            </Box>
          </Card>
          <Text c='dimmed' size='xs'>
            {mode === 'circle'
              ? 'Click to place the center; drag the pin to move and the round handle to resize.'
              : 'Click to add vertices; drag to move, click a midpoint to insert, right-click a vertex to remove.'}
            {markers.length > 0 ? ' The numbered pins are the geocoder’s suggestions, shown for reference.' : ''}
          </Text>
        </Stack>
      </SimpleGrid>
      {error && <Alert mt='md' color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={changed.length === 0 && !shapeChanged && !labels.changed}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
