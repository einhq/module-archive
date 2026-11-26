import { formatRange, TablerIcon } from '@ein/ui/components';
import { useDropTarget } from '@ein/ui/hooks';
import type { MediaDragPayload } from '@ein/ui/lib';
import { ActionIcon, Badge, Box, Button, Checkbox, Group, Menu, Text, TextInput, Tooltip } from '@mantine/core';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import type { GroupRow } from '../hooks/useGroupIndex.ts';
import { cardTitle } from '../lib/group-title.ts';

/** What can be done to a group from its header, each already bound to it. */
export type GroupActions = {
  /** What Enter does to it, as its button says it; absent when there is no proposal, or it is a new album, which Create makes. */
  proposal?: { label: string; run: () => void; /** How sure an album of the library is, in words. */ sure?: string };
  /**
   * How many of its pictures Create, Add to existing and the menu act on, when not all of it: those
   * selected in the cursor's group, or the part the keys are on.
   */
  acting?: number;
  /** Create: a new album of it, named in a dialog. */
  newAlbum: () => void;
  /** The albums it is suggested for, and any other found by name. */
  suggestions: () => void;
  /** How many albums it is suggested for; absent while it is not compared with the library. */
  suggested?: number;
  discard: () => void;
  rename: (title: string) => void;
  /** Set the time of every picture in it. */
  date: () => void;
  /** As an album page, where a suggested album can also be looked through. */
  openPage: () => void;
  /** Absent for a lane's group, which is where pictures without a group are. */
  remove?: () => void;
};

export type GroupFailure = { message: string; retry: () => void };

/** How much of a group is selected: whole (`all`, perhaps but for some pictures), some of its pictures, or nothing. */
export type GroupSelected = 'all' | 'some' | 'none';

/** Selecting from the header: its box, or a click with Shift (a range from where the last one started) or Ctrl/Cmd. */
export type GroupSelect = (mods: { range: boolean }) => void;

/** What dropping pictures on a group's header does: named as they arrive, or refused (null). */
export type GroupDrop = { accept: (payload: MediaDragPayload) => string | null; onDrop: (payload: MediaDragPayload) => void };

type Props = {
  row: GroupRow;
  /** It is the cursor's group, which the keys act on. */
  current: boolean;
  /** Its pictures are shown by part, to step through and select, rather than in one grid. */
  expanded: boolean;
  /** Show its pictures by part, or in one grid again. */
  onExpand: () => void;
  phone: boolean;
  /** Fixed for a closed section, whose height is arithmetic. */
  height: number;
  /** The name is being edited in place (E). */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  failure?: GroupFailure;
  onDismissFailure: () => void;
  onActivate: () => void;
  actions: GroupActions;
  /** How much of it is selected; with `onSelect`, a box to select it whole. */
  selected?: GroupSelected;
  onSelect?: GroupSelect;
  /** Pictures or groups dropped on it. */
  drop?: GroupDrop;
};

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;

/**
 * A group's two lines: its name, less the dates it ends with (`lib/group-title.ts`), with a pen on
 * hover that edits it in place, as E does; then when it was, how much it holds and what the
 * organizer says of it (a trip, still indexing, kept as yours). Where a decision on it failed, the
 * second line says why, with Retry. Copies and look-alikes are the Duplicates tab's, not its.
 *
 * At its right end: its proposal as a button, what Enter does on it, when that is not a new album
 * (on a phone once it is expanded: closed, the section has it under its grid); Add to existing,
 * then dimmed how many albums it is suggested for; Create album (on a phone that is under its
 * grid); a ⋮ menu with Open as album page, Not a group, Set the time and Discard; and a
 * chevron that shows its pictures by part, or in one grid again. For the cursor's group with
 * pictures selected, or a part chosen, Create album, Add to existing and the menu act on those
 * (`actions.acting`). It is the same height expanded or not.
 *
 * On a desktop it has a box that selects it whole (Shift selects on from where the last selection
 * started, across the groups between), and so does a click on its name with Shift, Ctrl or Cmd;
 * and it takes pictures and groups dropped on it, saying what the drop would do as they arrive.
 */
export function GroupHeader(
  {
    row,
    current,
    expanded,
    onExpand,
    phone,
    height,
    renaming,
    onRenamingChange,
    failure,
    onDismissFailure,
    onActivate,
    actions,
    selected = 'none',
    onSelect,
    drop,
  }: Props,
) {
  const name = cardTitle(row.title);
  const [draft, setDraft] = useState(name);
  const range = formatRange(row.timeStart, row.timeEnd);
  // Enter and the blur that follows it are one commit.
  const settled = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    settled.current = false;
    setDraft(name);
  }, [renaming]);

  // What Enter does, as a button.
  const button = actions.proposal !== undefined && (expanded || !phone);
  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  const clickName = (event: MouseEvent) => {
    if (onSelect && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSelect({ range: event.shiftKey });
      return;
    }
    if (!current && !renaming) onActivate();
  };

  const startRename = () => onRenamingChange(true);
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onRenamingChange(false);
    const title = draft.trim();
    if (save && title && title !== name) actions.rename(title);
  };
  /** What the buttons act on, in words: the pictures chosen of the cursor's group, or all of it. */
  const of = actions.acting ? photos(actions.acting) : 'the group';
  const suggestions = actions.suggested === undefined ? 'Add to existing' : `Add to existing, ${actions.suggested}`;

  return (
    <Group
      justify='space-between'
      wrap='nowrap'
      gap='sm'
      h={height}
      align='center'
      style={{
        overflow: 'hidden',
        borderRadius: 'var(--mantine-radius-sm)',
        outline: target.over ? '2px dashed var(--mrx-accent)' : undefined,
        outlineOffset: -2,
      }}
      {...target.props}
    >
      {onSelect && (
        <Checkbox
          size='xs'
          checked={selected === 'all'}
          indeterminate={selected === 'some'}
          onChange={() => {}}
          onClick={(event) => onSelect({ range: event.shiftKey })}
          aria-label={`Select ${row.title}`}
          styles={{ input: { cursor: 'pointer' } }}
        />
      )}
      <Box style={{ minWidth: 0, flex: 1, cursor: current ? undefined : 'pointer' }} onClick={clickName}>
        {renaming
          ? (
            <TextInput
              size='xs'
              autoFocus
              aria-label='Name of the group'
              value={draft}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => finish(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') finish(true);
                if (event.key === 'Escape') finish(false);
              }}
            />
          )
          : (
            <Group gap={4} wrap='nowrap' className='mrx-card-name'>
              <Text fw={600} truncate title={row.title} onDoubleClick={current ? startRename : undefined} style={{ minWidth: 0 }}>{name}</Text>
              <ActionIcon
                className='mrx-card-pen'
                size='sm'
                variant='subtle'
                color='gray'
                aria-label={`Rename ${name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  startRename();
                }}
              >
                <TablerIcon name='pencil' size={14} />
              </ActionIcon>
            </Group>
          )}
        {target.over
          ? (
            <Group gap={6} wrap='nowrap' mt={2}>
              <TablerIcon name='arrow-down-circle' size={14} color='var(--mrx-accent)' />
              <Text size='xs' c='var(--mrx-accent)' truncate>{target.over}</Text>
            </Group>
          )
          : failure
          ? (
            <Group gap={6} wrap='nowrap' mt={2}>
              <TablerIcon name='alert-circle' size={14} color='var(--mantine-color-red-5)' />
              <Text size='xs' c='red.4' truncate title={failure.message}>{failure.message}</Text>
              <Button size='compact-xs' variant='subtle' onClick={failure.retry}>Retry</Button>
              <Button size='compact-xs' variant='subtle' color='gray' onClick={onDismissFailure}>Dismiss</Button>
            </Group>
          )
          : (
            <Group gap={6} wrap='nowrap' mt={2} style={{ overflow: 'hidden' }}>
              <Text size='xs' c='dimmed' truncate>
                {[range, row.memberCount !== undefined ? photos(row.memberCount) : '', row.days && row.days > 1 ? `${row.days} days` : ''].filter(Boolean).join(' · ')}
              </Text>
              {row.staging.kind === 'trip' && <Badge size='xs' variant='light' color='blue' leftSection={<TablerIcon name='route' size={10} />}>Trip</Badge>}
              {row.provisional && (
                <Tooltip label='Some of these are still being indexed, so the group may still change'>
                  <Badge size='xs' variant='light' color='yellow' leftSection={<TablerIcon name='hourglass' size={10} />}>Still indexing</Badge>
                </Tooltip>
              )}
              {row.pinned && (
                <Tooltip label='You edited this group, so the organizer leaves it as it is'>
                  <Badge size='xs' variant='light' color='grape' leftSection={<TablerIcon name='pin' size={10} />}>Yours</Badge>
                </Tooltip>
              )}
            </Group>
          )}
      </Box>
      <Group gap={4} wrap='nowrap'>
        {button && actions.proposal && (
          <Tooltip label={`${actions.proposal.label}, ${actions.proposal.sure}`} disabled={!actions.proposal.sure}>
            <Button
              size='compact-sm'
              variant='light'
              onClick={actions.proposal.run}
              style={{ maxWidth: phone ? 180 : 320 }}
            >
              <Text span inherit truncate>{actions.proposal.label}</Text>
            </Button>
          </Tooltip>
        )}
        {phone
          ? (
            <ActionIcon variant='default' aria-label={suggestions} onClick={actions.suggestions}>
              <TablerIcon name='library-plus' size={16} />
            </ActionIcon>
          )
          : (
            // The count after the word, smaller and dimmed.
            <Button size='compact-sm' variant='default' aria-label={suggestions} onClick={actions.suggestions}>
              Add to existing
              {actions.suggested !== undefined && <Text span size='xs' c='dimmed' ml={6}>{actions.suggested}</Text>}
            </Button>
          )}
        {!phone && (
          <Tooltip label={`A new album of ${of}`}>
            <Button size='compact-sm' onClick={actions.newAlbum}>Create album</Button>
          </Tooltip>
        )}
        {/* Not handing focus back: a dialog the menu opens takes it. */}
        <Menu position='bottom-end' shadow='md' withinPortal returnFocus={false}>
          <Menu.Target>
            <ActionIcon variant='subtle' color='gray' aria-label={`Actions for ${row.title}`}>
              <TablerIcon name='dots-vertical' size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<TablerIcon name='external-link' size={14} />} onClick={actions.openPage}>Open as album page</Menu.Item>
            {actions.remove && <Menu.Item leftSection={<TablerIcon name='unlink' size={14} />} onClick={actions.remove}>Not a group</Menu.Item>}
            <Menu.Item leftSection={<TablerIcon name='clock-edit' size={14} />} onClick={actions.date}>
              {actions.acting ? `Set the time of ${of}` : 'Set the time'}
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item color='red' leftSection={<TablerIcon name='trash' size={14} />} onClick={actions.discard}>
              {actions.acting ? `Discard ${of}` : 'Discard'}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tooltip label={expanded ? 'Back to one grid' : 'Show by day, to step through and select'}>
          <ActionIcon
            variant='subtle'
            color='gray'
            aria-label={expanded ? `Close ${row.title}` : `Expand ${row.title}`}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              onExpand();
            }}
          >
            <TablerIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Group>
  );
}
