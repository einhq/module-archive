import { Alert, Button, Select, SimpleGrid, Stack, Switch, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { RelinkResult } from '@archive/camera/api';
import { Dialog, DialogActions, MarkdownEditor, TablerIcon } from '@ein/ui/components';
import type { CameraDetail, CameraFields } from '../hooks/useCamera.ts';
import { LabelsField, useLabelsDraft } from '../../components/NodeLabels.tsx';

/**
 * Every IANA zone the browser knows — the same list `camera-update` validates
 * against, since both sides ask ICU.
 */
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [] as string[];
  }
})();

type TextField = Exclude<keyof CameraFields, 'digitizer' | 'quicktimeUtc'>;

type CameraEditModalProps = {
  opened: boolean;
  onClose: () => void;
  camera: CameraDetail;
  /** `useCamera().save`: writes the settings, and says how many files a changed fingerprint linked and a changed policy re-dated. */
  save: (fields: CameraFields) => Promise<RelinkResult | null>;
  /** After a save, with what it did to the linked files when it did anything. */
  onSaved: (message?: string) => void;
};

/** A camera's settings: its name, what matches files to it, how its dates are read, and its labels. */
export function CameraEditModal({ opened, onClose, camera, save, onSaved }: CameraEditModalProps) {
  const [draft, setDraft] = useState<CameraFields>({ ...camera });
  const labels = useLabelsDraft(camera.path, opened);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setDraft({ ...camera });
    setError(null);
  }, [opened]);

  const field = (key: TextField): string => draft[key] ?? '';
  const setField = (key: TextField, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    if (busy) return;
    if (!draft.name.trim()) {
      setError('a camera needs a name');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const relink = await save(draft);
      await labels.save();
      const files = (n: number) => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`;
      onSaved(
        relink && relink.linked > 0
          ? `Linked ${files(relink.linked)}${relink.retimed > 0 ? ` and updated dates on ${relink.retimed.toLocaleString()}` : ''}.`
          : relink && relink.retimed > 0
          ? draft.digitizer && !camera.digitizer ? `Removed scanner dates from ${files(relink.retimed)}.` : `Re-dated ${files(relink.retimed)}.`
          : undefined,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='Edit camera' subtitle={camera.name} icon='pencil' pattern='camera' size='lg' onSubmit={submit}>
      <Stack gap='sm'>
        <TextInput data-autofocus label='Name' required value={field('name')} onChange={(event) => setField('name', event.currentTarget.value)} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label='Make'
            placeholder='Canon'
            description='As exif writes it — matching reads these, not the name.'
            value={field('make')}
            onChange={(event) => setField('make', event.currentTarget.value)}
          />
          <TextInput label='Model' placeholder='Canon EOS 5D Mark III' value={field('model')} onChange={(event) => setField('model', event.currentTarget.value)} />
        </SimpleGrid>
        <TextInput
          label='Serial number'
          description='Identifies one body; make and model only identify a model line.'
          value={field('serial')}
          onChange={(event) => setField('serial', event.currentTarget.value)}
        />
        <Select
          label='Timezone'
          placeholder='Not set'
          description='The zone its clock was set to.'
          data={TIMEZONES}
          value={field('timezone') || null}
          onChange={(value) => setField('timezone', value ?? '')}
          searchable
          clearable
          limit={50}
          nothingFoundMessage='No such timezone'
        />
        <Switch
          label='Scanner or digitizer'
          description='Its EXIF camera dates say when the file was scanned, not when the photograph was taken.'
          checked={draft.digitizer ?? false}
          onChange={(event) => setDraft((prev) => ({ ...prev, digitizer: event.currentTarget.checked }))}
        />
        <Switch
          label='Video times in UTC'
          description='Its videos keep their recording time in UTC, as phones do. Turn on for a phone whose videos come out off by its time zone.'
          checked={draft.quicktimeUtc ?? false}
          onChange={(event) => setDraft((prev) => ({ ...prev, quicktimeUtc: event.currentTarget.checked }))}
        />
        <MarkdownEditor label='Description' placeholder='Optional' minRows={3} value={field('description')} onChange={(value) => setField('description', value)} />
        <LabelsField draft={labels} />
        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
