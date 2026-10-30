import { ActionIcon, Button, Group, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { type FocusEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { TablerIcon } from '@ein/ui/components';
import { formatClock } from '@ein/ui/lib';
import type { MediaFace } from '@archive/media/api';
import { doubtReason, FaceDoubtForm } from './FaceDoubt.tsx';
import { onScreen, ShowFace } from './ShowFace.tsx';

/** How long a row is pointed at before its card opens, so passing over the list opens none. */
const OPEN_DELAY = 300;
/** How long the card outlives the pointer, to cross the gap between the row and the card. */
const CLOSE_DELAY = 150;

/**
 * A person or a face in the lightbox's sidebar, and what can be done with the face from the row:
 * follow it in a video (`ShowFace`) and question who it is (`FaceDoubtForm`).
 *
 * With a pointer the actions stand in a card beside the row, opened by pointing at the row for a
 * moment or focusing it, so nothing in the row moves under the pointer. On a phone, which has
 * nothing to point with, they stand in the row. What is on — a face followed, a face in doubt —
 * stays in the row either way, and is turned off or answered there.
 */
export function FaceRow({ name, videoFace, personFace, canEdit, mobile, highlighted, asking = false, onAsk, onShowFace, followed, onPointer, onChanged, children }: {
  name: string;
  /** The face as a video moment holds it, to follow. */
  videoFace?: MediaFace;
  /** A named person's face, to question. */
  personFace?: MediaFace;
  canEdit: boolean;
  mobile: boolean;
  /** The face's box on the picture is pointed at. */
  highlighted: boolean;
  /** The question of who the face is stands open. */
  asking?: boolean;
  onAsk?: (open: boolean) => void;
  onShowFace?: (facePath: string) => void;
  /** The face being followed. */
  followed?: string | null;
  /** The row is pointed at, or no longer. */
  onPointer: (inside: boolean) => void;
  /** After the face's doubt or person changed, to read the photo again. */
  onChanged: () => Promise<void>;
  children: ReactNode;
}) {
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const row = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const point = (inside: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPointed(inside), inside ? OPEN_DELAY : CLOSE_DELAY);
  };
  // The card is the row's sibling, not inside it: going from one to the other is staying.
  const stay = () => {
    clearTimeout(timer.current);
    setPointed(true);
  };
  // Only the keyboard's focus opens the card: a button clicked keeps the focus after the pointer
  // has gone.
  const focus = (event: FocusEvent<HTMLElement>) => setFocused(event.target.matches(':focus-visible'));
  const leaves = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    return !row.current?.contains(next) && !card.current?.contains(next);
  };

  const follow = onShowFace && videoFace?.atSeconds !== undefined ? videoFace : undefined;
  const following = follow !== undefined && followed === follow.facePath;
  const question = personFace?.personId && (personFace.doubt || canEdit) ? personFace : undefined;
  const doubt = question?.doubt;
  const opened = asking || (!mobile && (pointed || focused) && (follow !== undefined || question !== undefined));

  const close = () => {
    clearTimeout(timer.current);
    setPointed(false);
    setFocused(false);
    onAsk?.(false);
  };

  // Escape closes the card while it holds the keyboard, and not the lightbox beneath, which
  // answers Escape from a listener the re-render closing the card reaches before the key does:
  // so the key is taken here, at the window, first. An open dropdown keeps its own Escape.
  const holdsKeys = asking || (opened && focused);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!holdsKeys) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target as Element | null)?.getAttribute?.('data-mantine-stop-propagation') === 'true') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    globalThis.addEventListener('keydown', onKeyDown, true);
    return () => globalThis.removeEventListener('keydown', onKeyDown, true);
  }, [holdsKeys]);

  return (
    <Popover
      opened={opened}
      onChange={(open) => !open && close()}
      // Its top on the row's, so what it holds can change without moving the button pointed at.
      position={mobile ? 'bottom-end' : 'left-start'}
      withArrow
      shadow='md'
      width={asking ? 280 : undefined}
      // Right after the row in the page, so its buttons follow the row on Tab; fixed, so the
      // sidebar's scrolling does not clip it.
      withinPortal={false}
      floatingStrategy='fixed'
      // The question takes the keyboard, on its answer button (`data-autofocus`), so Escape closes
      // it. Not on a phone, which has no keyboard to take.
      trapFocus={asking && !mobile}
    >
      <Popover.Target>
        <Group
          ref={row}
          gap='xs'
          wrap='nowrap'
          onMouseEnter={() => {
            onPointer(true);
            point(true);
          }}
          onMouseLeave={() => {
            onPointer(false);
            point(false);
          }}
          onFocus={focus}
          onBlur={(event) => leaves(event) && setFocused(false)}
          style={{ borderRadius: 4, background: highlighted ? 'var(--mrx-surface-overlay)' : undefined }}
        >
          {children}
          {follow && (mobile || following) && <ShowFace face={follow} name={name} onShow={onShowFace} followed={followed} />}
          {question && (mobile || doubt) && (
            <Tooltip label={doubt ? `Is this ${name}? ${doubtReason(doubt)}` : `Not sure this is ${name}?`} withinPortal multiline maw={260} disabled={asking}>
              <ActionIcon
                size='sm'
                variant={doubt ? 'light' : 'subtle'}
                color={doubt ? 'orange' : 'gray'}
                aria-label={doubt ? `Is this ${name}?` : `Doubt that this is ${name}`}
                onClick={() =>
                  onAsk?.(!asking)}
              >
                <TablerIcon name='help-circle' size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Popover.Target>
      <Popover.Dropdown
        ref={card}
        p={asking ? 'sm' : 4}
        onMouseEnter={stay}
        onMouseLeave={() => point(false)}
        onFocus={focus}
        onBlur={(event) => leaves(event) && setFocused(false)}
      >
        {asking && question ? <FaceDoubtForm face={question} name={name} canEdit={canEdit} onDone={close} onChanged={onChanged} /> : (
          <Stack gap={2}>
            {follow && (
              <Button
                size='xs'
                variant='subtle'
                color={following ? 'marine' : 'gray'}
                justify='flex-start'
                leftSection={<TablerIcon name='user-square-rounded' size={16} />}
                onClick={() => onShowFace?.(follow.facePath)}
              >
                {following ? `Stop following ${name}` : `Show at ${formatClock(follow.atSeconds ?? 0)}`}
              </Button>
            )}
            {follow && follow.appearances && follow.appearances.length > 0 && <Text size='xs' c='dimmed' px='xs' maw={240}>On screen {onScreen(follow.appearances)}</Text>}
            {question && (
              <Button
                size='xs'
                variant='subtle'
                color={doubt ? 'orange' : 'gray'}
                justify='flex-start'
                leftSection={<TablerIcon name='help-circle' size={16} />}
                onClick={() => onAsk?.(true)}
              >
                {doubt ? `Is this ${name}?` : `Not sure this is ${name}?`}
              </Button>
            )}
          </Stack>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
