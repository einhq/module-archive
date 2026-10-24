import { ActionIcon, Alert, Box, Button, Group, Paper, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useDisclosure, useListState } from '@mantine/hooks';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { execCommand, MediaItem } from '@ein/ui/signals';
import { MediaSelection, useAccessIds } from '@ein/ui/hooks';
import { canWriteEach, countOf, shq, thumbnailUrl } from '@ein/ui/lib';
import { DEFAULT_GAP_MS, formatNaive, formatPicker, parseNaive, retime, type RetimeEntry, sortByName, sortByTime } from '../lib/retime.ts';
import { Dialog, DialogActions, SelectionActionButton, TablerIcon } from '@ein/ui/components';
import { formatTaken, isVague } from '../lib/capture-time.ts';
import { forgetSubjectFacets } from '../../hooks/useSubjectFacets.ts';

/**
 * One row of the batch, as the arithmetic sees it.
 *
 * `vague` is what keeps a file known only to a year (or a month) out of the rebasing: see
 * `RetimeEntry` in `../lib/retime.ts` for why that is the honest answer rather than a special case.
 */
const entryFor = (path: string, takenAt?: string): RetimeEntry => ({
  path,
  original: parseNaive(takenAt),
  ...(isVague(takenAt) ? { vague: true } : {}),
});

/** Pairs per `file-set-time`, which writes them together; more than one call keeps a failure local. */
const APPLY_CHUNK = 200;

/** How a time reads in the fields — the same spelling as the "current time" beside it. */
const PICKER_FORMAT = 'YYYY-MM-DD HH:mm:ss';

type SortMode = 'time' | 'name' | 'manual';

type Props = {
  /** What is selected of `items`; without one, every item is in the batch. */
  selection?: MediaSelection;
  /** Everything loaded, in list order. The selection is read out of this. */
  items: MediaItem[];
  /** Called once the batch is written, so the list can re-sort itself. */
  onApplied: () => void;
  /** Opened by the page (a key), not by a button of its own: none is drawn, and `onClose` closes it. */
  opened?: boolean;
  onClose?: () => void;
};

/**
 * Bulk capture-time correction for the current selection.
 *
 * Self-contained: the button and its dialog together, so a page adds it to `MediaSelectionBar`'s
 * `actions` slot in one line and the bar never learns what it does.
 *
 * The interesting part is that times are *derived*, not typed in one by one. `../lib/retime.ts`
 * takes the order, a start time and any hand-pinned rows and produces the whole column — see
 * there for why the rules are what they are. This component only holds that state and renders
 * the preview, which means every control (re-sort, drag, edit a row, move the start) is the same
 * one-line state change followed by the same recomputation.
 *
 * Offered only when the reader may change every selected file. A page that opens it itself
 * passes `opened` and `onClose`, and the batch is what is selected then, or every item.
 */
export function SetTimeAction({ selection, items, onApplied, opened: openedByPage, onClose }: Props) {
  const access = useAccessIds();
  const inBatch = useCallback((item: MediaItem) => selection ? selection.selected.has(item.path) : true, [selection]);
  const changeable = canWriteEach(items.filter(inBatch), access);
  const [openedHere, modal] = useDisclosure(false);
  const controlled = openedByPage !== undefined;
  const opened = controlled ? openedByPage : openedHere;
  const close = controlled ? () => onClose?.() : modal.close;
  const [rows, setRows] = useState<MediaItem[]>([]);
  const [order, orderHandlers] = useListState<string>([]);
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [start, setStart] = useState(() => Date.now());
  const [anchors, setAnchors] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byPath = useMemo(() => new Map(rows.map((row) => [row.path, row])), [rows]);

  const entries = useMemo(
    () => new Map<string, RetimeEntry>(rows.map((row) => [row.path, entryFor(row.path, row.takenAt)])),
    [rows],
  );

  const times = useMemo(
    () => retime({ order, entries, start, anchors, gapMs: DEFAULT_GAP_MS }),
    [order, entries, start, anchors],
  );

  /**
   * Snapshot the selection on open. The dialog is about a fixed set of files, and the grid
   * underneath stays live — paging in another screenful must not grow the list being edited.
   */
  const snapshot = useCallback(() => {
    const selected = items.filter(inBatch);
    const snapshot = new Map<string, RetimeEntry>(
      selected.map((item) => [item.path, entryFor(item.path, item.takenAt)]),
    );
    const initial = sortByTime(selected.map((item) => item.path), snapshot);
    const earliest = [...snapshot.values()]
      .map((entry) => entry.original)
      .filter((value): value is number => value !== undefined);

    setRows(selected);
    orderHandlers.setState(initial);
    setSortMode('time');
    // The earliest picture in the batch: usually the one being corrected, so the field opens
    // showing what is there now rather than today's date.
    setStart(earliest.length > 0 ? Math.min(...earliest) : Date.now());
    setAnchors(new Map());
    setError(null);
  }, [items, inBatch, orderHandlers]);
  const open = () => {
    snapshot();
    modal.open();
  };
  // Opened by the page: the batch is taken as it opens.
  useEffect(() => {
    if (openedByPage) snapshot();
  }, [openedByPage]);

  const resort = useCallback((mode: SortMode) => {
    setSortMode(mode);
    if (mode === 'time') orderHandlers.setState((current) => sortByTime(current, entries));
    if (mode === 'name') {
      orderHandlers.setState((current) => sortByName(current, new Map(rows.map((row) => [row.path, row.name]))));
    }
  }, [entries, rows, orderHandlers]);

  const pin = useCallback((path: string, value: number | null) => {
    setAnchors((current) => {
      const next = new Map(current);
      if (value === null) next.delete(path);
      else next.set(path, value);
      return next;
    });
  }, []);

  const apply = async () => {
    setError(null);
    setBusy(true);
    try {
      // Only the rows `retime` produced a time for. A row known only to a year is absent from
      // that map on purpose — writing it would replace "some time in 1975" with a specific
      // minute of a specific afternoon, which nobody ever knew.
      const pairs = order
        .filter((path) => times.has(path))
        .map((path) => `${shq(path)} ${shq(formatNaive(times.get(path)!))}`);
      if (pairs.length === 0) {
        close();
        return;
      }
      for (let i = 0; i < pairs.length; i += APPLY_CHUNK) {
        await execCommand(`file-set-time ${pairs.slice(i, i + APPLY_CHUNK).join(' ')}`);
      }
      // The albums holding these files re-span themselves from the `file.updated` event the
      // retime raises. Nothing here needs to know which albums those are, nor which subjects'
      // year counts moved.
      forgetSubjectFacets();
      close();
      selection?.clear();
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {changeable && !controlled && (
        <SelectionActionButton icon={<TablerIcon name='clock-edit' size={14} />} onClick={open}>
          Set time
        </SelectionActionButton>
      )}

      <Dialog
        opened={opened}
        onClose={close}
        title='Set time'
        subtitle={countOf(rows.length, 'file', 'files')}
        icon='clock-edit'
        pattern='media'
        size='xl'
        // Not `pop`: it leaves `transform: scale(1)` on the modal, and a transformed ancestor
        // becomes the containing block for `position: fixed` — which is how the library renders
        // the row you are dragging, so it would follow the cursor at an offset. `fade` animates
        // opacity only.
        transitionProps={{ transition: 'fade' }}
      >
        <Stack gap='sm'>
          <Group justify='space-between' align='flex-end' wrap='wrap'>
            <Box>
              <Text size='xs' c='dimmed' mb={4}>Order</Text>
              <SegmentedControl
                size='xs'
                value={sortMode}
                onChange={(value) => resort(value as SortMode)}
                data={[
                  { value: 'time', label: 'Current time' },
                  { value: 'name', label: 'Name' },
                  { value: 'manual', label: 'Manual' },
                ]}
              />
            </Box>
            <DateTimePicker
              size='xs'
              withSeconds
              // Mantine's default is DD/MM/YYYY, which would sit next to a `2011-03-26` in the
              // very same row and read as a different date entirely.
              valueFormat={PICKER_FORMAT}
              label='Start time'
              value={formatPicker(start)}
              onChange={(value) => {
                const parsed = parseNaive(value ?? undefined);
                if (parsed !== undefined) setStart(parsed);
              }}
            />
          </Group>

          <Text size='xs' c='dimmed'>
            Times keep their spacing where the files have one, and spread a minute apart where they do not. Edit a row to pin it — the rows after it follow.
          </Text>

          <DragDropContext
            onDragEnd={({ source, destination }) => {
              if (!destination || destination.index === source.index) return;
              orderHandlers.reorder({ from: source.index, to: destination.index });
              setSortMode('manual');
            }}
          >
            <Droppable droppableId='set-time-rows' direction='vertical'>
              {(dropProvided) => (
                <Stack gap={4} ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                  {order.map((path, index) => {
                    const row = byPath.get(path);
                    if (!row) return null;
                    const pinned = anchors.has(path);

                    return (
                      <Draggable key={path} draggableId={path} index={index}>
                        {(dragProvided, snapshot) => (
                          <Paper
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            p='xs'
                            radius='sm'
                            bg={snapshot.isDragging ? 'var(--mrx-surface-overlay)' : 'var(--mrx-surface-sunken)'}
                            shadow={snapshot.isDragging ? 'md' : undefined}
                          >
                            <Group gap='sm' wrap='nowrap'>
                              <Box
                                {...dragProvided.dragHandleProps}
                                c='dimmed'
                                style={{ display: 'flex', cursor: 'grab' }}
                                aria-label={`Reorder ${row.name}`}
                              >
                                <TablerIcon name='grip-vertical' size={16} />
                              </Box>

                              <img
                                src={thumbnailUrl(row.path, row.hasDerivatives)}
                                alt=''
                                width={56}
                                height={56}
                                style={{ objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                              />

                              <Box style={{ flex: 1, minWidth: 0 }}>
                                <Text size='sm' truncate>{row.name}</Text>
                                {row.takenAt ? <Text size='xs' c='dimmed'>{formatTaken(row.takenAt)}</Text> : <Text size='xs' c='dimmed' fs='italic'>No date</Text>}
                              </Box>

                              <TablerIcon name='arrow-right' size={14} style={{ flexShrink: 0, opacity: 0.5 }} />

                              {times.has(path)
                                ? (
                                  <DateTimePicker
                                    size='xs'
                                    withSeconds
                                    valueFormat={PICKER_FORMAT}
                                    w={200}
                                    value={formatPicker(times.get(path)!)}
                                    onChange={(value) => {
                                      const parsed = parseNaive(value ?? undefined);
                                      if (parsed !== undefined) pin(path, parsed);
                                    }}
                                  />
                                )
                                : (
                                  // Vaguer than a day and not pinned: shown as what it is, with
                                  // one click to take it on if that is really what is wanted.
                                  <Tooltip label='Keeping this date as it is. Give it a time to replace it.' withArrow>
                                    <Button
                                      size='xs'
                                      variant='subtle'
                                      color='gray'
                                      w={200}
                                      onClick={() => pin(path, entries.get(path)?.original ?? start)}
                                    >
                                      {formatTaken(row.takenAt)} — unchanged
                                    </Button>
                                  </Tooltip>
                                )}

                              <Tooltip label='Unpin — follow the row above again' disabled={!pinned}>
                                <ActionIcon
                                  variant='subtle'
                                  color='gray'
                                  size='sm'
                                  onClick={() => pin(path, null)}
                                  disabled={!pinned}
                                  aria-label={`Unpin ${row.name}`}
                                >
                                  <TablerIcon name='rotate' size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </Group>
                          </Paper>
                        )}
                      </Draggable>
                    );
                  })}
                  {dropProvided.placeholder}
                </Stack>
              )}
            </Droppable>
          </DragDropContext>

          {error && <Alert color='red' variant='light' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
        </Stack>
        <DialogActions>
          <Button variant='default' onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={apply} loading={busy} disabled={order.length === 0}>
            Set time on {countOf(order.length, 'file', 'files')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
