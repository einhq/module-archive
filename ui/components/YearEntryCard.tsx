import { Badge } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import type { AlbumEntry } from '@ein/ui/hooks';
import type { TimelineEntry } from '@archive/timeline/api';
import { CardTextParts, formatRange, plainMarkdown } from '@ein/ui/lib';
import { AlbumCard, albumCardText } from '../media/components/AlbumCard.tsx';
import { entryRoute, KIND_STYLE } from './TimelineEntryCard.tsx';
import { BrowseEntityCard } from '@ein/ui/components';

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * The listing-shaped album a timeline entry describes.
 *
 * `hasFilesDir` is unknown here; the cover loader probes the other layout when
 * the first comes up empty, as it does for a search hit.
 */
const albumOf = (entry: TimelineEntry): AlbumEntry => ({
  name: basename(entry.path),
  title: entry.title,
  path: entry.path,
  hasFilesDir: false,
  origin: entry.kind === 'auto-album' ? 'auto' : undefined,
  timeStart: entry.exactDate ?? entry.date,
  timeEnd: entry.endDate,
  memberCount: entry.count,
});

type YearEntryCardProps = {
  entry: TimelineEntry;
  /** The person's own name for a birth or death; the entry's title is a sentence about them. */
  personName?: string;
};

const isAlbum = (entry: TimelineEntry): boolean => entry.kind === 'album' || entry.kind === 'auto-album';

/** What an entry's card draws below its title, for `CardGrid`'s `textParts`. */
export function yearEntryCardText(entry: TimelineEntry): CardTextParts {
  if (isAlbum(entry)) return albumCardText(albumOf(entry));
  return { date: Boolean(formatRange(entry.exactDate ?? entry.date)), description: Boolean(entry.description), badges: true };
}

/**
 * One thing from a year, as the card the rest of the app draws for it: an album
 * as the albums page shows it, a birth or a death as the person's card with a
 * badge saying which.
 */
export function YearEntryCard({ entry, personName }: YearEntryCardProps) {
  const navigate = useNavigate();
  const open = () => navigate(entryRoute(entry));

  if (isAlbum(entry)) {
    return <AlbumCard album={albumOf(entry)} onClick={open} />;
  }

  const { label, color } = KIND_STYLE[entry.kind];
  const aged = entry.kind === 'death' && entry.age !== undefined ? `, aged ${entry.age}` : '';

  return (
    <BrowseEntityCard
      title={personName ?? entry.title}
      coverPath={entry.path}
      kind='person'
      timeStart={entry.exactDate ?? entry.date}
      description={entry.description && plainMarkdown(entry.description)}
      hoverText={entry.path}
      onClick={open}
      badges={<Badge size='xs' variant='light' color={color}>{label}{aged}</Badge>}
    />
  );
}
