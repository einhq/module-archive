import type { StagingCandidate } from '@archive/staging/api';
import type { Proposal } from '@archive/staging/proposal';
import { formatRange, TablerIcon } from '@ein/ui/components';
import { useDropTarget } from '@ein/ui/hooks';
import { ActionIcon, Badge, Box, Button, Divider, Group, Paper, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { type AlbumTarget, proposalLabel } from '../lib/destinations.ts';
import { CompareStrip } from './CompareStrip.tsx';
import type { GroupDrop } from './GroupHeader.tsx';

/** A row of the column pictures can be dropped on. */
export type DropDestination =
  | { kind: 'proposal' }
  | { kind: 'new' }
  | { kind: 'recent'; album: AlbumTarget }
  | { kind: 'add-to' }
  | { kind: 'discard' };

type Props = {
  /**
   * What the column acts on when it is not the whole group — a part, the pictures selected, groups
   * selected — as a dimmed line over its buttons; none for the whole group.
   */
  acting?: string;
  /** How many of the group's pictures the keys act on: those selected, or a part's. */
  selected: number;
  proposal: Proposal;
  recent: readonly AlbumTarget[];
  /** The neighbouring groups' names, which the selected pictures can move to. */
  previous?: string;
  next?: string;
  onApply: () => void;
  /** Create album: a new album of it, named in a dialog. */
  onNew: () => void;
  onAddTo: () => void;
  onDiscard: () => void;
  /** With groups selected whole: merge them into the first, as its label says. */
  merge?: { label: string; run: () => void };
  /** Split the group before the pictures, or in a lane make them a group (`split.label` says which). */
  split?: { label: string; run: () => void };
  /** The pictures into the group above or below. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** The pictures into a group chosen, or a new one. */
  onMoveTo?: () => void;
  /** Set the time of the group's pictures. */
  onDate?: () => void;
  /** The group is no group; absent for a lane. */
  onNotAGroup?: () => void;
  /** The selection reaches across groups, which the column then decides on. */
  across?: boolean;
  /** What a drop of pictures on a row does; none takes no drop. */
  drop?: (destination: DropDestination) => GroupDrop | undefined;
  /** The library albums the group may go into, best first (at most three). */
  candidates?: readonly StagingCandidate[];
  /**
   * The album selected among the candidates and the recent albums: its own pictures are shown,
   * with Move to it, and a candidate selected carries "Not this album".
   */
  album?: AlbumTarget & { writable?: boolean };
  onSelectAlbum?: (album: AlbumTarget) => void;
  /** Move the group (or what the column acts on) to the album selected. */
  onMove?: () => void;
  onReject?: (index: number) => void;
  /** The group was compared with the library and no album fits it well. */
  unmatched?: boolean;
  /** When the group was taken, which the strip of the selected album opens on. */
  strip?: { timeStart?: string; timeEnd?: string };
  /** The column is widened to compare. */
  comparing?: boolean;
  onCompare?: () => void;
};

/** The albums filed into lately that the column lists. */
export const RECENT_SHOWN = 4;

/** A row selected: sunken, with the accent at its left edge. */
const selectedStyle = { background: 'var(--mrx-surface-sunken)', boxShadow: 'inset 3px 0 0 var(--mrx-accent)' } as const;

/** The look of a row a drag of pictures is over: dashed in the accent, saying what the drop would do. */
const overStyle = { outline: '2px dashed var(--mrx-accent)', outlineOffset: -2 } as const;

/**
 * One choice of the column: what it does, and a quieter second line, which says what a drop would
 * do while pictures are dragged over it. An album's row is marked while it is the one selected.
 */
function Row(
  { icon, label, detail, onClick, disabled, selected, drop }: {
    icon: string;
    label: ReactNode;
    detail?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    selected?: boolean;
    drop?: GroupDrop;
  },
) {
  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  return (
    <UnstyledButton
      className='mrx-pick-row'
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      px='xs'
      py={6}
      style={{ borderRadius: 'var(--mantine-radius-sm)', ...(selected ? selectedStyle : {}), ...(target.over ? overStyle : {}) }}
      {...target.props}
    >
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <TablerIcon name={icon} size={16} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm' truncate>{label}</Text>
          {target.over ? <Text size='xs' c='var(--mrx-accent)' truncate>{target.over}</Text> : detail && <Text size='xs' c='dimmed' truncate>{detail}</Text>}
        </Box>
      </Group>
    </UnstyledButton>
  );
}

/**
 * One candidate album: its title, span and size, how likely, and why, as chips; one the reader may
 * not file into says so. A click selects it; the one selected carries "Not this album".
 */
function CandidateRow(
  { candidate, selected, onSelect, onReject, drop }: {
    candidate: StagingCandidate;
    selected: boolean;
    onSelect?: () => void;
    onReject?: () => void;
    drop?: GroupDrop;
  },
) {
  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  const { album } = candidate;
  const span = formatRange(album.timeStart, album.timeEnd);
  return (
    <Box
      className='mrx-pick-row'
      px='xs'
      py={6}
      style={{ borderRadius: 'var(--mantine-radius-sm)', ...(selected ? selectedStyle : {}), ...(target.over ? overStyle : {}) }}
      {...target.props}
    >
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <UnstyledButton onClick={onSelect} aria-pressed={selected} style={{ flex: 1, minWidth: 0 }}>
          <Group gap='sm' wrap='nowrap' align='flex-start'>
            <TablerIcon name='photo' size={16} />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Group gap={6} wrap='nowrap' justify='space-between'>
                <Text size='sm' truncate c={album.writable ? undefined : 'dimmed'}>{album.title}</Text>
                <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{Math.round(candidate.p * 100)}%</Text>
              </Group>
              {target.over ? <Text size='xs' c='var(--mrx-accent)' truncate>{target.over}</Text> : (
                <Text size='xs' c='dimmed' truncate>
                  {[span, album.count !== undefined ? `${album.count.toLocaleString()} photos` : '', album.writable ? '' : 'view only'].filter(Boolean).join(' · ')}
                </Text>
              )}
              {candidate.reasons.length > 0 && (
                <Group gap={4} mt={2}>
                  {candidate.reasons.slice(0, 3).map((reason) => <Badge key={reason} size='xs' variant='light' color='gray' tt='none'>{reason}</Badge>)}
                </Group>
              )}
            </Box>
          </Group>
        </UnstyledButton>
        {selected && onReject && (
          <Tooltip label='Not this album'>
            <ActionIcon size='xs' variant='subtle' color='gray' aria-label={`Not ${album.title}`} onClick={onReject}>
              <TablerIcon name='x' size={12} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Box>
  );
}

/** One of the column's buttons, which takes a drop as a row would: the first one filled. */
function DropButton(
  { label, icon, primary, onClick, drop }: { label: string; icon: string; primary: boolean; onClick: () => void; drop?: GroupDrop },
) {
  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  return (
    <Box {...target.props} style={{ borderRadius: 'var(--mantine-radius-sm)', ...(target.over ? overStyle : {}) }}>
      <Button fullWidth justify='flex-start' variant={primary ? 'filled' : 'default'} leftSection={<TablerIcon name={icon} size={16} />} onClick={onClick}>
        <Text span inherit truncate>{target.over ?? label}</Text>
      </Button>
    </Box>
  );
}

/**
 * The Sort tab's side panel, a pane beside the stream: where the open group (or the pictures of it
 * the keys act on, which a dimmed line then names) can go. Its proposal first, as the filled button,
 * when it is something other than a new album: an album that matches, the library's copies kept,
 * clutter discarded, matched days filed. Then Create album (filled when nothing else is proposed),
 * which names it in a dialog, starting from the suggested name; Add to album…, and the albums filed
 * into lately. Under them the group's candidate albums, each with how likely and why. A click on
 * an album, recent or candidate, selects it: its own pictures are shown around the group's days,
 * with Move to it, and a wider column to compare them side by side. Then how its grouping can
 * change — for the group, its time and Not a group; for some of its pictures, a split, the groups
 * above and below, or any group — and Discard last. With groups selected, it decides on them:
 * accepting their proposals, one new album or an album for all, merging them, discarding them.
 *
 * It scrolls by itself. Pictures dragged from the stream can be dropped on its buttons and rows
 * (`drop`): each says what the drop would do as they arrive. The keys are listed by the page's
 * keyboard shortcuts, not here.
 */
export function DestinationColumn(props: Props) {
  const { acting, selected, proposal, recent, previous, next, across = false, drop, album } = props;
  const candidates = across ? [] : props.candidates ?? [];
  const label = proposalLabel(proposal);
  const single = !across && selected === 0;
  /** The proposal's own button, above Create album: for anything but a new album, and for a selection of groups their proposals. */
  const proposed = across ? 'Accept their proposals…' : label && proposal.action !== 'new' && proposal.action !== 'none' ? label : undefined;
  return (
    <Paper withBorder p='sm' radius='md' h='100%'>
      <ScrollArea type='auto' scrollbars='y' offsetScrollbars='y' h='100%'>
        {acting && <Text size='xs' c='dimmed' mb={6} truncate title={acting}>{acting}</Text>}
        <Stack gap={6} mb='xs'>
          {proposed && <DropButton label={proposed} icon={across ? 'checks' : 'circle-check'} primary onClick={props.onApply} drop={drop?.({ kind: 'proposal' })} />}
          <DropButton label='Create album' icon='photo-plus' primary={!proposed} onClick={props.onNew} drop={drop?.({ kind: 'new' })} />
          <DropButton label='Add to album…' icon='library-plus' primary={false} onClick={props.onAddTo} drop={drop?.({ kind: 'add-to' })} />
        </Stack>
        {recent.length > 0 && (
          <Stack gap={0} mb='xs'>
            {recent.slice(0, RECENT_SHOWN).map((each) => (
              <Row
                key={each.path}
                icon='history'
                label={each.title}
                selected={each.path === album?.path}
                onClick={() => props.onSelectAlbum?.(each)}
                drop={drop?.({ kind: 'recent', album: each })}
              />
            ))}
          </Stack>
        )}
        {candidates.length > 0 && (
          <Stack gap={0} mb='xs'>
            {candidates.map((candidate, index) => (
              <CandidateRow
                key={candidate.album.id}
                candidate={candidate}
                selected={candidate.album.path === album?.path}
                onSelect={() => props.onSelectAlbum?.(candidate.album)}
                onReject={props.onReject ? () => props.onReject?.(index) : undefined}
                drop={drop?.({ kind: 'recent', album: { path: candidate.album.path, title: candidate.album.title } })}
              />
            ))}
          </Stack>
        )}
        {!across && candidates.length === 0 && props.unmatched && <Text size='xs' c='dimmed' mb='xs'>No album in the library fits it well.</Text>}
        {album && (
          <Stack gap={6} mb='xs'>
            {props.strip && (
              <CompareStrip
                key={`${album.path}\n${props.strip.timeStart ?? ''}`}
                album={album}
                timeStart={props.strip.timeStart}
                timeEnd={props.strip.timeEnd}
                wide={props.comparing === true}
              />
            )}
            {props.onMove && (
              <Button
                fullWidth
                justify='flex-start'
                variant='light'
                leftSection={<TablerIcon name='photo-check' size={16} />}
                disabled={album.writable === false}
                onClick={props.onMove}
              >
                <Text span inherit truncate>Move to “{album.title}”</Text>
              </Button>
            )}
            {props.onCompare && props.strip && (
              <UnstyledButton onClick={props.onCompare} px='xs'>
                <Text size='xs' c='dimmed'>{props.comparing ? 'Narrow the column' : 'Compare side by side'}</Text>
              </UnstyledButton>
            )}
          </Stack>
        )}
        <Stack gap={0}>
          <Divider my={4} />
          {props.merge && <Row icon='arrow-merge' label={props.merge.label} detail='Into the first, which keeps its name' onClick={props.merge.run} />}
          {single && props.onDate && <Row icon='clock-edit' label='Set the time…' onClick={props.onDate} />}
          {single && props.onNotAGroup && <Row icon='unlink' label='Not a group…' detail='Its pictures go back to their lanes' onClick={props.onNotAGroup} />}
          {!across && selected > 0 && props.split && <Row icon='scissors' label={props.split.label} onClick={props.split.run} />}
          {!across && selected > 0 && previous && <Row icon='arrow-bar-to-up' label={`Move to “${previous}”`} onClick={props.onMoveUp} />}
          {!across && selected > 0 && next && <Row icon='arrow-bar-to-down' label={`Move to “${next}”`} onClick={props.onMoveDown} />}
          {!across && selected > 0 && <Row icon='arrows-transfer-up' label='Move to a group…' detail='Or a new group of their own' onClick={props.onMoveTo} />}
          <Divider my={4} />
          <Row icon='trash' label='Discard' detail='To the trash, with Undo' onClick={props.onDiscard} drop={drop?.({ kind: 'discard' })} />
        </Stack>
      </ScrollArea>
    </Paper>
  );
}
