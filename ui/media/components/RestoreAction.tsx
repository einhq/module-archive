import { Alert, Button, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import { Dialog, DialogActions, SelectionActionButton, TablerIcon } from '@ein/ui/components';
import { MediaSelection, useAccessIds } from '@ein/ui/hooks';
import { canWriteEach, countOf, shq } from '@ein/ui/lib';
import { execCommand, MediaItem, notify } from '@ein/ui/signals';
import type { FileRestoreQueueAnswer } from '@media/api';
import { nothingToRestore, RESTORABLE, RestoreChoices, restoreFlags, type RestoreSteps, restoreStepsFor } from './RestoreDialog.tsx';

/** Pictures per `file-restore --queue`, so a long selection stays within a command line. */
const QUEUE_CHUNK = 100;

type Props = {
  selection?: MediaSelection;
  items: MediaItem[];
  /** The steps first ticked, by what the page lists: its scans' faded colours, say. */
  initial?: Partial<RestoreSteps>;
};

/**
 * Restore… for a selection: the steps are asked once, and each picture is restored in the media
 * pool (`file-restore --queue`), nobody waiting. Each gets a restored copy among its versions when
 * its turn comes, to compare and keep or discard as one restored on its own.
 *
 * Offered when the selection holds a picture EMS can restore and the reader may change every one;
 * the other files of the selection are left out and the dialog says how many.
 */
export function RestoreAction({ selection, items, initial }: Props) {
  const access = useAccessIds();
  const selected = items.filter((item) => selection?.selected.has(item.path));
  const pictures = selected.filter((item) => RESTORABLE.has(item.mimetype));
  const [opened, modal] = useDisclosure(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [steps, setSteps] = useState<RestoreSteps>(() => ({ ...restoreStepsFor(true), ...initial }));
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pictures.length === 0 || !canWriteEach(pictures, access)) return null;

  // The selection as it is when the dialog opens: the grid underneath stays live.
  const open = () => {
    setPaths(pictures.map((item) => item.path));
    setSkipped(selected.length - pictures.length);
    setSteps({ ...restoreStepsFor(true), ...initial });
    setError(null);
    modal.open();
  };

  const nothing = nothingToRestore(steps);
  const queue = async () => {
    if (busy || nothing) return;
    setBusy(true);
    setError(null);
    let queued = 0;
    const refused: string[] = [];
    try {
      for (let i = 0; i < paths.length; i += QUEUE_CHUNK) {
        const chunk = paths.slice(i, i + QUEUE_CHUNK);
        const answer = await execCommand<FileRestoreQueueAnswer>(`file-restore --queue ${restoreFlags(steps)} ${chunk.map(shq).join(' ')}`);
        queued += answer.queued.length;
        refused.push(...answer.refused.map((entry) => entry.reason));
      }
      modal.close();
      notify({
        message: refused.length > 0
          ? `${countOf(queued, 'picture', 'pictures')} queued to restore, ${refused.length} refused: ${refused[0]}`
          : `${countOf(queued, 'picture', 'pictures')} queued to restore. Each gets a restored copy among its versions.`,
        color: queued === 0 ? 'red' : refused.length > 0 ? 'yellow' : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SelectionActionButton icon={<TablerIcon name='wand' size={14} />} onClick={open}>
        Restore…
      </SelectionActionButton>
      <Dialog
        opened={opened}
        onClose={() => !busy && modal.close()}
        title='Restore'
        subtitle={countOf(paths.length, 'picture', 'pictures')}
        icon='wand'
        pattern='media'
        size='md'
        onSubmit={queue}
      >
        <Stack gap='md'>
          <Text size='sm' c='dimmed'>
            The pictures are restored in the background, one after another, and nothing waits for them. The pictures themselves are not changed: each restored copy is kept
            beside its picture, among its versions, to compare and keep or discard.
          </Text>
          {skipped > 0 && (
            <Text size='sm' c='dimmed'>
              {countOf(skipped, 'file', 'files')} of the selection cannot be restored and {skipped === 1 ? 'is' : 'are'} left out: only JPEG, PNG, TIFF, WebP and BMP pictures.
            </Text>
          )}
          <RestoreChoices steps={steps} onChange={setSteps} disabled={busy} />
          {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
        </Stack>
        <DialogActions>
          <Button variant='default' onClick={modal.close} disabled={busy}>Cancel</Button>
          <Button type='submit' loading={busy} disabled={nothing}>Restore {countOf(paths.length, 'picture', 'pictures')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
