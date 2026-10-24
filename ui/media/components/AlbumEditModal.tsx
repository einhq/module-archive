import { Alert, Button, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useEffect, useState } from 'react';
import { CoverAvatar, Dialog, DialogActions, MarkdownEditor, TablerIcon } from '@ein/ui/components';
import { useEntityComplete } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { renameAutoAlbum } from '../hooks/useAutoAlbums.ts';
import type { AlbumSpanAnswer, AlbumSpanRow } from '@archive/media/api';
import { LabelsField, useLabelsDraft } from '../../components/NodeLabels.tsx';
import type { AlbumSeries, SeriesNeighbour } from '../hooks/useAlbumSeries.ts';

type Props = {
  opened: boolean;
  onClose: () => void;
  path: string;
  name: string;
  description?: string;
  /** The albums before and after it in a series, as they are now. */
  series?: AlbumSeries;
  /** One the organizer made: only its name, renamed the staging way (`staging rename`), which keeps it. */
  suggested?: boolean;
  /** After a save, so the page shows what was written. */
  onSaved: () => void;
};

/**
 * Pick the album before or after this one in a series: find one by name, or clear the field for
 * none. The album being edited is not offered.
 */
function SeriesField({ label, value, onChange, self }: { label: string; value?: SeriesNeighbour; onChange: (value?: SeriesNeighbour) => void; self: string }) {
  const [search, setSearch] = useState('');
  // The field shows the chosen album's name in its box; only something else typed there is a search.
  const typed = search.trim() && search !== value?.title ? search : undefined;
  const { hits, loading } = useEntityComplete(typed, ['album']);
  const choices = [
    ...(value ? [value] : []),
    ...hits.filter((hit) => hit.path !== self && hit.path !== value?.path).map((hit) => ({ path: hit.path, title: hit.name })),
  ];
  return (
    <Select
      label={label}
      placeholder='None'
      searchable
      clearable
      data={choices.map((choice) => ({ value: choice.path, label: choice.title }))}
      value={value?.path ?? null}
      onChange={(path) => onChange(choices.find((choice) => choice.path === path))}
      searchValue={search}
      onSearchChange={setSearch}
      // The completion has ranked the names already.
      filter={({ options }) => options}
      nothingFoundMessage={typed ? (loading ? 'Searching…' : 'No album by that name') : "Type part of an album's name"}
      rightSection={loading ? <Loader size={14} /> : undefined}
      renderOption={({ option }) => (
        <Group gap='sm' wrap='nowrap'>
          <CoverAvatar path={option.value} size={28} radius='sm' fallback={<TablerIcon name='photo' size={14} />} />
          <Text size='sm' truncate>{option.label}</Text>
        </Group>
      )}
    />
  );
}

/** The day a span's end falls on, as the date fields spell it. */
const dayOf = (time?: string): string | null => time ? time.slice(0, 10) : null;

/**
 * An album's name, description, span, labels and neighbours in a series, edited in place: `album
 * set` for each of the name, description, span ends and neighbours that changed, `label` for the
 * labels. The
 * name is what the album is called everywhere; its path stays as it was, so links to it keep
 * working. The span can reach out past the media, to cover the journey there and back, but not
 * in past them: the fields stop at the first and last capture (`album-span --dry-run`), and an
 * end set back onto the media's own day is cleared, so the span follows the media again. A
 * neighbour set here links back to this album (`album set … previous|next`). A suggested album is
 * in no series.
 */
export function AlbumEditModal({ opened, onClose, path, name, description, series = {}, suggested = false, onSaved }: Props) {
  const [draftName, setDraftName] = useState(name);
  const [draftDescription, setDraftDescription] = useState(description ?? '');
  const [span, setSpan] = useState<AlbumSpanRow | undefined>(undefined);
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);
  const [draftPrevious, setDraftPrevious] = useState<SeriesNeighbour | undefined>(series.previous);
  const [draftNext, setDraftNext] = useState<SeriesNeighbour | undefined>(series.next);
  const labels = useLabelsDraft(path, opened);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setDraftName(name);
    setDraftDescription(description ?? '');
    setDraftPrevious(series.previous);
    setDraftNext(series.next);
    setError(null);
    setSpan(undefined);
    if (suggested) return;
    let cancelled = false;
    execCommand<AlbumSpanAnswer>(`album-span --dry-run ${shq(path)}`)
      .then((answer) => {
        if (cancelled) return;
        const row = answer.albums[0];
        setSpan(row);
        setDraftStart(dayOf(row?.timeStart));
        setDraftEnd(dayOf(row?.timeEnd));
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [opened, path, name, description, series.previous?.path, series.next?.path, suggested]);

  const firstDay = dayOf(span?.mediaStart);
  const lastDay = dayOf(span?.mediaEnd);

  /** `album set` for one end of the span, when it moved; back on the media's day (or emptied), it is cleared. */
  const saveEnd = async (key: 'spanStart' | 'spanEnd', draft: string | null, current: string | null, mediaDay: string | null) => {
    if (draft === current) return;
    const value = !draft || draft === mediaDay ? '' : draft;
    await execCommand(`album set ${shq(path)} ${key} ${shq(value)}`);
  };

  const save = async () => {
    if (busy || !draftName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const newName = draftName.trim();
      if (newName !== name) await (suggested ? renameAutoAlbum(path, newName) : execCommand(`album set ${shq(path)} name ${shq(newName)}`));
      if (!suggested && draftDescription.trim() !== (description ?? '')) await execCommand(`album set ${shq(path)} description ${shq(draftDescription.trim())}`);
      if (span) {
        // A span moved later takes its new end first, so the start is never set past the old end.
        const ends = [
          () => saveEnd('spanStart', draftStart, dayOf(span.timeStart), firstDay),
          () => saveEnd('spanEnd', draftEnd, dayOf(span.timeEnd), lastDay),
        ];
        const timeEnd = dayOf(span.timeEnd);
        if (draftStart && timeEnd && draftStart > timeEnd) ends.reverse();
        for (const save of ends) await save();
      }
      if (!suggested) {
        for (const [key, draft, current] of [['previous', draftPrevious, series.previous], ['next', draftNext, series.next]] as const) {
          if (draft?.path !== current?.path) await execCommand(`album set ${shq(path)} ${key} ${shq(draft?.path ?? '')}`);
        }
      }
      await labels.save();
      onSaved();
      onClose();
      notify({ message: 'Album saved', color: 'green' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={opened} onClose={() => !busy && onClose()} title='Edit album' subtitle={name} icon='pencil' pattern='album' size='md' onSubmit={save}>
      <Stack gap='md'>
        <TextInput data-autofocus label='Name' value={draftName} onChange={(event) => setDraftName(event.currentTarget.value)} required />
        {!suggested && (
          <MarkdownEditor
            label='Description'
            placeholder='Optional'
            value={draftDescription}
            onChange={setDraftDescription}
          />
        )}
        <LabelsField draft={labels} />
        {span && (
          <Stack gap={4}>
            <Group grow align='flex-start'>
              <DateInput
                label='Starts'
                valueFormat='YYYY-MM-DD'
                value={draftStart}
                onChange={setDraftStart}
                maxDate={firstDay ?? draftEnd ?? undefined}
                clearable
              />
              <DateInput
                label='Ends'
                valueFormat='YYYY-MM-DD'
                value={draftEnd}
                onChange={setDraftEnd}
                minDate={lastDay ?? draftStart ?? undefined}
                clearable
              />
            </Group>
            <Text size='xs' c='dimmed'>
              {firstDay
                ? `The media run from ${firstDay} to ${lastDay}. Reach out past them to cover the journey there and back.`
                : 'Nothing in the album is dated yet; the span is what you set here.'}
            </Text>
          </Stack>
        )}
        {!suggested && (
          <Stack gap={4}>
            <Group grow align='flex-start'>
              <SeriesField label='Previous album' value={draftPrevious} onChange={setDraftPrevious} self={path} />
              <SeriesField label='Next album' value={draftNext} onChange={setDraftNext} self={path} />
            </Group>
            <Text size='xs' c='dimmed'>Albums in a series link to each other from their headers. The album you pick links back here.</Text>
          </Stack>
        )}
        {error && <Alert color='red' variant='light' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={!draftName.trim()}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
