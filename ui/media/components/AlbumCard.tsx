import { Badge } from '@mantine/core';
import { useInViewport } from '@mantine/hooks';
import { type AlbumEntry, useAlbumCover } from '@ein/ui/hooks';
import { EntityCard, formatRange, TablerIcon } from '@ein/ui/components';
import { CardTextParts, plainMarkdown } from '@ein/ui/lib';
import { isSuggestedAlbum } from '../lib/album-origin.ts';

type AlbumCardProps = {
  album: AlbumEntry;
  onClick: () => void;
};

/**
 * An unrenamed suggested album is *named* after its dates — alone, or after the
 * location — so the range line would only repeat the title. It earns its location once
 * the album has a name.
 */
function datesRepeatTitle(album: AlbumEntry): boolean {
  return isSuggestedAlbum(album.origin) && album.title.endsWith(formatRange(album.timeStart, album.timeEnd));
}

/** What an album's card draws below its title, for `CardGrid`'s `textParts`. */
export function albumCardText(album: AlbumEntry): CardTextParts {
  return {
    date: !datesRepeatTitle(album) && Boolean(formatRange(album.timeStart, album.timeEnd)),
    // The description is the card's hover text: a few albums with one would otherwise make every card in
    // the grid two lines taller.
    description: false,
    badges: isSuggestedAlbum(album.origin) || (album.labels?.length ?? 0) > 0,
  };
}

/**
 * Album grid card, for albums someone made and for the ones EiN suggested.
 *
 * Everything but the cover and the item count comes from the listing `useAlbums`
 * already did; those two load lazily once scrolled into view.
 *
 * A suggested album says so — same grid, same card, but a different icon behind
 * a missing cover and a badge that names what it is, because "who made this"
 * changes what the album means and whether its grouping is worth trusting. A
 * trip says how many days it covers, which is the one number that tells a week
 * away from an afternoon.
 */
export function AlbumCard({ album, onClick }: AlbumCardProps) {
  const { ref, inViewport } = useInViewport();
  const { coverUrl, coverFallbackUrl, itemCount } = useAlbumCover(album, inViewport);

  const suggested = isSuggestedAlbum(album.origin);
  const trip = suggested && album.kind === 'trip';
  const locationName = album.locationPath?.split('/').pop();

  const hideDates = datesRepeatTitle(album);

  return (
    <EntityCard
      ref={ref}
      title={album.title}
      onClick={onClick}
      kind={suggested ? 'suggested' : 'album'}
      coverUrl={coverUrl}
      coverFallbackUrl={coverFallbackUrl}
      icon={trip
        ? <TablerIcon name='route' size={48} stroke={1} />
        : suggested
        ? <TablerIcon name='calendar-event' size={48} stroke={1} />
        : <TablerIcon name='photo' size={48} stroke={1} />}
      // The clusterer writes memberCount, but an album it has not revisited
      // since a member changed can be stale — so the loader's count wins once
      // it has one.
      count={itemCount ?? album.memberCount}
      timeStart={hideDates ? undefined : album.timeStart}
      timeEnd={hideDates ? undefined : album.timeEnd}
      labels={album.labels}
      hoverText={album.description ? `${album.title}\n\n${plainMarkdown(album.description)}` : album.title}
      badges={suggested
        ? (
          <>
            <Badge size='xs' variant='light' color='violet' leftSection={<TablerIcon name='sparkles' size={10} />}>
              Suggested
            </Badge>
            {trip && (
              <Badge size='xs' variant='light' color='blue' leftSection={<TablerIcon name='route' size={10} />}>
                Trip · {album.days} days
              </Badge>
            )}
            {locationName && (
              <Badge size='xs' variant='light' color='teal' leftSection={<TablerIcon name='map-pin' size={10} />}>
                {locationName}
              </Badge>
            )}
            {album.pinned && <Badge size='xs' variant='light' color='grape' leftSection={<TablerIcon name='pin' size={10} />}>Yours</Badge>}
            {album.provisional && !album.pinned && <Badge size='xs' variant='light' color='yellow' leftSection={<TablerIcon name='hourglass' size={10} />}>Indexing</Badge>}
          </>
        )
        : undefined}
    />
  );
}
