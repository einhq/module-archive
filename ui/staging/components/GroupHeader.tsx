import { formatRange, TablerIcon } from '@ein/ui/components';
import { useDropTarget } from '@ein/ui/hooks';
import { endMediaDrag, type MediaDragPayload, startMediaDrag } from '@ein/ui/lib';
import { ActionIcon, Badge, Box, Button, Checkbox, Group, Kbd, Menu, Text, TextInput, Tooltip } from '@mantine/core';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import type { GroupRow } from '../hooks/useGroupIndex.ts';

/** What can be done to a group from its header, each already bound to it. */
export type GroupActions = {
  /** What Enter does to it, as its button says it; absent when there is no proposal. */
  proposal?: { label: string; run: () => void };
  /** Where it is proposed to go, when that is an album of the library: what a closed section says of it. */
  hint?: string;
  newAlbum: () => void;
  privateAlbum: () => void;
  addTo: () => void;
  later: () => void;
  discard: () => void;
  rename: (title: string) => void;
  /** Set the time of every picture in it. */
  date: () => void;
  /** Absent for the first group: there is none above to merge into. */
  mergeUp?: () => void;
  /** Absent for the last group. */
  mergeDown?: () => void;
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

/**
 * An open group's copies and look-alikes, as its header's chip says them: how many of its pictures
 * copy or look like library photos and other staged ones, comparing the first, keeping the
 * library's copies (when any resolve unasked), and selecting them.
 */
export type GroupDuplicates = { library: number; inbox: number; compare: () => void; keepLibrary?: () => void; select?: () => void };

/** What dropping pictures on a group's header does: named as they arrive, or refused (null). */
export type GroupDrop = { accept: (payload: MediaDragPayload) => string | null; onDrop: (payload: MediaDragPayload) => void };

type Props = {
  row: GroupRow;
  open: boolean;
  phone: boolean;
  /** Fixed for a closed section, whose height is arithmetic. */
  height: number;
  /** The name is being edited in place (E). */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  /** The neighbours' names, for the menu's merge rows. */
  previous?: string;
  next?: string;
  failure?: GroupFailure;
  onDismissFailure: () => void;
  onActivate: () => void;
  actions: GroupActions;
  /** How much of it is selected; with `onSelect`, a box to select it whole. */
  selected?: GroupSelected;
  onSelect?: GroupSelect;
  /** What its grip ⠿ carries when dragged: the group, or the selection it is in. */
  grip?: () => MediaDragPayload;
  /** Pictures or groups dropped on it. */
  drop?: GroupDrop;
  /** Its copies and look-alikes, when it is open and has any. */
  duplicates?: GroupDuplicates;
};

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;

/**
 * A group's two lines: its name, then when it was, how much it holds and what the organizer says
 * of it (a trip, still indexing, kept as yours, put aside). Where a decision on it failed, the
 * second line says why, with Retry. The ⋯ menu holds every action, so a phone has them too; an
 * open group also has what Enter does as a button, and, when some of its pictures copy or look like
 * others, a chip saying how many, whose menu compares, keeps the library's copies or selects them.
 *
 * On a desktop it has a box that selects it whole (Shift selects on from where the last selection
 * started, across the groups between), and so does a click on its name with Shift, Ctrl or Cmd;
 * a grip that drags it (or the selection it is in) to a destination or another group; and it
 * takes pictures and groups dropped on it, saying what the drop would do as they arrive.
 */
export function GroupHeader(
  {
    row,
    open,
    phone,
    height,
    renaming,
    onRenamingChange,
    previous,
    next,
    failure,
    onDismissFailure,
    onActivate,
    actions,
    selected = 'none',
    onSelect,
    grip,
    drop,
    duplicates,
  }: Props,
) {
  const [draft, setDraft] = useState(row.title);
  const range = formatRange(row.timeStart, row.timeEnd);
  // Enter and the blur that follows it are one commit.
  const settled = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    settled.current = false;
    setDraft(row.title);
  }, [renaming]);

  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  const gripRef = useRef<HTMLDivElement | null>(null);
  const clickName = (event: MouseEvent) => {
    if (onSelect && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSelect({ range: event.shiftKey });
      return;
    }
    if (!open && !renaming) onActivate();
  };

  const startRename = () => onRenamingChange(true);
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onRenamingChange(false);
    const title = draft.trim();
    if (save && title && title !== row.title) actions.rename(title);
  };

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
      {grip && (
        <Box
          ref={gripRef}
          draggable
          onDragStart={(event) => startMediaDrag(event, grip(), gripRef.current)}
          onDragEnd={endMediaDrag}
          title='Drag to an album, or onto another group'
          aria-label={`Drag ${row.title}`}
          style={{ cursor: 'grab', display: 'flex', color: 'var(--mrx-text-tertiary)', marginRight: -6 }}
        >
          <TablerIcon name='grip-vertical' size={16} />
        </Box>
      )}
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
      <Box style={{ minWidth: 0, flex: 1, cursor: open ? undefined : 'pointer' }} onClick={clickName}>
        {renaming
          ? (
            <TextInput
              size='xs'
              autoFocus
              aria-label='Name of the group'
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => finish(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') finish(true);
                if (event.key === 'Escape') finish(false);
              }}
            />
          )
          : (
            <Text fw={600} truncate title={row.title} onDoubleClick={open ? startRename : undefined}>
              {row.title}
            </Text>
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
              {row.staging.later && <Badge size='xs' variant='light' color='gray' leftSection={<TablerIcon name='clock-pause' size={10} />}>Later</Badge>}
              {open && duplicates && <DuplicatesChip duplicates={duplicates} />}
              {!open && actions.hint && <Text size='xs' c='var(--mrx-accent)' truncate title={actions.hint}>{actions.hint}</Text>}
              {row.pinned && (
                <Tooltip label='You edited this group, so the organizer leaves it as it is'>
                  <Badge size='xs' variant='light' color='grape' leftSection={<TablerIcon name='pin' size={10} />}>Yours</Badge>
                </Tooltip>
              )}
            </Group>
          )}
      </Box>
      <Group gap={4} wrap='nowrap'>
        {open && (
          <Button
            size='compact-sm'
            onClick={actions.proposal?.run ?? actions.newAlbum}
            rightSection={phone ? undefined : <Kbd size='xs'>{actions.proposal ? 'Enter' : 'N'}</Kbd>}
            style={{ maxWidth: phone ? 180 : 320 }}
          >
            <Text span inherit truncate>{actions.proposal?.label ?? 'New album…'}</Text>
          </Button>
        )}
        {/* Not handing focus back: Rename puts it in the name field, and taking it back would end the edit at once. */}
        <Menu position='bottom-end' shadow='md' withinPortal returnFocus={false}>
          <Menu.Target>
            <ActionIcon variant='subtle' color='gray' aria-label={`Actions for ${row.title}`}>
              <TablerIcon name='dots' size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<TablerIcon name='photo-plus' size={14} />} rightSection={<Kbd size='xs'>N</Kbd>} onClick={actions.newAlbum}>
              New album…
            </Menu.Item>
            <Menu.Item leftSection={<TablerIcon name='lock' size={14} />} rightSection={<Kbd size='xs'>P</Kbd>} onClick={actions.privateAlbum}>
              New private album…
            </Menu.Item>
            <Menu.Item leftSection={<TablerIcon name='library-plus' size={14} />} rightSection={<Kbd size='xs'>A</Kbd>} onClick={actions.addTo}>
              Add to album…
            </Menu.Item>
            <Menu.Item leftSection={<TablerIcon name='clock-pause' size={14} />} rightSection={<Kbd size='xs'>L</Kbd>} onClick={actions.later}>
              {row.staging.later ? 'Back to its lane' : 'Later'}
            </Menu.Item>
            <Menu.Item leftSection={<TablerIcon name='pencil' size={14} />} rightSection={<Kbd size='xs'>E</Kbd>} onClick={startRename}>Rename</Menu.Item>
            <Menu.Item leftSection={<TablerIcon name='clock-edit' size={14} />} rightSection={<Kbd size='xs'>T</Kbd>} onClick={actions.date}>Set the time…</Menu.Item>
            <Menu.Item
              leftSection={<TablerIcon name='arrow-merge-up' size={14} />}
              rightSection={<Kbd size='xs'>M</Kbd>}
              disabled={!actions.mergeUp}
              onClick={actions.mergeUp}
            >
              {previous ? `Merge into “${previous}”` : 'Merge into the group above'}
            </Menu.Item>
            <Menu.Item
              leftSection={<TablerIcon name='arrow-merge-down' size={14} />}
              rightSection={<Kbd size='xs'>⇧M</Kbd>}
              disabled={!actions.mergeDown}
              onClick={actions.mergeDown}
            >
              {next ? `Merge “${next}” in` : 'Merge the group below in'}
            </Menu.Item>
            <Menu.Item leftSection={<TablerIcon name='external-link' size={14} />} onClick={actions.openPage}>Open as an album page</Menu.Item>
            <Menu.Divider />
            <Menu.Item color='red' leftSection={<TablerIcon name='trash' size={14} />} rightSection={<Kbd size='xs'>X</Kbd>} onClick={actions.discard}>
              Discard the photos…
            </Menu.Item>
            {actions.remove && <Menu.Item leftSection={<TablerIcon name='unlink' size={14} />} onClick={actions.remove}>Not a group…</Menu.Item>}
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Group>
  );
}

/** The chip "⧉ 4 in library · 2× 1": a menu to compare them, keep the library's copies, or select them. */
function DuplicatesChip({ duplicates }: { duplicates: GroupDuplicates }) {
  const words = [duplicates.library > 0 ? `⧉ ${duplicates.library.toLocaleString()} in library` : '', duplicates.inbox > 0 ? `2× ${duplicates.inbox.toLocaleString()}` : '']
    .filter(Boolean).join(' · ');
  return (
    <Menu position='bottom-start' shadow='md' withinPortal>
      <Menu.Target>
        <Badge size='xs' variant='light' color='orange' style={{ cursor: 'pointer', flexShrink: 0 }} onClick={(event) => event.stopPropagation()}>
          {words}
        </Badge>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item leftSection={<TablerIcon name='layout-columns' size={14} />} onClick={duplicates.compare}>Compare</Menu.Item>
        {duplicates.keepLibrary && <Menu.Item leftSection={<TablerIcon name='library' size={14} />} onClick={duplicates.keepLibrary}>Keep the library copies</Menu.Item>}
        {duplicates.select && <Menu.Item leftSection={<TablerIcon name='checkbox' size={14} />} onClick={duplicates.select}>Select these</Menu.Item>}
      </Menu.Dropdown>
    </Menu>
  );
}
