import { Box, Image, Stack, Text } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { useElementWidth } from '@ein/ui/hooks';
import { gridUrl, thumbnailUrl } from '@ein/ui/lib';
import { albumRoute } from '../media/lib/album-path.ts';

const TILE = 76;
const TILE_GAP = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the words a person would use.
 *
 * Exact dates past a month: "seven weeks ago" is a number nobody converts back,
 * while "12 Jul" is a date somebody recognises.
 */
const agoLabel = (at: number, now: number): string => {
  const ago = now - at;
  if (ago < HOUR) return 'just now';
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h ago`;

  const days = Math.floor(ago / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 31) return `${Math.round(days / 7)} weeks ago`;

  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * One `news-albums` entry, as the home page's News draws it: who added which album, when, and as
 * many of its pictures as fit the row, the last one carrying how many more there are. Everything
 * it shows is in its query (`path`, `name`, `at`, `who`, `count`, `preview`), so it runs nothing.
 */
export default function NewsAlbumEntry() {
  const [params] = useSearchParams();
  const path = params.get('path') ?? '';
  const name = params.get('name') || path.split('/').pop() || path;
  const at = Number(params.get('at'));
  const who = params.get('who');
  const preview = params.getAll('preview');
  const count = Number(params.get('count') ?? preview.length);

  const [previewRef, width] = useElementWidth<HTMLDivElement>();
  const visibleCount = Math.min(preview.length, Math.max(1, Math.floor((width + TILE_GAP) / (TILE + TILE_GAP))));
  const hidden = Math.max(count, preview.length) - visibleCount;

  return (
    <Stack gap={8} style={{ minWidth: 0 }}>
      <Stack gap={2}>
        <Text size='sm' lineClamp={2} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <Text span size='sm' c='dimmed'>
            {who ? <Text span fw={600} c='var(--mrx-text-primary)'>{who}</Text> : 'Somebody'} added
          </Text>{' '}
          <Text component={Link} to={albumRoute(path)} span fw={600} size='sm' style={{ textDecoration: 'none' }}>
            {name}
          </Text>
        </Text>
        {Number.isFinite(at) && at > 0 && <Text component='time' dateTime={new Date(at).toISOString()} size='xs' c='dimmed'>{agoLabel(at, Date.now())}</Text>}
      </Stack>

      {preview.length > 0 && (
        <Box
          ref={previewRef}
          style={{ display: 'grid', gridTemplateColumns: `repeat(${visibleCount}, minmax(0, 96px))`, gap: TILE_GAP, minWidth: 0 }}
        >
          {preview.slice(0, visibleCount).map((media, index) => (
            <Box
              key={media}
              component={Link}
              to={albumRoute(path)}
              aria-label={`Open ${name}${index === visibleCount - 1 && hidden > 0 ? `, ${hidden} more items` : ''}`}
              style={{ minWidth: 0, position: 'relative', aspectRatio: '1', overflow: 'hidden', borderRadius: 'var(--mantine-radius-sm)' }}
            >
              <Image
                src={gridUrl(media, true)}
                // A file without the 512 rendition still has the square 320.
                fallbackSrc={thumbnailUrl(media, true)}
                alt=''
                w='100%'
                h='100%'
                radius='sm'
                fit='cover'
              />
              {index === visibleCount - 1 && hidden > 0 && (
                <Text
                  component='span'
                  size='sm'
                  fw={600}
                  c='white'
                  style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0, 0, 0, 0.55)' }}
                >
                  +{hidden.toLocaleString()}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Stack>
  );
}
