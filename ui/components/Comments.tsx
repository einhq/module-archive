/**
 * The comments on a node, oldest first, and the box to write one: the lightbox's sidebar shows them
 * for a file, an Info tab for an album or a person. Everyone who sees the node reads them; the box is
 * for whoever may change it, and a comment's author may delete it.
 */

import { CoverAvatar, Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { ActionIcon, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAccessIds } from '@ein/ui/hooks';
import { formatDateTime } from '@ein/ui/lib';
import type { CommentEntry } from '@ein/api';
import { useComments } from '../hooks/useComments.ts';
import { InfoSection } from './InfoSection.tsx';

/** The comment author's picture beside their name, in px. */
const COMMENT_AVATAR = 20;
const COMMENT_MAX_ROWS = 6;
/** The send button inside the comment box, and the room kept for it at the box's right, in px. */
const COMMENT_SEND_BUTTON = 26;
const COMMENT_SEND_SECTION = 36;

/** In the reader's date and time format, as the lightbox's other times are. */
const TIMESTAMP: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/** A comment, under its author: the account's full name, or its username, beside the linked person's picture. */
function CommentRow({ comment, canDelete, onDelete }: {
  comment: CommentEntry;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const author = comment.authorName ?? comment.author;
  return (
    <Stack gap={6}>
      <Group justify='space-between' gap='xs' wrap='nowrap'>
        <Group gap='xs' wrap='nowrap' miw={0}>
          {comment.personPath && <CoverAvatar path={comment.personPath} fallback={author.charAt(0).toUpperCase()} size={COMMENT_AVATAR} alt='' eager />}
          <Text size='xs' c='dimmed' miw={0}>
            {author}
            {comment.createdAt ? ` · ${formatDateTime(comment.createdAt, TIMESTAMP)}` : ''}
          </Text>
        </Group>
        {canDelete && (
          <ActionIcon variant='subtle' color='gray' size='sm' onClick={onDelete} aria-label='Delete comment'>
            <TablerIcon name='trash' size={14} />
          </ActionIcon>
        )}
      </Group>
      <Text size='sm' lh={1.5} style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</Text>
    </Stack>
  );
}

/**
 * Sizes the comment box to `draft`: one row while empty, otherwise tall enough for the text, up to
 * COMMENT_MAX_ROWS lines, scrolling past that.
 */
function fitComment(box: HTMLTextAreaElement | null, draft: string) {
  if (!box) return;
  box.style.height = '';
  if (!draft || box.scrollHeight <= box.clientHeight) return;
  const style = getComputedStyle(box);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const borders = box.offsetHeight - box.clientHeight;
  const most = COMMENT_MAX_ROWS * parseFloat(style.lineHeight) + padding;
  box.style.height = `${Math.min(box.scrollHeight, most) + borders}px`;
}

/**
 * `comments` and, when `writable`, the box that adds one through `onAdd`. A delete is confirmed in
 * a dialog first; `onDialog` hears it open and close. The draft and the dialog belong to one node:
 * key the component by its path where the node shown can change.
 */
export function Comments({ comments, writable, onAdd, onRemove, onDialog }: {
  comments: CommentEntry[];
  writable: boolean;
  onAdd: (text: string) => Promise<void>;
  onRemove: (slug: string) => Promise<void>;
  onDialog?: (open: boolean) => void;
}) {
  const access = useAccessIds();
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  // The box grows with its draft and is measured only when the draft changes, not on every render
  // as Mantine's `autosize` is.
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => fitComment(boxRef.current, draft), [draft]);
  /** The comment whose delete waits to be confirmed. */
  const [deleting, setDeleting] = useState<CommentEntry | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const confirming = deleting !== null;
  useEffect(() => {
    if (!confirming) return;
    onDialog?.(true);
    return () => onDialog?.(false);
  }, [confirming]);

  const post = async () => {
    if (!draft.trim()) return;
    setPosting(true);
    try {
      await onAdd(draft);
      setDraft('');
    } finally {
      setPosting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await onRemove(deleting.slug);
      setDeleting(null);
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <>
      {comments.length > 0 && (
        <Stack gap='lg' mb={writable ? 'xs' : 0}>
          {comments.map((comment) => (
            <CommentRow
              key={comment.slug}
              comment={comment}
              canDelete={access?.uid === comment.uid}
              onDelete={() => setDeleting(comment)}
            />
          ))}
        </Stack>
      )}
      {writable && (
        <>
          {
            /* Send sits inside the box, in its bottom-right corner as on the chat page, so it
              stays beside the last line as the box grows. Enter is a new line; Ctrl+Enter posts. */
          }
          <Textarea
            ref={boxRef}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void post();
              }
            }}
            placeholder='Add a comment…'
            rows={1}
            readOnly={posting}
            rightSectionWidth={COMMENT_SEND_SECTION}
            rightSectionPointerEvents='all'
            styles={{ section: { alignItems: 'flex-end', paddingBottom: 4 } }}
            rightSection={
              <ActionIcon
                variant='filled'
                color='marine'
                size={COMMENT_SEND_BUTTON}
                onClick={() => void post()}
                disabled={!draft.trim()}
                loading={posting}
                title='Comment'
                aria-label='Comment'
              >
                <TablerIcon name='send' size={14} />
              </ActionIcon>
            }
          />
        </>
      )}
      <Dialog opened={confirming} onClose={() => setDeleting(null)} title='Delete comment?' icon='trash' pattern='danger' size='sm' floating>
        <Text size='sm' style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>{deleting?.body}</Text>
        <DialogActions>
          <Button variant='default' onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color='red' loading={deletingBusy} onClick={() => void confirmDelete()}>Delete</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/**
 * The Comments box of an Info tab: the comments on `path`, and the box for whoever may change it
 * (`writable`). Nothing while they load, nor when there are none and the reader may not add one.
 */
export function NodeComments({ path, writable }: { path: string; writable: boolean }) {
  const { comments, add, remove } = useComments(path);
  if (!comments || (comments.length === 0 && !writable)) return null;
  return (
    <InfoSection title='Comments'>
      <Comments key={path} comments={comments} writable={writable} onAdd={add} onRemove={remove} />
    </InfoSection>
  );
}
