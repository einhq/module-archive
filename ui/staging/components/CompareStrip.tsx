import type { SearchResponse } from '@ein/api';
import { MediaGrid, TablerIcon } from '@ein/ui/components';
import { mediaItemFrom, shq } from '@ein/ui/lib';
import { execCommand, type MediaItem } from '@ein/ui/signals';
import { Alert, Box, Button, Group, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { albumRoute } from '../../media/lib/album-path.ts';
import { daysBetween, seekDay, stripDays } from '../lib/compare.ts';

type Props = {
  /** The candidate album whose own pictures are shown. */
  album: { path: string; title: string };
  /** When the group being decided was taken, which the strip opens on. */
  timeStart?: string;
  timeEnd?: string;
  /** Widened to compare (C): more pictures, in taller rows. */
  wide: boolean;
};

/** Pictures per page, narrow and widened, and their rows' height. */
const PAGE = 48;
const WIDE_PAGE = 120;
const ROW = 72;
const WIDE_ROW = 120;

/** Where a page is read from: the day before the group's, or after or before the page shown. */
type From = { at?: string } | { cursor: string } | { above: string };

/**
 * A candidate album's own pictures around the group's days, in the destination column: read with
 * `search --under <album> --sort time --at <the day before>`, a day each with its date, the days
 * the group was taken marked; Earlier and Later page through the album, and its pictures open in
 * the lightbox over the strip. Keyed by album and group, so another starts over at the group's days.
 */
export function CompareStrip({ album, timeStart, timeEnd, wide }: Props) {
  const navigate = useNavigate();
  const start = seekDay(timeStart);
  const [from, setFrom] = useState<From>(() => start ? { at: start } : {});
  const [page, setPage] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = wide ? WIDE_PAGE : PAGE;

  useEffect(() => {
    const controller = new AbortController();
    const position = 'cursor' in from ? ` --cursor ${shq(from.cursor)}` : 'above' in from ? ` --above ${shq(from.above)}` : from.at ? ` --at ${from.at}` : '';
    setError(null);
    execCommand<SearchResponse>(`search --under ${shq(album.path)} --sort time${position} -l ${limit}`, { signal: controller.signal })
      .then((answer) => !controller.signal.aborted && setPage(answer))
      .catch((value) => !controller.signal.aborted && setError(value instanceof Error ? value.message : String(value)));
    return () => controller.abort();
  }, [album.path, from, limit]);

  const items = useMemo<MediaItem[]>(() =>
    (page?.results ?? []).map((hit) =>
      mediaItemFrom({
        path: hit.path,
        ...(hit.memberPath ? { memberPath: hit.memberPath } : {}),
        name: hit.name,
        ...(hit.mimetype ? { mimetype: hit.mimetype } : {}),
        ...(hit.takenAt ? { takenAt: hit.takenAt } : {}),
        ...(hit.width ? { width: hit.width } : {}),
        ...(hit.height ? { height: hit.height } : {}),
        ...(hit.angle ? { angle: hit.angle } : {}),
        ...(hit.duration ? { duration: hit.duration } : {}),
        ...(hit.stackCount ? { stackCount: hit.stackCount } : {}),
        ownership: hit.ownership,
      })
    ), [page]);
  const ours = useMemo(() => daysBetween(timeStart, timeEnd), [timeStart, timeEnd]);
  const days = useMemo(() => stripDays(items, (item) => item.takenAt, ours), [items, ours]);
  const offsets = useMemo(() => days.map((_, i) => days.slice(0, i).reduce((sum, day) => sum + day.items.length, 0)), [days]);

  return (
    <Stack gap={4}>
      <Text size='xs' fw={600} truncate title={album.path}>{album.title}{start ? ' around these days' : ''}</Text>
      {error
        ? <Alert color='red' variant='light' py={4}>{error}</Alert>
        : !page
        ? <MediaGrid items={[]} loading targetRowHeight={wide ? WIDE_ROW : ROW} />
        : items.length === 0
        ? <Text size='xs' c='dimmed'>No pictures here.</Text>
        : (
          <Box style={{ maxHeight: wide ? '60vh' : 260, overflowY: 'auto' }}>
            {days.map((day, i) => (
              <Box key={`${day.day}:${offsets[i]}`} mb={4}>
                <Text size='xs' c={day.ours ? 'var(--mrx-accent)' : 'dimmed'} fw={day.ours ? 700 : 400}>
                  {day.label}
                  {day.ours ? ' · when the group was taken' : ''}
                </Text>
                <MediaGrid items={day.items} lightboxItems={items} indexOffset={offsets[i]} targetRowHeight={wide ? WIDE_ROW : ROW} tileKeys={false} />
              </Box>
            ))}
          </Box>
        )}
      <Group justify='space-between' gap={4} wrap='nowrap'>
        <Button
          size='compact-xs'
          variant='subtle'
          leftSection={<TablerIcon name='chevron-left' size={12} />}
          disabled={!page?.above}
          onClick={() => page?.above && setFrom({ above: page.above })}
        >
          Earlier
        </Button>
        <Button
          size='compact-xs'
          variant='subtle'
          rightSection={<TablerIcon name='chevron-right' size={12} />}
          disabled={!page?.cursor}
          onClick={() => page?.cursor && setFrom({ cursor: page.cursor })}
        >
          Later
        </Button>
        <Button size='compact-xs' variant='subtle' rightSection={<TablerIcon name='external-link' size={12} />} onClick={() => navigate(albumRoute(album.path))}>
          Open album
        </Button>
      </Group>
    </Stack>
  );
}
