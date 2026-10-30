import { ActionIcon, Button, Group, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { TablerIcon } from '@ein/ui/components';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { MediaFace, MediaFaceDoubt } from '@archive/media/api';

/** Why the face is in question, in a sentence. */
const reason = (doubt: MediaFaceDoubt): string => 'markedBy' in doubt ? `${doubt.markedBy} is not sure.` : `It looks more like ${doubt.likeName}.`;

/**
 * A question mark beside a named person in the lightbox: whether this face really is them.
 *
 * On a face nobody doubts it offers, to whoever may edit the photo, to mark it doubtful
 * (`face-doubt`): the person keeps the face, and their Faces tab lists it under Doubtful until
 * somebody answers. On a doubtful face it is lit and asks "Is this <name>?": yes keeps the face
 * as a human's assignment (`face-confirm`), no hands it to `onNotThem` to say who it is instead.
 * Somebody who may not edit the photo sees only that it is in question.
 *
 * Until the face is doubtful it stays invisible, though in place and focusable, while `revealed`
 * is false, so a list of names is not a column of question marks.
 */
export function FaceDoubt({ face, name, canEdit, revealed, opened, onOpen, onChanged, onNotThem }: {
  face?: MediaFace;
  name: string;
  canEdit: boolean;
  /** The row is pointed at or focused. */
  revealed: boolean;
  opened: boolean;
  onOpen: (open: boolean) => void;
  /** After the face's doubt or person changed here, to read the photo again. */
  onChanged: () => Promise<void>;
  /** The answer is no: say who the face is. */
  onNotThem: (facePath: string) => void;
}) {
  const [busy, setBusy] = useState<'mark' | 'confirm' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!face?.personId) return null;
  const doubt = face.doubt;
  if (!doubt && !canEdit) return null;

  const run = async (action: 'mark' | 'confirm' | 'clear') => {
    setBusy(action);
    setError(null);
    try {
      const command = action === 'confirm' ? 'face-confirm' : action === 'clear' ? 'face-doubt --clear' : 'face-doubt';
      await execCommand(`${command} ${shq(face.facePath)}`);
      await onChanged();
      onOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (open: boolean) => {
    setError(null);
    onOpen(open);
  };

  const label = doubt ? `Is this ${name}? ${reason(doubt)}` : `Not sure this is ${name}?`;
  return (
    <Popover opened={opened} onChange={toggle} position='bottom-end' withArrow shadow='md' width={260}>
      <Popover.Target>
        <Tooltip label={label} withinPortal multiline maw={260} disabled={opened}>
          <ActionIcon
            size='sm'
            variant={doubt ? 'light' : 'subtle'}
            color={doubt ? 'orange' : 'gray'}
            aria-label={doubt ? `Is this ${name}?` : `Doubt that this is ${name}`}
            style={doubt || opened || revealed ? undefined : { opacity: 0 }}
            onClick={() => toggle(!opened)}
          >
            <TablerIcon name='help-circle' size={16} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p='sm'>
        <Stack gap='xs'>
          {doubt
            ? (
              <>
                <Text size='sm' fw={500}>Is this {name}?</Text>
                <Text size='xs' c='dimmed'>{reason(doubt)}</Text>
                {canEdit && (
                  <Group gap='xs'>
                    <Button size='xs' color='teal' loading={busy === 'confirm'} disabled={busy !== null} onClick={() => void run('confirm')}>Yes</Button>
                    <Button
                      size='xs'
                      variant='default'
                      disabled={busy !== null}
                      onClick={() => {
                        onOpen(false);
                        onNotThem(face.facePath);
                      }}
                    >
                      No…
                    </Button>
                    {'markedBy' in doubt && (
                      <Button
                        size='xs'
                        variant='subtle'
                        color='gray'
                        loading={busy === 'clear'}
                        disabled={busy !== null}
                        onClick={() => void run('clear')}
                      >
                        Withdraw
                      </Button>
                    )}
                  </Group>
                )}
              </>
            )
            : (
              <>
                <Text size='sm' fw={500}>Not sure this is {name}?</Text>
                <Text size='xs' c='dimmed'>
                  The face stays {name}'s, marked as doubtful for somebody who knows to answer, here or under Doubtful on {name}'s Faces tab.
                </Text>
                <Group gap='xs'>
                  <Button size='xs' color='orange' loading={busy === 'mark'} onClick={() => void run('mark')}>Mark as doubtful</Button>
                </Group>
              </>
            )}
          {error && <Text size='xs' c='red'>{error}</Text>}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
