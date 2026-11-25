/** The map page's year slider, in its floating search. */

import { Group, RangeSlider, Text } from '@mantine/core';
import { useMemo } from 'react';
import { positionAtOrAfter, positionAtOrBefore, yearAt, yearScale } from '../lib/year-scale.ts';

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
