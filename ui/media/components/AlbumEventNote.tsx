import { ActionIcon, Box, Text } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { UserText } from '../../components/UserText.tsx';
import './album-event-note.css';

type AlbumEventNoteProps = {
  text: string;
  /** The writer's name, signed under the text; no byline without one. */
  author?: string;
  /** Given when the reader may change the event: a pen, shown on hover, calls it. */
  onEdit?: () => void;
};

/** One of an album's dated texts, standing among the pictures of its day, signed by who wrote it. */
export function AlbumEventNote({ text, author, onEdit }: AlbumEventNoteProps) {
  return (
    <Box className='mrx-album-event' px='sm' py='xs' mb='xs' pr={onEdit ? 40 : undefined}>
      <UserText text={text} size='sm' />
      {author && <Text size='xs' c='dimmed' mt={4}>— {author}</Text>}
      {onEdit && (
        <ActionIcon className='mrx-album-event-edit' variant='subtle' color='gray' size='sm' onClick={onEdit} aria-label='Edit event'>
          <TablerIcon name='pencil' size={16} />
        </ActionIcon>
      )}
    </Box>
  );
}
