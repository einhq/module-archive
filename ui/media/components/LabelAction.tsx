import { Alert, Button, Stack, TagsInput } from '@mantine/core';
import { useState } from 'react';
import type { LabelEntry } from '@ein/api';
import { execCommand } from '@ein/ui/signals';
import { countOf, shq } from '@ein/ui/lib';
import { Dialog, DialogActions, SelectionActionButton, TablerIcon } from '@ein/ui/components';
import { labelsChanged, labelWords } from '../../components/NodeLabels.tsx';

type Props = {
  /** The files to label: a selection's, or the one picture the lightbox shows. */
  paths: string[];
  /** After the labels are on, as a selection clears itself. */
  onDone?: () => void;
};

/** How many files one shell call labels. */
const LABEL_CHUNK = 50;

/**
 * Put one or more labels on every selected file. The labels already in use are offered as
 * completions, read when the dialog opens; a new word becomes a new label.
 */
export function LabelAction({ paths, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDialog = () => {
    setLabels([]);
    setError(null);
    setOpen(true);
    execCommand<LabelEntry[]>('label list')
      .then((entries) => setKnown((entries ?? []).map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b))))
      .catch(() => setKnown([]));
  };

  const apply = async () => {
    const words = labels.flatMap(labelWords);
    if (paths.length === 0 || words.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const tail = words.map(shq).join(' ');
      for (let i = 0; i < paths.length; i += LABEL_CHUNK) {
        const chunk = paths.slice(i, i + LABEL_CHUNK);
        await execCommand(chunk.map((path) => `label add ${shq(path)} ${tail}`).join(' && '));
      }
      setOpen(false);
      labelsChanged();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SelectionActionButton icon={<TablerIcon name='tag' size={14} />} onClick={openDialog} disabled={paths.length === 0}>
        Label
      </SelectionActionButton>

      <Dialog
        opened={open}
        onClose={() => !busy && setOpen(false)}
        title='Add labels'
        subtitle={`To ${countOf(paths.length, 'file', 'files')}`}
        icon='tag'
        pattern='label'
        size='md'
      >
        <Stack gap='md'>
          <TagsInput
            data-autofocus
            label='Labels'
            description='Pick a label in use or type a new one. A space starts the next label.'
            placeholder='e.g. sailing'
            data={known}
            value={labels}
            onChange={(next) => setLabels(next.flatMap(labelWords))}
            splitChars={[',', ' ']}
            clearable
          />
          {error && <Alert color='red' variant='light' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
        </Stack>
        <DialogActions>
          <Button variant='default' onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={apply} loading={busy} disabled={labels.length === 0}>Add labels</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
