import { Box, Group, HoverCard, Image, Text, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import { TablerIcon } from '@ein/ui/components';
import { useAlbumCover } from '@ein/ui/hooks';
import { albumRoute } from '../lib/album-path.ts';
import type { AlbumSeries, SeriesNeighbour } from '../hooks/useAlbumSeries.ts';
import './album-series.css';

/**
 * One neighbour: a narrow pill of arrow, small cover and name, with the arrow on the side it lies,
 * which says which one it is. Hovered, a card shows its whole name and a larger cover.
 */
function SeriesLink({ album, side }: { album: SeriesNeighbour; side: 'previous' | 'next' }) {
  // The path alone says nothing of where the album keeps its media; `useAlbumCover` looks in both places.
  const { coverUrl, coverFallbackUrl } = useAlbumCover({ path: album.path, hasFilesDir: true }, true);
  const label = side === 'previous' ? 'Previous album' : 'Next album';
  return (
    <HoverCard openDelay={250} closeDelay={100} position={side === 'previous' ? 'bottom-start' : 'bottom-end'} withArrow shadow='md' width={260}>
      <HoverCard.Target>
        <UnstyledButton component={Link} to={albumRoute(album.path)} className='mrx-album-series-link' data-side={side} aria-label={`${label}: ${album.title}`}>
          <TablerIcon name={side === 'previous' ? 'chevron-left' : 'chevron-right'} size={24} stroke={2.5} className='mrx-album-series-arrow' />
          <Box className='mrx-album-series-cover'>
            {coverUrl ? <Image src={coverUrl} fallbackSrc={coverFallbackUrl} alt='' w={24} h={24} fit='cover' /> : <TablerIcon name='photo' size={14} />}
          </Box>
          <Text className='mrx-album-series-text' size='sm' fw={500} c='white' truncate='end'>{album.title}</Text>
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown p='xs'>
        {coverUrl && <Image src={coverUrl} fallbackSrc={coverFallbackUrl} alt='' h={160} fit='cover' radius='sm' mb='xs' />}
        <Text size='xs' c='dimmed'>{label}</Text>
        <Text size='sm' fw={500}>{album.title}</Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** Links to the albums before and after this one in a series, for the album's header; nothing without either. */
export function AlbumSeriesLinks({ series }: { series: AlbumSeries }) {
  if (!series.previous && !series.next) return null;
  return (
    <Group gap='xs' wrap='wrap'>
      {series.previous && <SeriesLink album={series.previous} side='previous' />}
      {series.next && <SeriesLink album={series.next} side='next' />}
    </Group>
  );
}
