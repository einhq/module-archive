import { Dialog, DialogActions } from '@ein/ui/components';
import { Button, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';

type Props = {
  /** The name it starts from, and how many pictures it holds; null keeps the dialog closed. */
  group: { title: string; count?: number } | null;
  onClose: () => void;
  /** The title as confirmed: the group's own, or as edited here. */
  onConfirm: (title: string) => void;
};

/**
 * Create album (N) on a group, or on the pictures selected in it: the title of the library album
 * it becomes. The suggested name is the start, and the album's path is made from what is confirmed
 * here.
 */
export function NameDialog({ group, onClose, onConfirm }: Props) {
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (group) setTitle(group.title);
  }, [group]);
  const count = group?.count;

  return (
    <Dialog
      opened={group !== null}
      onClose={onClose}
      title='Create album'
      subtitle={count !== undefined ? `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'} from staging` : undefined}
      icon='photo-plus'
      pattern='album'
      size='sm'
      onSubmit={() => title.trim() && onConfirm(title.trim())}
    >
      <Stack gap='xs'>
        <TextInput data-autofocus label='Name' value={title} onChange={(event) => setTitle(event.currentTarget.value)} required />
        <Text size='xs' c='dimmed'>The photos leave staging for the new album, shared as your new albums are.</Text>
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button type='submit' disabled={!title.trim()}>Create album</Button>
      </DialogActions>
    </Dialog>
  );
}
