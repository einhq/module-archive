/**
 * The map page's year slider, in its floating search, its type menu and its
 * base-layer picker, in its top-right corner; and the z-index for anything a
 * page floats over a map.
 */

import { BASE_LAYERS, DEFAULT_CENTER, DEFAULT_ZOOM, TablerIcon } from '@ein/ui/components';
import { ActionIcon, Group, Menu, Popover, RangeSlider, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { type ReactNode, useMemo, useState } from 'react';
import { positionAtOrAfter, positionAtOrBefore, yearAt, yearScale } from '../lib/year-scale.ts';

/**
 * Just above the map, and deliberately nowhere near Leaflet's own 1000.
 *
 * Anything a page floats over a map sits *outside* `.leaflet-container`, so it
 * is not covered by the isolation that keeps Leaflet's stacking to itself — a
 * big number would escape upwards instead and paint over the lightbox. Since the
 * whole map is one flat layer in the page, beating it takes 1, and anything
 * overlaying the page still wins.
 */
export const MAP_CONTROL_Z = 1;

type MapYearsProps = {
  /** Full extent of the archive — the slider's ends. */
  bounds: [number, number];
  /** The years that hold pictures: each gets one step of the track, the empty ones none. */
  years: readonly number[];
  /** Current selection; at the ends it means "no constraint". */
  value: [number, number];
  onChange: (value: [number, number]) => void;
  onChangeEnd: (value: [number, number]) => void;
};

/**
 * Year range, the lower line of the map's floating search under the box: both
 * narrow what is drawn. The first year stands before the slider and the last
 * after it, white while they narrow the map.
 *
 * Both handles at the ends is not a filter but the absence of one — that is what
 * lets a bookmarked `/map` stay free of year parameters. The caller commits on
 * `onChangeEnd`; committing per tick would re-query the viewport per pixel.
 *
 * The track steps through the years that hold pictures (`year-scale.ts`), so the
 * decades most of them are from get the room rather than the empty centuries
 * before them.
 */
export function MapYears({ bounds, years, value, onChange, onChangeEnd }: MapYearsProps) {
  const constrained = value[0] > bounds[0] || value[1] < bounds[1];
  const scale = useMemo(() => yearScale(years.filter((year) => year >= bounds[0] && year <= bounds[1]), ...bounds), [years, bounds]);
  const toYears = ([from, to]: [number, number]): [number, number] => [yearAt(scale, from), yearAt(scale, to)];
  const year = (text: number) => (
    <Text size='md' fw={700} c={constrained ? 'white' : 'gray.3'} style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
      {text}
    </Text>
  );

  return (
    <Group className='mrx-map-years' gap='sm' wrap='nowrap'>
      {year(value[0])}
      <RangeSlider
        min={0}
        max={Math.max(0, scale.length - 1)}
        value={[positionAtOrAfter(scale, value[0]), positionAtOrBefore(scale, value[1])]}
        minRange={0}
        onChange={(positions) => onChange(toYears(positions))}
        onChangeEnd={(positions) => onChangeEnd(toYears(positions))}
        label={null}
        size='sm'
        aria-label='Years'
        style={{ flex: 1, minWidth: 0 }}
        styles={{ track: { '--slider-bg': 'rgba(255, 255, 255, .22)' } }}
      />
      {year(value[1])}
    </Group>
  );
}

type MapBaseLayerPickerProps = {
  /** The base layer showing, by its `BASE_LAYERS` name. */
  value: string;
  onChange: (name: string) => void;
  /** Where the map is looking, so each preview shows this location in that style. */
  center?: { lat: number; lng: number };
  zoom?: number;
};

/** The slippy-map tile holding a point, at a zoom. */
function tileAt(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** A layer's tile URL filled in; `{s}` takes Leaflet's first subdomain. */
function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{s}', 'a').replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{r}', '');
}

/**
 * The map's base layer, in its top-right corner: an icon button whose menu shows each
 * layer as a picture of where the map is looking rather than by name — one tile
 * of it, a step further out than the map so it holds more than a street. A layer
 * of several tile sets (a base and its labels) stacks them as the map does. The
 * pictures stand in a column down the map's edge, each named to its left.
 */
export function MapBaseLayerPicker({ value, onChange, center, zoom }: MapBaseLayerPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = BASE_LAYERS.find((def) => def.name === value) ?? BASE_LAYERS[0];
  const at = center ?? DEFAULT_CENTER;
  const z = Math.min(Math.max(Math.round((zoom ?? DEFAULT_ZOOM) - 1), 2), 16);
  const { x, y } = tileAt(at.lat, at.lng, z);

  return (
    <Popover opened={open} onChange={setOpen} position='left-start' shadow='md' withinPortal>
      <Popover.Target>
        <Tooltip label='Map style' position='left' disabled={open}>
          <ActionIcon className='mrx-map-button' aria-label={`Map style: ${selected.name}`} onClick={() => setOpen((was) => !was)}>
            <TablerIcon name='stack-2' size={22} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p='xs'>
        <Stack gap='xs'>
          {BASE_LAYERS.map((def) => {
            const chosen = def.name === selected.name;
            return (
              <Tooltip key={def.name} label={def.name} position='left'>
                <UnstyledButton
                  className='mrx-map-style'
                  data-selected={chosen || undefined}
                  aria-label={def.name}
                  aria-pressed={chosen}
                  onClick={() => {
                    onChange(def.name);
                    setOpen(false);
                  }}
                >
                  {def.tiles.map((tile) => <img key={tile.url} src={tileUrl(tile.url, z, x, y)} alt='' loading='lazy' />)}
                </UnstyledButton>
              </Tooltip>
            );
          })}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

type MapTypeOption = { value: string; label: string; icon: ReactNode };

/**
 * What the map draws, as a button in its top-right corner above the style
 * picker: the chosen type's icon, filled while it is not the first (All), and
 * the choices in a menu.
 */
export function MapTypeMenu({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: readonly MapTypeOption[] }) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  const narrowed = selected !== options[0];

  return (
    <Menu position='left-start' shadow='md' withinPortal>
      <Menu.Target>
        <Tooltip label={`Show: ${selected.label}`} position='left'>
          <ActionIcon className='mrx-map-button' data-active={narrowed || undefined} aria-label={`Show: ${selected.label}`}>
            {narrowed ? selected.icon : <TablerIcon name='filter' size={22} />}
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Show</Menu.Label>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            leftSection={option.icon}
            rightSection={option.value === selected.value && <TablerIcon name='check' size={16} />}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
