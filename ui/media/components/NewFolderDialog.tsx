import { Alert, Button, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { joinPath, nameProblem, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';

type Props = {
  opened: boolean;
  /** Where the folder is made: the album's own media folder, or the folder open in it. */
  parent: string;
  /** What the dialog names as the place it is made in. */
  parentName: string;
  onClose: () => void;
  onCreated: (path: string) => void;
};

/** Name a new folder and make it in an album (`mkdir`). */
export function NewFolderDialog({ opened, parent, parentName, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    setName('');
    setError(null);
  }, [opened]);

  const problem = nameProblem(name.trim());
  const create = async () => {
    if (problem) return;
    const path = joinPath(parent, name.trim());
    setBusy(true);
    setError(null);
    try {
      await execCommand(`mkdir ${shq(path)}`);
      onCreated(path);
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
      title='New folder'
      subtitle={`In ${parentName}`}
      icon='folder-plus'
      pattern='album'
      size='sm'
      onSubmit={() => void create()}
    >
      <TextInput
        data-autofocus
        label='Name'
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={name.length > 0 ? problem : undefined}
      />
      {error && <Alert color='red' variant='light' mt='sm' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={problem !== null}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}
