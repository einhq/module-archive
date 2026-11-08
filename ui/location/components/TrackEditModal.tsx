import { Alert, Button, Select, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { isTravelKind, TRAVEL_KIND_LABELS, TRAVEL_KINDS } from '@archive/location/track-profile';
import { Dialog, DialogActions, MarkdownEditor, TablerIcon } from '@ein/ui/components';
import type { TrackDetail, TrackFields } from '../hooks/useTrackDetail.ts';

/** Every IANA zone the browser knows — the same list `track-update` validates against, since both sides ask ICU. */
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [] as string[];
  }
})();

const KIND_OPTIONS = TRAVEL_KINDS.map((kind) => ({ value: kind, label: TRAVEL_KIND_LABELS[kind] }));

type TrackEditModalProps = {
  opened: boolean;
  onClose: () => void;
  track: TrackDetail;
  /** `useTrackDetail().save`. */
  save: (fields: TrackFields) => Promise<void>;
};

/** How a device's track travels: its kind, the timezone its trips are cut into days in, and its description. */
export function TrackEditModal({ opened, onClose, track, save }: TrackEditModalProps) {
  const [draft, setDraft] = useState<TrackFields>({ kind: track.kind, timezone: track.timezone, description: track.description });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setDraft({ kind: track.kind, timezone: track.timezone, description: track.description });
    setError(null);
  }, [opened]);

  const set = (key: keyof TrackFields, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await save(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='How it travels' subtitle={track.name} icon='pencil' pattern='track' size='lg' onSubmit={submit}>
      <Stack gap='sm'>
        <Select
          data-autofocus
          label='Travels as'
          placeholder={isTravelKind(track.travels) ? `As its class: ${TRAVEL_KIND_LABELS[track.travels]}` : 'Not set'}
          description='How it travels, which tells its stops from drift and its trips from rests. A boat’s track is shown in knots and nautical miles, the others’ in km/h and km. Without one, the device’s class says it.'
          data={KIND_OPTIONS}
          value={draft.kind || null}
          onChange={(value) => set('kind', value ?? '')}
          clearable
        />
        <Select
          label='Timezone'
          placeholder='UTC'
          description='The zone its trips are cut into days in.'
          data={TIMEZONES}
          value={draft.timezone || null}
          onChange={(value) => set('timezone', value ?? '')}
          searchable
          clearable
          limit={50}
          nothingFoundMessage='No such timezone'
        />
        <MarkdownEditor label='Description' placeholder='Optional' minRows={3} value={draft.description} onChange={(value) => set('description', value)} />
        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
