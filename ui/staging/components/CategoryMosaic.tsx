import type { SearchResponse } from '@ein/api';
import { TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { fileUrl, gridUrl, shq, thumbnailUrl } from '@ein/ui/lib';
import { Box, Center, Skeleton } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

/** The mosaic's shape, the same as a card's cover elsewhere. */
const ASPECT = 3 / 2;

/** How many tiles a mosaic of `found` media draws: a full square of them, or none. */
const tilesFor = (found: number): number => found >= 9 ? 9 : found >= 4 ? 4 : found >= 1 ? 1 : 0;

/** The originals a browser draws itself, shown while a picture's renditions are still being made. */
const DRAWABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/** The glyph of a tile with nothing to show, by what it is. */
const KIND_ICONS: Record<string, string> = { video: 'movie', audio: 'music' };

type Hit = SearchResponse['results'][number];

/**
 * One tile, the square thumbnail; a lone tile fills the whole mosaic, so it asks for the larger
 * grid rendition first. A picture still being prepared has none yet and shows its original; what
 * has nothing to show is a glyph of its kind.
 */
function Tile({ hit, single }: { hit: Hit; single: boolean }) {
  const sources = [
    ...(single ? [gridUrl(hit.path, true)] : []),
    thumbnailUrl(hit.path, true),
    ...(hit.mimetype && DRAWABLE.has(hit.mimetype) ? [fileUrl(hit.path)] : []),
  ];
  const [tried, setTried] = useState(0);
  if (tried >= sources.length) {
    return (
      <Center style={{ color: 'var(--mantine-color-dimmed)', minWidth: 0, minHeight: 0 }}>
        <TablerIcon name={KIND_ICONS[hit.kind ?? ''] ?? 'photo'} size={single ? 48 : 24} stroke={1} />
      </Center>
    );
  }
  return (
    <img
      src={sources[tried]}
      alt=''
      loading='lazy'
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', minWidth: 0, minHeight: 0 }}
      onError={() => setTried((count) => count + 1)}
    />
  );
}

type Props = {
  /** The category's directory. */
  path: string;
  /** How many files it holds: the mosaic is read again when that changes. */
  held: number;
};

/**
 * A category's newest pictures, videos and recordings (`search --within`, newest first, the
 * undated after): nine tiles when it holds nine or more, four when four, one when one, and a
 * glyph when it holds none. The exact copies that are not indexed are left out, as on its Files tab.
 */
export function CategoryMosaic({ path, held }: Props) {
  const { data, refetch } = useCommand<SearchResponse>(`search --within ${shq(path)} --missing duplicate.deferred -l 9`);
  const readAt = useRef(held);
  useEffect(() => {
    if (readAt.current === held) return;
    readAt.current = held;
    refetch();
  }, [held, refetch]);

  const box = { aspectRatio: String(ASPECT), background: 'var(--mrx-surface-raised)' };
  if (!data) return <Skeleton radius={0} style={{ aspectRatio: String(ASPECT) }} />;
  const tiles = data.results.slice(0, tilesFor(data.results.length));
  if (tiles.length === 0) {
    return (
      <Center style={{ ...box, color: 'var(--mantine-color-dimmed)' }} role='img' aria-label='No pictures, videos or recordings'>
        <TablerIcon name='photo-off' size={48} stroke={1} />
      </Center>
    );
  }
  const side = Math.sqrt(tiles.length);
  return (
    <Box
      aria-hidden
      style={{
        ...box,
        display: 'grid',
        gridTemplateColumns: `repeat(${side}, 1fr)`,
        gridTemplateRows: `repeat(${side}, 1fr)`,
        gap: 2,
        overflow: 'hidden',
      }}
    >
      {tiles.map((hit) => <Tile key={hit.path} hit={hit} single={tiles.length === 1} />)}
    </Box>
  );
}
