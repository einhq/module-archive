import { Dialog, DialogActions } from '@ein/ui/components';
import { Button, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';

type Props = {
  /** What is being named, and how many pictures it holds; null keeps the dialog closed. */
  group: { title: string; count?: number } | null;
  /** The new album is the reader's alone. */
  private?: boolean;
  onClose: () => void;
  /** The title as confirmed: the group's own, or as edited here. */
  onConfirm: (title: string) => void;
};

/**
 * N and P on a group (or on the pictures selected in it): the title of the library album it
 * becomes. The group's own name is the start, and the album's path is made from what is confirmed
 * here.
 */
export function NameDialog({ group, private: privately = false, onClose, onConfirm }: Props) {
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (group) setTitle(group.title);
  }, [group]);
  const count = group?.count;

  return (
    <Dialog
      opened={group !== null}
      onClose={onClose}
      title={privately ? 'New private album' : 'New album'}
      subtitle={count !== undefined ? `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'} from staging` : undefined}
      icon={privately ? 'lock' : 'photo-plus'}
      pattern='album'
      size='sm'
      onSubmit={() => title.trim() && onConfirm(title.trim())}
    >
      <Stack gap='xs'>
        <TextInput data-autofocus label='Name' value={title} onChange={(event) => setTitle(event.currentTarget.value)} required />
        <Text size='xs' c='dimmed'>
          {privately
            ? 'The photos leave staging for a new album only you can see; its name is listed among the albums.'
            : 'The photos leave staging for the new album, shared as your new albums are.'}
        </Text>
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button type='submit' disabled={!title.trim()}>Create album</Button>
      </DialogActions>
    </Dialog>
  );
}
