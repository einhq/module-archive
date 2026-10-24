import { Dialog, DialogActions } from '@ein/ui/components';
import { Button, Text } from '@mantine/core';

type Props = {
  /** The suggestion to delete; null keeps the dialog closed. */
  group: { title: string; memberCount?: number } | null;
  onClose: () => void;
  onConfirm: () => void;
};

/** The ⋯ menu's Not a group: only the grouping goes, never a photo, and the organizer remembers it. */
export function DeleteGroupDialog({ group, onClose, onConfirm }: Props) {
  const count = group?.memberCount ?? 0;
  return (
    <Dialog opened={group !== null} onClose={onClose} title='Not a group?' subtitle={group?.title} icon='unlink' pattern='album' size='sm' floating>
      <Text size='sm'>
        The {count.toLocaleString()} {count === 1 ? 'photo goes' : 'photos go'}{' '}
        back to their lanes, Everyday and the like, and the organizer will not suggest them as a group again. Undo brings the group back.
      </Text>
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button color='red' onClick={onConfirm} data-autofocus>Not a group</Button>
      </DialogActions>
    </Dialog>
  );
}
