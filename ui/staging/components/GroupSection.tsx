import { GRID_GAP, MediaGrid, TablerIcon } from '@ein/ui/components';
import { useSettledInViewport } from '@ein/ui/hooks';
import type { MediaDragPayload, TileBox } from '@ein/ui/lib';
import type { MediaSelection } from '@ein/ui/hooks';
import type { MediaItem } from '@ein/ui/signals';
import { Alert, Box, Button, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { useMergedRef } from '@mantine/hooks';
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MediaTimeline } from '../../components/MediaTimeline.tsx';
import type { GroupRow } from '../hooks/useGroupIndex.ts';
import { useGroupMedia } from '../hooks/useGroupMedia.ts';
import { type PartSection, partSections } from '../lib/part-sections.ts';
import { type GroupActions, type GroupDrop, type GroupFailure, GroupHeader, type GroupSelect, type GroupSelected } from './GroupHeader.tsx';

/**
 * A closed section's parts, in px: its header's two lines, the height its grid's rows aim for, and
 * what is under the grid — the foot of its frame and the gap to the next. A phone's rows are lower,
 * and it has the main action as a button under them.
 */
export const SECTION_METRICS = {
  desktop: { header: 64, row: 104, foot: 24 },
  phone: { header: 56, row: 76, foot: 58 },
} as const;

/** Between one section's frame and the next. */
const SECTION_GAP = 12;

/** What a picture's width is to its height, on average, for guessing how many rows a group's grid takes. */
const MEAN_ASPECT = 1.2;

/** How tall a grid of `count` pictures `width` px wide is likely to be, before their shapes are known. */
export const gridEstimate = (count: number, width: number, phone: boolean): number => {
  const row = phone ? SECTION_METRICS.phone.row : SECTION_METRICS.desktop.row;
  const rows = Math.max(1, Math.ceil((count * MEAN_ASPECT * row) / Math.max(1, width)));
  return rows * row + (rows - 1) * GRID_GAP;
};

/** How tall a closed section of `count` pictures, its grid `width` px wide, is likely to be: the stream's guess until it is measured. */
export const closedSectionEstimate = (count: number, width: number, phone: boolean): number => {
  const metrics = phone ? SECTION_METRICS.phone : SECTION_METRICS.desktop;
  return metrics.header + gridEstimate(count, width, phone) + metrics.foot;
};

/**
 * A section's frame, the same for every section so that moving the cursor moves nothing: the
 * cursor's group's is drawn in the accent, and one selected whole is tinted.
 */
export const frameStyle = (open: boolean, selected: boolean) => ({
  border: `1px solid ${open ? 'var(--mrx-accent)' : selected ? 'color-mix(in srgb, var(--mrx-accent) 50%, transparent)' : 'var(--mantine-color-default-border)'}`,
  borderRadius: 'var(--mantine-radius-md)',
  background: selected ? 'color-mix(in srgb, var(--mrx-accent) 10%, var(--mrx-surface-raised))' : 'var(--mrx-surface-raised)',
});

/** A closed section's grid, from the stream's edge: the section's margin, its frame's line and its padding (Mantine's `md` and `sm`). */
export const SECTION_INSET = 16 + 1 + 10;

/** A closed section's height on a phone or wider when its grid is two rows: what the stream starts from. */
export const closedSectionHeight = (phone: boolean): number => {
  const metrics = phone ? SECTION_METRICS.phone : SECTION_METRICS.desktop;
  return metrics.header + 2 * metrics.row + GRID_GAP + metrics.foot;
};

/** How long a closed section must stay in view before its pictures are asked for. */
const SETTLE_MS = 150;

/** How long an open section takes to slide up into the place of the group decided before it. */
const ARRIVE_MS = 120;

type Props = {
  row: GroupRow;
  /** Its pictures are shown in a grid per part, which the keys step through, rather than in one grid; only the cursor's group can be. */
  open: boolean;
  /** It is the cursor's group, which the keys act on. */
  current: boolean;
  /** Show its pictures by part, or in one grid again. */
  onExpand: () => void;
  phone: boolean;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  /** The next group's name, said under an expanded one. */
  next?: string;
  failure?: GroupFailure;
  onDismissFailure: () => void;
  /** Make this the cursor's group. */
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
   * The cursor comes to the group in the place of one just decided: it slides up into it from this
   * many px below, at once under reduced motion.
   */
  arriveFrom?: number;
  /** How much of the group is selected, and how its header selects it (desktop). */
  selected?: GroupSelected;
  onSelect?: GroupSelect;
  /** Pictures or groups dropped on its header. */
  drop?: GroupDrop;
  /** What dragging a selected picture of the open group carries. */
  dragPayload?: (item: MediaItem) => MediaDragPayload | undefined;
  /** The stream's own pane, when it scrolls in one rather than the window. */
  scrollRoot?: HTMLElement;
  /** How tall the closed grid is likely to be: the room kept for it while its pictures are read. */
  gridHeight: number;
  /** A mark drawn on a picture's tile: how many identical files it has. */
  renderOverlay?: (item: MediaItem) => ReactNode;
};

/** The album a part (by its key) is matched to: how likely, whether the reader may file into it, and filing the part there. */
export type PartMatch = (key: string) => { title: string; p: number; writable: boolean; run: (part: PartSection<MediaItem>) => void } | undefined;

/**
 * One suggested album in the Sort stream, in a frame, drawn in the accent while it is the cursor's
 * group. Closed, it is its header and every picture in one grid of low rows, a click on one opening
 * the lightbox and nothing else; the cursor's group too, so stepping from group to group moves nothing. While its
 * pictures are read it keeps the room the stream guessed for it (`gridHeight`); a group too large
 * to lay out at once offers to page through them, expanded. Expanded (`open`, by its header's
 * button, Space, or a key that needs its pictures laid out) it is the header, kept in sight
 * under the page's headers (at the top of the stream's pane, in one), and every picture in a grid per part (a day, or a month in a long
 * group), with a zone that makes the pictures the keys act on a new group. Its pictures are asked for once
 * it has settled in view (or is open), and no picture without renditions yet is fetched: such a
 * tile is drawn as a placeholder. A picture with identical files, which join no group, carries a
 * badge saying how many (`renderOverlay`). When they cannot be read, it says why, with Retry. Selected whole, a closed
 * one is tinted; a click on its grid with Shift, Ctrl or Cmd selects it as its
 * header's box does, and the open one's selected pictures can be dragged.
 */
export function GroupSection(
  {
    row,
    open,
    current,
    onExpand,
    phone,
    renaming,
    onRenamingChange,
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
    drop,
    dragPayload,
    scrollRoot,
    gridHeight,
    renderOverlay,
  }: Props,
) {
  const metrics = phone ? SECTION_METRICS.phone : SECTION_METRICS.desktop;
  const { ref: settleRef, settled } = useSettledInViewport<HTMLDivElement>(SETTLE_MS);
  const media = useGroupMedia(row.path, row.staging.memberKey, open || settled);

  // A transform, so the stream's arithmetic and the page's scroll position are left alone.
  const box = useRef<HTMLDivElement | null>(null);
  const ref = useMergedRef(settleRef, box);
  useLayoutEffect(() => {
    if (!current || !arriveFrom || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    box.current?.animate([{ transform: `translateY(${arriveFrom}px)` }, { transform: 'none' }], { duration: ARRIVE_MS, easing: 'ease-out' });
  }, [current, arriveFrom]);

  const mediaError = media.error && (
    <Alert color='red' variant='light' py={open ? undefined : 6} icon={<TablerIcon name='alert-circle' size={16} />}>
      <Group justify='space-between' wrap='nowrap'>
        <Text size='sm' truncate title={media.error.message} style={{ minWidth: 0 }}>{media.error.message}</Text>
        <Button size='compact-xs' variant='light' onClick={media.retry}>Retry</Button>
      </Group>
    </Alert>
  );

  const header = (
    <GroupHeader
      row={row}
      current={current}
      expanded={open}
      onExpand={onExpand}
      phone={phone}
      height={metrics.header}
      renaming={renaming}
      onRenamingChange={onRenamingChange}
      failure={failure}
      onDismissFailure={onDismissFailure}
      onActivate={onActivate}
      actions={actions}
      selected={selected}
      onSelect={onSelect}
      drop={drop}
    />
  );

  if (!open) {
    return (
      <Box ref={ref} px='md' pb={SECTION_GAP} data-group={row.name} data-selected={selected === 'all' || undefined}>
        <Box px='sm' pb={10} style={frameStyle(current, selected === 'all')}>
          {header}
          {mediaError || (
            // A click on a picture opens the lightbox and leaves the cursor where it is; anywhere else
            // it makes this the cursor's group. With Shift, Ctrl or Cmd it selects the group instead.
            <Box
              onClickCapture={(event) => {
                if (!onSelect || !(event.shiftKey || event.metaKey || event.ctrlKey)) return;
                event.preventDefault();
                event.stopPropagation();
                onSelect({ range: event.shiftKey });
              }}
              onClick={current ? undefined : (event) => {
                if (!(event.target as Element).closest('.mrx-tile')) onActivate();
              }}
              style={{ cursor: current ? undefined : 'pointer' }}
            >
              {!media.set ? <Box h={gridHeight} style={{ borderRadius: 'var(--mantine-radius-sm)', background: 'var(--mrx-surface-sunken)' }} /> : media.set.truncated
                ? (
                  // Too many to lay out at once: the expanded group pages through them.
                  <Group gap='xs' py='xs'>
                    <Text size='sm' c='dimmed'>Too many pictures to show at once.</Text>
                    <Button size='compact-sm' variant='light' onClick={onExpand}>Page through them</Button>
                  </Group>
                )
                : <MediaGrid items={media.set.items} targetRowHeight={metrics.row} tileKeys={false} originals={false} renderOverlay={renderOverlay} />}
            </Box>
          )}
          {phone && (
            <Group mt={8} gap='xs' wrap='nowrap'>
              <Button size='compact-sm' variant='light' onClick={actions.proposal?.run ?? actions.newAlbum} style={{ maxWidth: '100%' }}>
                <Text span inherit truncate>{actions.proposal?.label ?? 'Create album…'}</Text>
              </Button>
            </Group>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box ref={ref} data-group={row.name} data-open px='md' pb={SECTION_GAP}>
      <Box px='sm' pb='lg' style={frameStyle(true, false)}>
        <Box
          style={{
            position: 'sticky',
            top: scrollRoot ? 0 : 'calc(var(--app-shell-header-height) + var(--mrx-stuck-header-height, 0px))',
            zIndex: 3,
            background: 'var(--mrx-surface-raised)',
          }}
        >
          {header}
        </Box>
        {mediaError ? mediaError : !media.set ? <MediaGrid items={[]} loading /> : media.set.truncated
          ? (
            // Too many to lay out at once: the album's own timeline, which pages.
            <MediaTimeline album={row.path} granularity='day' ascending scrollRoot={scrollRoot} />
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
              renderOverlay={renderOverlay}
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
  { items, tileCursor, onTiles, selection, partCursor, onParts, partCut, partMatch, dragPayload, renderOverlay }: {
    items: MediaItem[];
    tileCursor: string | null;
    onTiles?: (items: MediaItem[], boxes: TileBox[]) => void;
    selection?: MediaSelection;
    partCursor: string | null;
    onParts?: (parts: PartSection<MediaItem>[], byMonth: boolean) => void;
    partCut?: { label: string; fromFirst: boolean; run: (part: PartSection<MediaItem>) => void };
    partMatch?: PartMatch;
    dragPayload?: (item: MediaItem) => MediaDragPayload | undefined;
    renderOverlay?: (item: MediaItem) => ReactNode;
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
              renderOverlay={renderOverlay}
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
