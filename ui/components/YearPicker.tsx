import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Group, RollingNumber, Slider, Tooltip } from '@mantine/core';
import { useMemo } from 'react';
import { positionAtOrBefore, scaleMarks, yearAt, yearScale } from '../lib/year-scale.ts';

/**
 * Mantine's Slider insets its track by `--slider-size`, which is 8px at `md`.
 * The histogram uses the same inset so a bar sits over the year the thumb
 * lands on.
 */
const TRACK_INSET = 8;

/** At most this many labels under the slider. */
const MAX_LABELS = 6;

/**
 * What all three parts of the picker share. They are drawn apart — the year at
 * the top of the header, the histogram in its background, the slider on its
 * bottom edge — but they are one control, and each reports every change at once
 * so the number rolls under the thumb. Debouncing the query behind them is the
 * caller's business.
 */
export type YearPickerProps = {
  value: number;
  onChange: (year: number) => void;
  min: number;
  max: number;
  /** How much each year holds, for the histogram and the jump buttons. Years not present hold nothing. */
  counts: ReadonlyMap<number, number>;
  /** What `counts` counts, for the tooltips: one album, 12 albums. */
  nouns: { one: string; many: string };
};

/** Years that hold anything, ascending. */
const useOccupied = (counts: ReadonlyMap<number, number>) =>
  useMemo(() => [...counts.entries()].filter(([, count]) => count > 0).map(([year]) => year).toSorted((a, b) => a - b), [counts]);

/**
 * The year, between one-year steps and jumps to the nearest year that holds
 * anything — which is what makes the sparse early decades usable, where one
 * album can sit twenty empty years from the next.
 */
export function YearStepper({ value, onChange, min, max, counts, nouns }: YearPickerProps) {
  const occupied = useOccupied(counts);
  const previous = occupied.findLast((year) => year < value);
  const next = occupied.find((year) => year > value);
  const clamp = (year: number) => Math.min(max, Math.max(min, year));

  return (
    <Group justify='center' gap='xs' wrap='nowrap'>
      <Tooltip label={previous !== undefined ? `Previous year with ${nouns.many}: ${previous}` : `No earlier ${nouns.many}`}>
        <ActionIcon
          variant='subtle'
          size='lg'
          disabled={previous === undefined}
          onClick={() => previous !== undefined && onChange(previous)}
          aria-label={`Previous year with ${nouns.many}`}
        >
          <TablerIcon name='chevrons-left' size={20} />
        </ActionIcon>
      </Tooltip>
      <ActionIcon variant='light' size='lg' disabled={value <= min} onClick={() => onChange(clamp(value - 1))} aria-label='One year earlier'>
        <TablerIcon name='chevron-left' size={20} />
      </ActionIcon>

      <RollingNumber value={value} animationDuration={300} fz={48} fw={700} lh={1.1} miw='4.5ch' ta='center' withLiveRegion />

      <ActionIcon variant='light' size='lg' disabled={value >= max} onClick={() => onChange(clamp(value + 1))} aria-label='One year later'>
        <TablerIcon name='chevron-right' size={20} />
      </ActionIcon>
      <Tooltip label={next !== undefined ? `Next year with ${nouns.many}: ${next}` : `No later ${nouns.many}`}>
        <ActionIcon variant='subtle' size='lg' disabled={next === undefined} onClick={() => next !== undefined && onChange(next)} aria-label={`Next year with ${nouns.many}`}>
          <TablerIcon name='chevrons-right' size={20} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * The track both the slider and the histogram are laid on: the years that hold anything, with the
 * last year the picker reaches, so the empty stretches between them take no room.
 */
const useScale = (counts: ReadonlyMap<number, number>, max: number) => {
  const occupied = useOccupied(counts);
  return useMemo(() => yearScale(occupied, max), [occupied, max]);
};

/** Where position `position` of `count` sits along the track, as a percentage. */
const along = (position: number, count: number): number => (count > 1 ? (position / (count - 1)) * 100 : 50);

/**
 * One bar per year that holds anything, standing on the slider's track at that year's step and
 * filling the height it is given. Drawn as part of the header's background, behind its title and
 * controls, so it is faint and takes no input; the chosen year is in the primary colour.
 */
export function YearHistogram({ value, max, counts }: YearPickerProps) {
  const scale = useScale(counts, max);
  const peak = Math.max(1, ...counts.values());

  return (
    <Box pos='relative' h='100%' mx={TRACK_INSET} aria-hidden>
      {scale.map((year, position) => {
        const count = counts.get(year) ?? 0;
        if (count === 0) return null;
        return (
          <Box
            key={year}
            pos='absolute'
            bottom={0}
            // Square root, so a year with two albums is still visible beside
            // one with a hundred and sixty.
            h={`max(3px, ${(Math.sqrt(count / peak) * 100).toFixed(1)}%)`}
            style={{
              left: `${along(position, scale.length)}%`,
              width: `max(2px, calc(${100 / scale.length}% - 1px))`,
              transform: 'translateX(-50%)',
              borderRadius: '2px 2px 0 0',
              backgroundColor: year === value ? 'var(--mantine-primary-color-filled)' : 'rgba(255, 255, 255, .24)',
            }}
          />
        );
      })}
    </Box>
  );
}

/**
 * The slider itself, a step per year that holds anything, labelled at a few of them. A year
 * between steps — one the stepper reached by a single year — puts the thumb on the step before.
 */
export function YearSlider({ value, onChange, max, counts }: YearPickerProps) {
  const scale = useScale(counts, max);
  const marks = useMemo(() => scaleMarks(scale, MAX_LABELS).map((mark) => ({ value: mark.position, label: mark.label })), [scale]);

  return (
    <Slider
      value={positionAtOrBefore(scale, value)}
      onChange={(position) => onChange(yearAt(scale, position))}
      min={0}
      max={Math.max(0, scale.length - 1)}
      step={1}
      marks={marks}
      label={null}
      size='md'
      aria-label='Year'
    />
  );
}
