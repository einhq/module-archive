import { TablerIcon } from '@ein/ui/components';
import { ALBUMS_ROOT, LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { Anchor, Avatar, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { TimelineEntry, TimelineKind } from '../lib/timeline-entries.ts';
import { fileUrl, THUMB_NAME } from '@ein/ui/lib';
import { UserText } from './UserText.tsx';

/**
 * Icon and accent colour per kind, so a kind is recognisable before it is read.
 *
 * The icon is a Tabler name, not an element, so each place that draws it picks
 * its size.
 */
export const KIND_STYLE: Record<TimelineKind, { icon: string; color: string; label: string }> = {
  'album': { icon: 'photo', color: 'marine', label: 'Album' },
  'auto-album': { icon: 'sparkles', color: 'grape', label: 'Auto album' },
  'anniversary': { icon: 'heart', color: 'pink', label: 'Anniversary' },
  'birth': { icon: 'cake', color: 'teal', label: 'Born' },
  'death': { icon: 'grave', color: 'gray', label: 'Died' },
  'birthday': { icon: 'cake', color: 'yellow', label: 'Birthday' },
  'event': { icon: 'calendar-event', color: 'blue', label: 'Event' },
  'move': { icon: 'home', color: 'cyan', label: 'Move' },
  'track': { icon: 'route', color: 'orange', label: 'Track' },
};

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `1998-06-12T14:03` -> "12 Jun", `1998-06` -> "Jun", `1998` -> "" (the header has the year). */
const dayLabel = (date: string): string => {
  const [, month, day] = date.slice(0, 10).split('-');
  if (!month) return '';
  const name = MONTHS_SHORT[Number(month) - 1] ?? month;
  return day ? `${Number(day)} ${name}` : name;
};

/**
 * "12–14 Jun" when a span crosses days, otherwise just the day it happened.
 *
 * The year is left out when it is on the month header this entry sits under,
 * where repeating it down a whole column of dates is noise — which holds until
 * the span crosses into another year.
 */
export const spanLabel = (entry: TimelineEntry): string => {
  const start = entry.exactDate ?? entry.date;
  if (!entry.endDate) return dayLabel(start);

  // Across a year boundary the header names only one of the two years, so both
  // ends carry their own; a year-only end is just the year.
  const crossesYear = entry.endDate.slice(0, 4) !== start.slice(0, 4);
  const end = (date: string) => {
    const day = dayLabel(date);
    if (!crossesYear) return day;
    return day ? `${day} ${date.slice(0, 4)}` : date.slice(0, 4);
  };

  const from = end(start);
  const to = end(entry.endDate);
  return to && to !== from ? `${from} – ${to}` : from;
};

/**
 * How big the picture is.
 *
 * A person is a face, which reads perfectly well small and round; an album's
 * cover *is* its content and earns the space. Birthdays are also by far the most
 * numerous entry — a few hundred people against a handful of albums a year — so
 * at album size they turn the feed into a column of portraits. A move carries
 * the mover's face for the same reason, even though it points at a location.
 */
const isPersonKind = (kind: TimelineKind): boolean => kind === 'birth' || kind === 'death' || kind === 'birthday' || kind === 'anniversary' || kind === 'move';

const coverSize = (kind: TimelineKind): { size: number; radius: string } => isPersonKind(kind) ? { size: 32, radius: 'xl' } : { size: 56, radius: 'sm' };

/** Where clicking the entry goes. */
export const entryRoute = (entry: TimelineEntry): string => {
  switch (entry.kind) {
    // Both open on the albums page; the suggested one shows its clustering
    // scores there rather than on a page of its own.
    case 'album':
    case 'auto-album':
      return `/albums/${encodeURIComponent(entry.path)}`;
    // A track is the route of the device it is named after, shown on that device's page.
    case 'track':
      return `/devices/${encodeURIComponent(entry.path.split('/').pop() ?? entry.path)}?tab=track`;
    // An anniversary is about a couple, which has no page; `path` is already
    // the half of it the entry was read from.
    case 'birth':
    case 'death':
    case 'birthday':
    case 'anniversary':
      return `/people/${encodeURIComponent(entry.path.split('/').pop() ?? entry.path)}`;
    // A move is about where somebody went, and `path` is already the location —
    // except on a location's own feed, where it is the person who came or left.
    case 'move': {
      const slug = entry.path.split('/').pop() ?? entry.path;
      return entry.path.startsWith(`${PEOPLE_ROOT}/`) ? `/people/${encodeURIComponent(slug)}` : `/locations/${encodeURIComponent(slug)}`;
    }
    case 'event': {
      // An event hangs off a person, an album or a location; its owner decides.
      const owner = entry.ownerPath ?? entry.path;
      const slug = owner.split('/').pop() ?? owner;
      if (owner.startsWith(`${ALBUMS_ROOT}/`)) return `/albums/${encodeURIComponent(owner)}`;
      if (owner.startsWith(`${LOCATIONS_ROOT}/`)) return `/locations/${encodeURIComponent(slug)}`;
      return `/people/${encodeURIComponent(slug)}`;
    }
  }
};

/**
 * The cover the command already found for us.
 *
 * The path *and* whether derivatives exist come back with the entry, so a card
 * costs no extra command.
 */
const coverUrls = (entry: TimelineEntry): { url: string; fallback?: string } | undefined => {
  if (!entry.cover) return undefined;
  const base = fileUrl(entry.cover.path);
  // `thumbnails/` existing says the crawl reached the file, not which renditions
  // it produced: a missing 320 is a 404, so the original stands behind it.
  return entry.cover.thumb ? { url: `${base}/thumbnails/${THUMB_NAME}`, fallback: base } : { url: base };
};

type TimelineEntryCardProps = { entry: TimelineEntry };

/**
 * One happening, as it appears inside a Mantine `Timeline.Item`.
 *
 * Deliberately small: the timeline's job is to say *when*, and a card that grows
 * into a preview of the album turns scanning a decade into scrolling one.
 */
export function TimelineEntryCard({ entry }: TimelineEntryCardProps) {
  const cover = coverUrls(entry);
  const { size, radius } = coverSize(entry.kind);
  const [src, setSrc] = useState(cover?.url);
  // What the missing picture *would* have been, not the kind — the bullet right
  // beside it already says the kind, and two cakes in a row say it twice.
  const placeholder = isPersonKind(entry.kind) ? 'user' : 'photo';

  return (
    <Group wrap='nowrap' align='flex-start' gap='sm' className='mrx-timeline-item'>
      {
        /* The slot is always drawn, picture or not, so every row's title lines
          up with the others — the alignment a scannable list depends on.
          Mantine's Avatar falls back to its children when `src` is null. */
      }
      <Avatar
        src={src ?? null}
        size={size}
        radius={radius}
        // Neutral rather than the kind's accent: a placeholder should read as a
        // gap, and stay quieter than the rows that do have a picture.
        color='gray'
        variant='light'
        imageProps={{
          loading: 'lazy',
          // `thumbnails/` existing does not promise this rendition; drop to the
          // original once, then to the placeholder.
          onError: () => setSrc(cover?.fallback && src !== cover.fallback ? cover.fallback : undefined),
        }}
        style={{ flexShrink: 0 }}
      >
        <TablerIcon name={placeholder} size={Math.round(size * 0.5)} />
      </Avatar>

      <Stack gap={2} style={{ minWidth: 0 }}>
        <Anchor component={Link} to={entryRoute(entry)} c='var(--mantine-color-text)' fw={500} lineClamp={2}>
          {entry.title}
        </Anchor>

        {
          /* No eventType badge: the only types that reach here are marriage and
            engagement, and the composed title already says both. */
        }
        <Group gap='xs' wrap='wrap'>
          {entry.count !== undefined && <Text size='xs' c='dimmed'>{entry.count} items</Text>}
          {entry.points !== undefined && <Text size='xs' c='dimmed'>{entry.points} points</Text>}
        </Group>

        {entry.description && (
          <Text component='div' size='xs' c='dimmed' lineClamp={3}>
            <UserText text={entry.description} />
          </Text>
        )}
      </Stack>
    </Group>
  );
}
