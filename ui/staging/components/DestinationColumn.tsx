import type { StagingCandidate } from '@archive/staging/api';
import type { Proposal } from '@archive/staging/proposal';
import { formatRange, TablerIcon } from '@ein/ui/components';
import { useDropTarget } from '@ein/ui/hooks';
import { ActionIcon, Badge, Box, Button, Divider, Group, Kbd, Paper, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';
import { type AlbumTarget, CONFIDENCE_WORDS, proposalLabel } from '../lib/destinations.ts';
import { CompareStrip } from './CompareStrip.tsx';
import type { GroupDrop } from './GroupHeader.tsx';

/** A row of the column pictures can be dropped on. */
export type DropDestination =
  | { kind: 'proposal' }
  | { kind: 'new'; private: boolean }
  | { kind: 'target' }
  | { kind: 'recent'; album: AlbumTarget }
  | { kind: 'add-to' }
  | { kind: 'later' }
  | { kind: 'discard' };

type Props = {
  /** What the column decides on: the group's name, or how many of its pictures are selected. */
  subject: string;
  /** How many of the group's pictures the keys act on: those selected, or a part's. */
  selected: number;
  /** The part the keys are on, by its name, when they act on a part rather than a selection. */
  part?: string;
  proposal: Proposal;
  target: AlbumTarget | null;
  recent: readonly AlbumTarget[];
  /** The neighbouring groups' names, which M and ⇧M merge with. */
  previous?: string;
  next?: string;
  later: boolean;
  onApply: () => void;
  onNew: () => void;
  onPrivate: () => void;
  onAddTo: () => void;
  onTarget: () => void;
  onSetTarget: () => void;
  onRecent: (album: AlbumTarget) => void;
  onLater: () => void;
  onDiscard: () => void;
  onMergeUp?: () => void;
  onMergeDown?: () => void;
  /** S on the pictures: split the group before them, or in a lane make them a group (`split.label` says which). */
  split?: { label: string; run: () => void };
  /** `<` and `>`: the pictures into the group above or below. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** G: the pictures into a group chosen, or a new one. */
  onMoveTo?: () => void;
  /** T: set the time of the group's pictures. */
  onDate?: () => void;
  /** The group is no group; absent for a lane. */
  onNotAGroup?: () => void;
  /** A selection across groups, which the column then decides on: how many groups and photos it holds. */
  groups?: { count: number; files: number };
  /** What a drop of pictures on a row does; none takes no drop. */
  drop?: (destination: DropDestination) => GroupDrop | undefined;
  /**
   * The library albums the group may go into, best first (at most three, keys 1–3), and the one
   * highlighted (`,` and `.`), which R rejects and whose own pictures the strip shows.
   */
  candidates?: readonly StagingCandidate[];
  highlighted?: number;
  onCandidate?: (index: number) => void;
  onHighlight?: (index: number) => void;
  onReject?: (index: number) => void;
  /** The group was compared with the library and no album fits it well. */
  unmatched?: boolean;
  /** When the group was taken, which the strip of the highlighted album opens on. */
  strip?: { timeStart?: string; timeEnd?: string };
  /** The column is widened to compare (C). */
  comparing?: boolean;
  onCompare?: () => void;
};

const dots = { high: '●●●', medium: '●●○', low: '●○○' } as const;

/** The look of a row a drag of pictures is over: dashed in the accent, saying what the drop would do. */
const overStyle = { outline: '2px dashed var(--mrx-accent)', outlineOffset: -2 } as const;

/**
 * One choice of the column: its key, what it does, and a quieter second line, which says what a
 * drop would do while pictures are dragged over it.
 */
function Row(
  { keys, icon, label, detail, onClick, disabled, drop }: {
    keys?: string;
    icon: string;
    label: ReactNode;
    detail?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    drop?: GroupDrop;
  },
) {
  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  return (
    <UnstyledButton
      className='mrx-pick-row'
      onClick={onClick}
      disabled={disabled}
      px='xs'
      py={6}
      style={{ borderRadius: 'var(--mantine-radius-sm)', ...(target.over ? overStyle : {}) }}
      {...target.props}
    >
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <TablerIcon name={icon} size={16} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm' truncate>{label}</Text>
          {target.over ? <Text size='xs' c='var(--mrx-accent)' truncate>{target.over}</Text> : detail && <Text size='xs' c='dimmed' truncate>{detail}</Text>}
        </Box>
        {keys && <Kbd size='xs'>{keys}</Kbd>}
      </Group>
    </UnstyledButton>
  );
}

/**
 * One candidate album: its key, title, span and size, how likely, and why, as chips; one the reader
 * may not file into is shown and not offered. The highlighted one carries "Not this album".
 */
function CandidateRow(
  { candidate, index, highlighted, onFile, onHighlight, onReject, drop }: {
    candidate: StagingCandidate;
    index: number;
    highlighted: boolean;
    onFile?: () => void;
    onHighlight?: () => void;
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
      onMouseEnter={onHighlight}
      style={{
        borderRadius: 'var(--mantine-radius-sm)',
        background: highlighted ? 'var(--mrx-surface-sunken)' : undefined,
        boxShadow: highlighted ? 'inset 3px 0 0 var(--mrx-accent)' : undefined,
        ...(target.over ? overStyle : {}),
      }}
      {...target.props}
    >
      <Group gap='sm' wrap='nowrap' align='flex-start'>
        <UnstyledButton onClick={album.writable ? onFile : undefined} disabled={!album.writable} style={{ flex: 1, minWidth: 0 }} aria-label={`Into ${album.title}`}>
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
        <Stack gap={2} align='flex-end'>
          {album.writable && <Kbd size='xs'>{index + 1}</Kbd>}
          {highlighted && onReject && (
            <Tooltip label='Not this album (R)'>
              <ActionIcon size='xs' variant='subtle' color='gray' aria-label={`Not ${album.title}`} onClick={onReject}>
                <TablerIcon name='x' size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </Stack>
      </Group>
    </Box>
  );
}

/** The proposal's button, which takes a drop as its row would. */
function ProposalButton({ label, onClick, drop }: { label: string; onClick: () => void; drop?: GroupDrop }) {
  const target = useDropTarget({ accept: (payload) => drop?.accept(payload) ?? null, onDrop: (payload) => drop?.onDrop(payload), disabled: !drop });
  return (
    <Box {...target.props} mb={4} style={{ borderRadius: 'var(--mantine-radius-sm)', ...(target.over ? overStyle : {}) }}>
      <Button fullWidth justify='space-between' onClick={onClick} rightSection={<Kbd size='xs'>Enter</Kbd>}>
        <Text span inherit truncate>{target.over ?? label}</Text>
      </Button>
    </Box>
  );
}

/**
 * The Sort tab's destination column, beside the stream: where the open group (or the pictures of
 * it the keys act on) can go, each with its key. The proposal first, then a new album, a private
 * one, the sticky target and the albums filed into lately, any album; then how its grouping can
 * change — for the group, the neighbours to merge with, its time and Not a group; for some of its
 * pictures, a split, the groups above and below, or any group; Later and Discard last. With a
 * selection across groups, it decides on that: Enter accepts the proposals of every group in it.
 *
 * Under the proposal are the group's candidate albums (1–3), each with how likely and why; `,`
 * and `.` move the highlight, R says the highlighted one is not where the group goes, and the
 * highlighted album's own pictures around the group's days are under them. C widens the column to
 * compare them side by side.
 *
 * Pictures and groups dragged from the stream can be dropped on its rows (`drop`): each says what
 * the drop would do as they arrive.
 */
export function DestinationColumn(props: Props) {
  const { subject, selected, part, proposal, target, recent, previous, next, later, groups, drop } = props;
  const candidates = groups ? [] : props.candidates ?? [];
  const highlighted = Math.min(props.highlighted ?? 0, Math.max(0, candidates.length - 1));
  const shown = candidates[highlighted];
  const label = proposalLabel(proposal);
  const heading = groups
    ? `Put ${groups.count.toLocaleString()} ${groups.count === 1 ? 'group' : 'groups'} in`
    : part
    ? `Put ${part} in`
    : selected > 0
    ? `Put ${selected.toLocaleString()} selected in`
    : 'Put it in';
  const single = !groups && selected === 0;
  return (
    <Paper withBorder p='sm' radius='md'>
      <Text size='xs' fw={700} tt='uppercase' c='dimmed' mb={6}>{heading}</Text>
      <Text size='sm' fw={600} truncate mb='xs' title={subject}>{subject}</Text>
      {groups
        ? <ProposalButton label='Accept their proposals…' onClick={props.onApply} drop={drop?.({ kind: 'proposal' })} />
        : label && proposal.action !== 'none'
        ? <ProposalButton label={label} onClick={props.onApply} drop={drop?.({ kind: 'proposal' })} />
        : <Text size='xs' c='dimmed' mb={4}>No proposal: N, A, B or X.</Text>}
      {!groups && proposal.action !== 'none' && (
        <Text size='xs' c='dimmed' mb='xs'>
          {dots[proposal.confidence]} {CONFIDENCE_WORDS[proposal.confidence]}
          {proposal.action === 'existing' && proposal.reason === 'category' ? ' · the category’s album' : ''}
        </Text>
      )}
      {candidates.length > 0 && (
        <Stack gap={0} mb='xs'>
          {candidates.map((candidate, index) => (
            <CandidateRow
              key={candidate.album.id}
              candidate={candidate}
              index={index}
              highlighted={index === highlighted}
              onFile={() => props.onCandidate?.(index)}
              onHighlight={() => props.onHighlight?.(index)}
              onReject={props.onReject ? () => props.onReject?.(index) : undefined}
              drop={drop?.({ kind: 'recent', album: { path: candidate.album.path, title: candidate.album.title } })}
            />
          ))}
        </Stack>
      )}
      {!groups && candidates.length === 0 && props.unmatched && <Text size='xs' c='dimmed' mb='xs'>No album in the library fits it well.</Text>}
      {shown && props.strip && (
        <Box mb='xs'>
          <CompareStrip
            key={`${shown.album.path}\n${props.strip.timeStart ?? ''}`}
            album={shown.album}
            timeStart={props.strip.timeStart}
            timeEnd={props.strip.timeEnd}
            wide={props.comparing === true}
          />
          {props.onCompare && (
            <UnstyledButton onClick={props.onCompare} px='xs' mt={2}>
              <Text size='xs' c='dimmed'>{props.comparing ? 'Narrow the column (C)' : 'Compare side by side (C)'}</Text>
            </UnstyledButton>
          )}
        </Box>
      )}
      <Stack gap={0}>
        <Row keys='N' icon='photo-plus' label='New album' onClick={props.onNew} drop={drop?.({ kind: 'new', private: false })} />
        <Row keys='P' icon='lock' label='New private album' detail='Only you see it' onClick={props.onPrivate} drop={drop?.({ kind: 'new', private: true })} />
        <Divider my={4} />
        <Row
          keys='B'
          icon='star'
          label={target ? target.title : 'Choose a target…'}
          detail={target ? '⇧B chooses another' : undefined}
          onClick={props.onTarget}
          drop={drop?.({ kind: 'target' })}
        />
        {target && (
          <UnstyledButton onClick={props.onSetTarget} px='xs'>
            <Text size='xs' c='dimmed'>Choose another target</Text>
          </UnstyledButton>
        )}
        {recent.filter((album) => album.path !== target?.path).slice(0, 4).map((album) => (
          <Row
            key={album.path}
            icon='history'
            label={album.title}
            onClick={() => props.onRecent(album)}
            drop={drop?.({ kind: 'recent', album })}
          />
        ))}
        <Row keys='A' icon='library-plus' label='Add to album…' onClick={props.onAddTo} drop={drop?.({ kind: 'add-to' })} />
        <Divider my={4} />
        {single && previous && <Row keys='M' icon='arrow-merge-up' label={`Merge into “${previous}”`} onClick={props.onMergeUp} disabled={!props.onMergeUp} />}
        {single && next && <Row keys='⇧M' icon='arrow-merge-down' label={`Merge “${next}” in`} onClick={props.onMergeDown} disabled={!props.onMergeDown} />}
        {single && props.onDate && <Row keys='T' icon='clock-edit' label='Set the time…' onClick={props.onDate} />}
        {single && props.onNotAGroup && <Row icon='unlink' label='Not a group…' detail='Its pictures go back to their lanes' onClick={props.onNotAGroup} />}
        {!groups && selected > 0 && props.split && <Row keys='S' icon='scissors' label={props.split.label} onClick={props.split.run} />}
        {!groups && selected > 0 && previous && <Row keys='<' icon='arrow-bar-to-up' label={`Move to “${previous}”`} onClick={props.onMoveUp} />}
        {!groups && selected > 0 && next && <Row keys='>' icon='arrow-bar-to-down' label={`Move to “${next}”`} onClick={props.onMoveDown} />}
        {!groups && selected > 0 && <Row keys='G' icon='arrows-transfer-up' label='Move to a group…' detail='Or a new group of their own' onClick={props.onMoveTo} />}
        <Divider my={4} />
        {(single || groups) && (
          <Row
            keys='L'
            icon='clock-pause'
            label={later ? (groups ? 'Back to their lanes' : 'Back to its lane') : 'Later'}
            onClick={props.onLater}
            drop={drop?.({ kind: 'later' })}
          />
        )}
        <Row keys='X' icon='trash' label='Discard' detail='To the trash, with Undo' onClick={props.onDiscard} drop={drop?.({ kind: 'discard' })} />
      </Stack>
    </Paper>
  );
}
