import { Dialog, DialogActions } from '@ein/ui/components';
import { Button, Text } from '@mantine/core';

type Props = {
  /** What would be discarded; null keeps the dialog closed. */
  group: { title: string; count: number } | null;
  onClose: () => void;
  onConfirm: () => void;
};

/** X on a large group asks first: its photos go to the trash, from where Undo or the Trash page brings them back. */
export function DiscardGroupDialog({ group, onClose, onConfirm }: Props) {
  const count = group?.count ?? 0;
  return (
    <Dialog opened={group !== null} onClose={onClose} title='Discard?' subtitle={group?.title} icon='trash' pattern='staging' size='sm' floating>
      <Text size='sm'>
        {count.toLocaleString()} {count === 1 ? 'photo goes' : 'photos go'} to your trash, as one entry on the Trash page. Undo puts them back, in their groups.
      </Text>
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button color='red' onClick={onConfirm} data-autofocus>Discard</Button>
      </DialogActions>
    </Dialog>
  );
}
