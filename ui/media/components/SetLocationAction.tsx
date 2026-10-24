import { Button } from '@mantine/core';
import { useCallback, useState } from 'react';
import type { LocationEntry } from '@archive/location/api';
import { Dialog, DialogActions, type FormField, FormFields, type FormValues, SelectionActionButton, TablerIcon, useSelectionBar } from '@ein/ui/components';
import { countOf, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';

type LocationPicker = {
  fields: FormField[];
  values: FormValues;
  onChange: (next: FormValues) => void;
  /** The point chosen, once it is a whole one. */
  point: { lat: number; lng: number } | null;
  /** Starts over at a point, or at none, and reads the known locations again. */
  reset: (start?: { lat: number; lng: number; known?: string }) => void;
};

/**
 * Where something was taken: a known location picked from a list, which puts its point on the map,
 * or a point clicked or typed on the map, which is then no longer that location.
 */
export function useLocationPicker(): LocationPicker {
  const [values, setValues] = useState<FormValues>({});
  const [locations, setLocations] = useState<LocationEntry[]>([]);

  const reset = useCallback((start?: { lat: number; lng: number; known?: string }) => {
    setValues(start ? { lat: String(start.lat), lng: String(start.lng), known: start.known ?? '' } : {});
    execCommand<LocationEntry[]>('location-list')
      .then((entries) => setLocations((entries ?? []).filter((entry) => entry.lat !== undefined && entry.lng !== undefined)))
      .catch(() => setLocations([]));
  }, []);

  const fields: FormField[] = [
    ...(locations.length > 0
      ? [{
        key: 'known',
        label: 'A known location',
        type: 'select' as const,
        placeholder: 'Pick one, or click the map',
        searchable: true,
        options: locations.map((location) => ({ value: location.id, label: location.name })),
      }]
      : []),
    { key: 'where', label: 'On the map', type: 'coordinates', description: 'Click where it was taken, or type the coordinates.' },
  ];

  const onChange = (next: FormValues) => {
    const location = next.known !== values.known && locations.find((entry) => entry.id === next.known);
    if (location) setValues({ ...next, lat: String(location.lat), lng: String(location.lng) });
    else if (next.known && (next.lat !== values.lat || next.lng !== values.lng)) setValues({ ...next, known: '' });
    else setValues(next);
  };

  const lat = Number(values.lat);
  const lng = Number(values.lng);
  const whole = values.lat !== undefined && values.lat !== '' && values.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng);

  return { fields, values, onChange, point: whole ? { lat, lng } : null, reset };
}

/** `file-set-position` for files; `=` keeps a negative coordinate a value rather than the next flag. */
export const setFilesPosition = (paths: string[], point: { lat: number; lng: number }) =>
  execCommand(`file-set-position ${paths.map(shq).join(' ')} --lat=${point.lat} --lng=${point.lng}`);

/** `file-set-position --clear`: the files' point and location link taken away. */
export const clearFilesPosition = (paths: string[]) => execCommand(`file-set-position ${paths.map(shq).join(' ')} --clear`);

/**
 * Say where the selected files were taken, through `useLocationPicker`. One `file-set-position`
 * call sets them all; the location overrides the GPS they carry, and the map and proximity search
 * follow it.
 */
export function SetLocationAction({ paths, onDone }: { paths: string[]; onDone?: () => void }) {
  const { reportError } = useSelectionBar();
  const [open, setOpen] = useState(false);
  const picker = useLocationPicker();
  const [busy, setBusy] = useState(false);

  const openDialog = () => {
    picker.reset();
    setOpen(true);
  };

  const apply = async () => {
    if (!picker.point) return;
    setBusy(true);
    try {
      await setFilesPosition(paths, picker.point);
      setOpen(false);
      onDone?.();
      notify({ message: `Location set on ${countOf(paths.length, 'file', 'files')}`, color: 'green' });
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SelectionActionButton icon={<TablerIcon name='map-pin' size={14} />} onClick={openDialog} disabled={paths.length === 0}>
        Set location
      </SelectionActionButton>

      <Dialog
        opened={open}
        onClose={() => !busy && setOpen(false)}
        title={paths.length === 1 ? 'Where was this taken?' : 'Where were these taken?'}
        subtitle={countOf(paths.length, 'file', 'files')}
        icon='map-pin'
        pattern='location'
        size='xl'
      >
        <FormFields fields={picker.fields} values={picker.values} onChange={picker.onChange} />
        <DialogActions hint='This replaces whatever position the files carry, for the map and for searching by location.'>
          <Button variant='default' onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={apply} loading={busy} disabled={!picker.point}>Set location</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
