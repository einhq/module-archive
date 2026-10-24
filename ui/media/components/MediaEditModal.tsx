import { Alert, Button, Group, SimpleGrid, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions, FormFields, MarkdownEditor, TablerIcon } from '@ein/ui/components';
import type { MediaDetails } from '@archive/media/api';
import { LabelsField, useLabelsDraft } from '../../components/NodeLabels.tsx';
import { clearFilesPosition, setFilesPosition, useLocationPicker } from './SetLocationAction.tsx';

type Props = {
  opened: boolean;
  onClose: () => void;
  details: MediaDetails;
  /** `useMediaDetails().setDescription`, which reads the details again. */
  setDescription: (text: string) => Promise<void>;
  /** After a save, so the sidebar shows the new position. */
  onSaved: () => void;
};

/**
 * A file's description, labels and location, edited together. The location is the file's own
 * point, which `file-set-position` writes over the GPS it carries; it starts at the point the file
 * has, and is written only when moved. Clearing it takes the point and the location link away.
 */
export function MediaEditModal({ opened, onClose, details, setDescription, onSaved }: Props) {
  const [description, setDraftDescription] = useState(details.description ?? '');
  const labels = useLabelsDraft(details.path, opened);
  const picker = useLocationPicker();
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const position = details.position;
  useEffect(() => {
    if (!opened) return;
    setDraftDescription(details.description ?? '');
    setError(null);
    setCleared(false);
    picker.reset(position ? { lat: position.lat, lng: position.lng, known: details.location?.id } : undefined);
  }, [opened]);

  const point = picker.point;
  const placed = Boolean(position || details.location);
  const moved = point !== null && (cleared || point.lat !== position?.lat || point.lng !== position?.lng);
  const clearing = cleared && point === null;
  const clear = () => {
    setCleared(true);
    picker.reset();
  };
  const describedChanged = description.trim() !== (details.description ?? '');

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (describedChanged) await setDescription(description.trim());
      await labels.save();
      if (clearing) await clearFilesPosition([details.path]);
      else if (moved) await setFilesPosition([details.path], point);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={opened}
      onClose={() => !busy && onClose()}
      title='Edit file'
      subtitle={details.path.split('/').pop()}
      icon='pencil'
      pattern='media'
      size='xl'
      onSubmit={save}
    >
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing='lg'>
        <Stack gap='sm'>
          <MarkdownEditor
            autoFocus
            label='Description'
            placeholder='Describe this…'
            value={description}
            onChange={setDraftDescription}
          />
          <LabelsField draft={labels} />
        </Stack>
        <Stack gap='xs'>
          <FormFields fields={picker.fields} values={picker.values} onChange={picker.onChange} />
          {placed && !clearing && (
            <Group>
              <Button size='compact-sm' variant='subtle' color='red' leftSection={<TablerIcon name='map-pin-off' size={14} />} onClick={clear}>
                Clear location
              </Button>
            </Group>
          )}
        </Stack>
      </SimpleGrid>
      {error && <Alert mt='md' color='red' variant='light' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
      <DialogActions
        hint={clearing
          ? 'The file will have no location, for the map or for searching by location.'
          : moved
          ? 'The new location replaces the position the file carries, for the map and for searching by location.'
          : undefined}
      >
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={!describedChanged && !labels.changed && !moved && !clearing}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
