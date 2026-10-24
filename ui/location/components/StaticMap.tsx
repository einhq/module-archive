import { Box } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { BASE_LAYERS, MARKER_COLOR } from '@ein/ui/components';

const TILE_SIZE = 256;
/** Street level: a building's block and the streets around it, which is what tells two addresses apart. */
const DEFAULT_ZOOM = 15;
/** Leaflet's default for `{s}`. */
const SUBDOMAINS = 'abc';
/** The map page's default base layer. */
const LAYER = BASE_LAYERS[0];

type StaticMapProps = {
  lat: number;
  lng: number;
  zoom?: number;
};

/** Web Mercator, in pixels at `zoom` — the same projection the tiles are cut in. */
function worldPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{s}', SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length])
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * A still picture of the map around one point, for a card cover.
 *
 * The tiles Leaflet would fetch, laid out by hand, rather than a Leaflet map per
 * card: a grid of locations would otherwise start a hundred maps — each with its own
 * listeners, panes and resize observer — to show pictures nobody can pan. The
 * tiles are the same URLs, so a location opened from its card starts from a warm
 * cache.
 *
 * It fills its parent and draws nothing until that parent has a size, since
 * which tiles are needed depends on it.
 */
export function StaticMap({ lat, lng, zoom = DEFAULT_ZOOM }: StaticMapProps) {
  const { ref, width, height } = useElementSize();

  const tiles: { key: string; src: string; left: number; top: number }[] = [];
  if (width > 0 && height > 0) {
    const center = worldPixel(lat, lng, zoom);
    const left = center.x - width / 2;
    const top = center.y - height / 2;
    const count = 2 ** zoom;
    for (const [index, source] of LAYER.tiles.entries()) {
      for (let ty = Math.floor(top / TILE_SIZE); ty <= Math.floor((top + height) / TILE_SIZE); ty++) {
        if (ty < 0 || ty >= count) continue;
        for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((left + width) / TILE_SIZE); tx++) {
          const wrapped = ((tx % count) + count) % count;
          tiles.push({
            key: `${index}/${tx}/${ty}`,
            src: tileUrl(source.url, zoom, wrapped, ty),
            left: tx * TILE_SIZE - left,
            top: ty * TILE_SIZE - top,
          });
        }
      }
    }
  }

  const attribution = LAYER.tiles.find((tile) => tile.options.attribution)?.options.attribution;

  return (
    <Box ref={ref} pos='relative' w='100%' h='100%' style={{ overflow: 'hidden' }}>
      {tiles.map((tile) => (
        <img
          key={tile.key}
          src={tile.src}
          alt=''
          loading='lazy'
          draggable={false}
          width={TILE_SIZE}
          height={TILE_SIZE}
          style={{ position: 'absolute', left: tile.left, top: tile.top, maxWidth: 'none', pointerEvents: 'none' }}
        />
      ))}

      {width > 0 && (
        // The map page's pin, tip on the point.
        <svg
          width={24}
          height={34}
          viewBox='0 0 30 42'
          aria-hidden
          style={{ position: 'absolute', left: width / 2 - 12, top: height / 2 - 34, filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.4))' }}
        >
          <path d='M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z' fill={MARKER_COLOR} stroke='#fff' strokeWidth={1.5} />
          <circle cx={15} cy={15} r={6} fill='#fff' />
        </svg>
      )}

      {attribution && (
        // The tile providers' terms want their credit on the map itself.
        <Box
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            padding: '0 4px',
            fontSize: 9,
            lineHeight: '14px',
            color: 'white',
            background: 'var(--mrx-scrim)',
            borderTopLeftRadius: 4,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {attribution}
        </Box>
      )}
    </Box>
  );
}
