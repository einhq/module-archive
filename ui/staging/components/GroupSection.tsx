import { MediaGrid, MediaStrip, TablerIcon } from '@ein/ui/components';
import { useSettledInViewport } from '@ein/ui/hooks';
import type { MediaDragPayload, TileBox } from '@ein/ui/lib';
import type { MediaSelection } from '@ein/ui/hooks';
import type { MediaItem } from '@ein/ui/signals';
import { Alert, Box, Button, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import type { GroupRow } from '../hooks/useGroupIndex.ts';
import { useGroupMedia } from '../hooks/useGroupMedia.ts';
import { type PartSection, partSections } from '../lib/part-sections.ts';
import type { TileBadge } from '../lib/duplicate-sets.ts';
import { duplicateBadge } from './DuplicateBadge.tsx';
import { type GroupActions, type GroupDrop, type GroupDuplicates, type GroupFailure, GroupHeader, type GroupSelect, type GroupSelected } from './GroupHeader.tsx';

/**
 * A closed section's parts, in px: its header's two lines, its two strip rows, and what is under
 * them. They add up to one height for every closed section, which is what lets the stream place
 * them by arithmetic. A phone's rows are lower, and it has the main action as a button under them.
 */
export const SECTION_METRICS = {
  desktop: { header: 64, row: 104, foot: 25 },
  phone: { header: 56, row: 76, foot: 49 },
} as const;

/** Between a section's strip rows, as in a media grid. */
const STRIP_GAP = 3;

/** A closed section's height on a phone or wider. */
export const closedSectionHeight = (phone: boolean): number => {
  const metrics = phone ? SECTION_METRICS.phone : SECTION_METRICS.desktop;
  return metrics.header + 2 * metrics.row + STRIP_GAP + metrics.foot;
};

/** How long a closed section must stay in view before its pictures are asked for. */
const SETTLE_MS = 150;

/** How long an open section takes to slide up into the place of the group decided before it. */
const ARRIVE_MS = 120;

type Props = {
  row: GroupRow;
  open: boolean;
  phone: boolean;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  previous?: string;
  next?: string;
  failure?: GroupFailure;
  onDismissFailure: () => void;
  /** Make this the cursor's group, which opens it. */
  onActivate: () => void;
  actions: GroupActions;
  /** The keyboard's picture in the open group, by path. */
  tileCursor: string | null;
  /** The open group's pictures and their boxes in its grids, in order, whenever they change: what the arrows move over. */
  onTiles?: (items: MediaItem[], boxes: TileBox[]) => void;
  /** The open group's pictures selected; a click then toggles one. */
  selection?: MediaSelection;
  /** The open group's part the keys act on (`[`, `]`), by id. */
  partCursor?: string | null;
  /** The open group's parts, whenever they change: a day each, or a month each in a long group. */
  onParts?: (parts: PartSection<MediaItem>[], byMonth: boolean) => void;
  /**
   * Cut the open group at a part: split it before the part, or in a lane make the part a group of
   * its own, which the first part can be too (`fromFirst`).
   */
  partCut?: { label: string; fromFirst: boolean; run: (part: PartSection<MediaItem>) => void };
  /** The album a part of the open group (by its key, a day) is matched to, and filing it there. */
  partMatch?: PartMatch;
  /** Pictures of the open group the keys act on, which can become a new group of their own. */
  newGroup?: { count: number; run: () => void };
  /**
   * The group opens in the place of one just decided: it slides up into it from this many px
   * below, at once under reduced motion.
   */
  arriveFrom?: number;
  /** How much of the group is selected, and how its header selects it (desktop). */
  selected?: GroupSelected;
  onSelect?: GroupSelect;
  /** What its header's grip carries when dragged. */
  grip?: () => MediaDragPayload;
  /** Pictures or groups dropped on its header. */
  drop?: GroupDrop;
  /** What dragging a selected picture of the open group carries. */
  dragPayload?: (item: MediaItem) => MediaDragPayload | undefined;
  /**
   * The open group's copies and look-alikes: a badge per picture (of a library photo, or of
   * another staged one), which opens its set side by side, and keeping the library's copies.
   */
  duplicates?: { badges: ReadonlyMap<string, TileBadge>; compare: (id: string) => void; keepLibrary?: () => void };
};

/** The album a part (by its key) is matched to: how likely, whether the reader may file into it, and filing the part there. */
export type PartMatch = (key: string) => { title: string; p: number; writable: boolean; run: (part: PartSection<MediaItem>) => void } | undefined;

/**
 * One suggested album in the Sort stream. Closed, it is its header and a two-row strip of its
 * pictures, always the same height. Open — it is the cursor's — it is the header, kept in sight
 * under the page's headers, and every picture in a grid per part (a day, or a month in a long
 * group), with a zone that makes the pictures the keys act on a new group. Its pictures are asked for once
 * it has settled in view (or is open), and no picture without renditions yet is fetched: such a
 * tile is drawn as a placeholder. An open group's copies and look-alikes carry a badge each, and its
 * header says how many. When they cannot be read, it says why, with Retry. Selected
 * whole, a closed one is tinted; a click on its strip with Shift, Ctrl or Cmd selects it as its
 * header's box does, and the open one's selected pictures can be dragged.
 */
export function GroupSection(
  {
    row,
    open,
    phone,
    renaming,
    onRenamingChange,
    previous,
    next,
    failure,
    onDismissFailure,
    onActivate,
    actions,
    tileCursor,
    onTiles,
    selection,
    partCursor = null,
    onParts,
    partCut,
    partMatch,
    newGroup,
    arriveFrom,
    selected = 'none',
    onSelect,
    grip,
    drop,
    dragPayload,
    duplicates,
  }: Props,
) {
  const metrics = phone ? SECTION_METRICS.phone : SECTION_METRICS.desktop;
  const { ref: settleRef, settled } = useSettledInViewport<HTMLDivElement>(SETTLE_MS);
  const media = useGroupMedia(row.path, row.staging.memberKey, open || settled);

  // A transform, so the stream's arithmetic and the page's scroll position are left alone.
  const box = useRef<HTMLDivElement | null>(null);
  const ref = useMergedRef(settleRef, box);
  useLayoutEffect(() => {
    if (!open || !arriveFrom || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    box.current?.animate([{ transform: `translateY(${arriveFrom}px)` }, { transform: 'none' }], { duration: ARRIVE_MS, easing: 'ease-out' });
  }, [open, arriveFrom]);

  const mediaError = media.error && (
    <Alert color='red' variant='light' py={open ? undefined : 6} icon={<TablerIcon name='alert-circle' size={16} />}>
      <Group justify='space-between' wrap='nowrap'>
        <Text size='sm' truncate title={media.error.message} style={{ minWidth: 0 }}>{media.error.message}</Text>
        <Button size='compact-xs' variant='light' onClick={media.retry}>Retry</Button>
      </Group>
    </Alert>
  );

  const items = media.set?.items;
  const chip: GroupDuplicates | undefined = duplicates && open
    ? {
      library: [...duplicates.badges.values()].filter((badge) => badge === 'library').length,
      inbox: [...duplicates.badges.values()].filter((badge) => badge === 'inbox').length,
      compare: () => {
        const first = items?.find((item) => duplicates.badges.has(item.id));
        if (first) duplicates.compare(first.id);
      },
      ...(duplicates.keepLibrary ? { keepLibrary: duplicates.keepLibrary } : {}),
      ...(selection && items ? { select: () => selection.setKeys(items.filter((item) => duplicates.badges.has(item.id)).map((item) => item.path), true) } : {}),
    }
    : undefined;

  const header = (
    <GroupHeader
      row={row}
      open={open}
      phone={phone}
      height={metrics.header}
      renaming={renaming}
      onRenamingChange={onRenamingChange}
      previous={previous}
      next={next}
      failure={failure}
      onDismissFailure={onDismissFailure}
      onActivate={onActivate}
      actions={actions}
      selected={selected}
      onSelect={onSelect}
      grip={grip}
      drop={drop}
      duplicates={chip}
    />
  );

  if (!open) {
    return (
      <Box
        ref={ref}
        px='md'
        h={closedSectionHeight(phone)}
        data-group={row.name}
        data-selected={selected === 'all' || undefined}
        style={selected === 'all' ? { background: 'color-mix(in srgb, var(--mrx-accent) 10%, transparent)', boxShadow: 'inset 3px 0 0 var(--mrx-accent)' } : undefined}
      >
        {header}
        {mediaError || (
          <Box
            onClick={(event) => {
              if (onSelect && (event.shiftKey || event.metaKey || event.ctrlKey)) onSelect({ range: event.shiftKey });
              else onActivate();
            }}
            style={{ cursor: 'pointer' }}
          >
            <MediaStrip items={media.set?.items ?? null} total={row.memberCount} rowHeight={metrics.row} gap={STRIP_GAP} originals={false} onOpen={onActivate} />
          </Box>
        )}
        {phone && (
          <Group mt={8} gap='xs' wrap='nowrap'>
            <Button size='compact-sm' variant='light' onClick={actions.proposal?.run ?? actions.newAlbum} style={{ maxWidth: '100%' }}>
              <Text span inherit truncate>{actions.proposal?.label ?? 'New album…'}</Text>
            </Button>
          </Group>
        )}
      </Box>
    );
  }

  return (
    <Box
      ref={ref}
      data-group={row.name}
      data-open
      px='md'
      pb='lg'
      style={{ borderLeft: '3px solid var(--mrx-accent)', background: 'var(--mrx-surface-raised)' }}
    >
      <Box
        style={{
          position: 'sticky',
          top: 'calc(var(--app-shell-header-height) + var(--mrx-stuck-header-height, 0px))',
          zIndex: 3,
          background: 'var(--mrx-surface-raised)',
        }}
      >
        {header}
      </Box>
      {mediaError ? mediaError : !media.set ? <MediaGrid items={[]} loading /> : media.set.truncated
        ? (
          // Too many to lay out at once: the album's own timeline, which pages.
          <MediaTimeline album={row.path} granularity='day' ascending />
        )
        : (
          <OpenGrids
            items={media.set.items}
            tileCursor={tileCursor}
            onTiles={onTiles}
            selection={selection}
            partCursor={partCursor}
            onParts={onParts}
            partCut={partCut}
            partMatch={partMatch}
            dragPayload={dragPayload}
            duplicates={duplicates}
          />
        )}
      {newGroup && newGroup.count > 0 && (
        <UnstyledButton onClick={newGroup.run} mt='sm' w='100%' data-new-group>
          <Paper p='sm' radius='md' style={{ border: '1px dashed var(--mrx-text-tertiary)', background: 'transparent' }}>
            <Group gap='xs' justify='center'>
              <TablerIcon name='square-plus' size={16} />
              <Text size='sm'>New group of {newGroup.count.toLocaleString()} {newGroup.count === 1 ? 'picture' : 'pictures'}</Text>
            </Group>
          </Paper>
        </UnstyledButton>
      )}
      {next && (
        <Text size='xs' c='dimmed' mt='md'>
          Next: {next}
        </Text>
      )}
    </Box>
  );
}

/**
 * The open group's pictures, a grid per part (`lib/part-sections.ts`) under the part's name:
 * a day, or in a long group a month with its days as chips, which select that day's pictures. It
 * reports its parts, and where each tile is in the group's picture order. A part after the first
 * can be cut off with its header's button; the part the keys are on is marked.
 */
function OpenGrids(
  { items, tileCursor, onTiles, selection, partCursor, onParts, partCut, partMatch, dragPayload, duplicates }: {
    items: MediaItem[];
    tileCursor: string | null;
    onTiles?: (items: MediaItem[], boxes: TileBox[]) => void;
    selection?: MediaSelection;
    partCursor: string | null;
    onParts?: (parts: PartSection<MediaItem>[], byMonth: boolean) => void;
    partCut?: { label: string; fromFirst: boolean; run: (part: PartSection<MediaItem>) => void };
    partMatch?: PartMatch;
    dragPayload?: (item: MediaItem) => MediaDragPayload | undefined;
    duplicates?: Props['duplicates'];
  },
) {
  const layout = useMemo(() => partSections(items, (item) => item.takenAt), [items]);
  const sections = layout.sections;
  const [boxes, setBoxes] = useState<ReadonlyMap<number, readonly TileBox[]>>(() => new Map());
  const wrappers = useRef(new Map<number, HTMLDivElement>());
  const report = useCallback((section: number, tiles: readonly TileBox[]) => {
    setBoxes((previous) => new Map(previous).set(section, tiles));
  }, []);

  // Each grid's boxes are its own; moved by where the grid sits, they make one picture of the group.
  const onTilesRef = useRef(onTiles);
  onTilesRef.current = onTiles;
  useLayoutEffect(() => {
    if (sections.some((_, index) => !boxes.has(index))) return;
    const combined = sections.flatMap((_, index) => {
      const top = wrappers.current.get(index)?.offsetTop ?? 0;
      return (boxes.get(index) ?? []).map((box) => ({ ...box, top: box.top + top }));
    });
    onTilesRef.current?.(layout.items, combined);
  }, [boxes, sections, layout.items]);
  const onPartsRef = useRef(onParts);
  onPartsRef.current = onParts;
  useLayoutEffect(() => onPartsRef.current?.(sections, layout.byMonth), [sections, layout.byMonth]);

  if (items.length === 0) return <Text size='sm' c='dimmed' py='md'>No pictures, videos or recordings in this group.</Text>;

  return (
    <Stack gap='sm' pos='relative' data-parts>
      {sections.map((section, index) => (
        <Box key={section.id} data-part={section.id} data-part-key={section.key}>
          {(sections.length > 1 || layout.byMonth) && (
            <PartHeader
              section={section}
              current={section.id === partCursor}
              cut={index > 0 || partCut?.fromFirst ? partCut : undefined}
              match={partMatch?.(section.key)}
              onDay={selection ? (day) => selection.setKeys(layout.items.slice(day.startIndex, day.startIndex + day.count).map((item) => item.path), true) : undefined}
            />
          )}
          <Box
            ref={(node: HTMLDivElement | null) => {
              if (node) wrappers.current.set(index, node);
              else wrappers.current.delete(index);
            }}
          >
            <MediaGrid
              items={section.items}
              lightboxItems={layout.items}
              indexOffset={section.startIndex}
              tileKeys={false}
              originals={false}
              focusPath={tileCursor ?? undefined}
              selection={selection}
              onLayout={(tiles) => report(index, tiles)}
              dragPayload={dragPayload}
              renderOverlay={duplicates
                ? (item) => {
                  const badge = duplicates.badges.get(item.id);
                  return badge ? duplicateBadge(badge, () => duplicates.compare(item.id)) : null;
                }
                : undefined}
            />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

/**
 * A part's line over its grid: its name and how many pictures it has, the album it is matched to
 * with a button that files it there, a month's days as chips, and the button that cuts the group
 * before it. The part the keys are on is marked.
 */
function PartHeader(
  { section, current, cut, match, onDay }: {
    section: PartSection<MediaItem>;
    current: boolean;
    cut?: { label: string; fromFirst: boolean; run: (part: PartSection<MediaItem>) => void };
    match?: ReturnType<PartMatch>;
    onDay?: (day: NonNullable<PartSection<MediaItem>['days']>[number]) => void;
  },
) {
  return (
    <Box
      mb={4}
      px={6}
      py={2}
      style={{
        borderRadius: 'var(--mantine-radius-sm)',
        boxShadow: current ? 'inset 3px 0 0 var(--mrx-accent)' : undefined,
        background: current ? 'var(--mrx-surface-sunken)' : undefined,
      }}
    >
      <Group justify='space-between' wrap='nowrap' gap='xs'>
        <Text size='sm' fw={current ? 700 : 500} c={current ? undefined : 'dimmed'} truncate>
          {section.label} · {section.items.length.toLocaleString()}
          {match ? ` · → ${match.title} ${Math.round(match.p * 100)}%` : ''}
        </Text>
        {match?.writable && (
          <Button size='compact-xs' variant='light' leftSection={<TablerIcon name='photo-check' size={12} />} onClick={() => match.run(section)}>
            File
          </Button>
        )}
        {cut && (
          <Button size='compact-xs' variant='subtle' color='gray' leftSection={<TablerIcon name='scissors' size={12} />} onClick={() => cut.run(section)}>
            {cut.label}
          </Button>
        )}
      </Group>
      {section.days && section.days.length > 0 && (
        <Group gap={4} mt={4}>
          {section.days.map((day) => (
            <Button
              key={`${day.key}:${day.startIndex}`}
              size='compact-xs'
              variant='light'
              color='gray'
              disabled={!onDay}
              onClick={() => onDay?.(day)}
              title={onDay ? 'Select the pictures of this day' : undefined}
            >
              {day.label} · {day.count}
            </Button>
          ))}
        </Group>
      )}
    </Box>
  );
}
