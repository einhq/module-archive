import { Box, Group, Stack, Text } from '@mantine/core';
import { formatDate } from '@ein/ui/lib';
import { type PointerEvent, useMemo, useState } from 'react';
import { InfoSection } from '../../components/InfoSection.tsx';
import type { CameraSighting, CameraUsage } from '@archive/camera/api';

const DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
const showDay = (day: string): string => formatDate(`${day}T00:00:00Z`, DAY);

const pictures = (count: number) => `${count.toLocaleString()} picture${count === 1 ? '' : 's'}`;

/** When something was seen: one day, or the first and last. */
const seen = ({ first, last }: CameraSighting): string => !first ? '' : first === last ? showDay(first) : `${showDay(first)} – ${showDay(last!)}`;

const CHART_WIDTH = 300;
const CHART_HEIGHT = 72;

/**
 * The shutter count over time, one series: its line from zero, so the slope reads as how much the
 * camera was used; pointing at it reads out the nearest day.
 */
function ShutterChart({ readings }: { readings: CameraUsage['shutter'] }) {
  const [pointed, setPointed] = useState<number | null>(null);

  const points = useMemo(() => {
    const times = readings.map((reading) => Date.parse(`${reading.date}T00:00:00Z`));
    const start = times[0];
    const span = Math.max(1, times[times.length - 1] - start);
    const peak = Math.max(1, ...readings.map((reading) => reading.count));
    return readings.map((reading, i) => ({
      x: ((times[i] - start) / span) * CHART_WIDTH,
      y: CHART_HEIGHT - (reading.count / peak) * (CHART_HEIGHT - 4),
      reading,
    }));
  }, [readings]);

  const latest = readings[readings.length - 1];
  const shown = pointed === null ? latest : readings[pointed];

  const point = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * CHART_WIDTH;
    let nearest = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].x - x) < Math.abs(points[nearest].x - x)) nearest = i;
    setPointed(nearest);
  };

  const marker = pointed === null ? undefined : points[pointed];

  return (
    <Stack gap={4}>
      <Text size='sm'>
        {shown.count.toLocaleString()} <Text span size='sm' c='dimmed'>on {showDay(shown.date)}</Text>
      </Text>
      {points.length > 1 && (
        <Box>
          <svg
            viewBox={`-4 -4 ${CHART_WIDTH + 8} ${CHART_HEIGHT + 8}`}
            width='100%'
            height={CHART_HEIGHT + 8}
            preserveAspectRatio='none'
            role='img'
            aria-label={`Shutter count from ${readings[0].count.toLocaleString()} on ${readings[0].date} to ${latest.count.toLocaleString()} on ${latest.date}`}
            onPointerMove={point}
            onPointerLeave={() => setPointed(null)}
            style={{ display: 'block', touchAction: 'none' }}
          >
            <line x1={0} x2={CHART_WIDTH} y1={CHART_HEIGHT} y2={CHART_HEIGHT} stroke='var(--mantine-color-default-border)' strokeWidth={1} vectorEffect='non-scaling-stroke' />
            <polyline
              points={points.map((each) => `${each.x},${each.y}`).join(' ')}
              fill='none'
              stroke='var(--mantine-primary-color-filled)'
              strokeWidth={2}
              strokeLinejoin='round'
              strokeLinecap='round'
              vectorEffect='non-scaling-stroke'
            />
            {marker && (
              <line
                x1={marker.x}
                x2={marker.x}
                y1={0}
                y2={CHART_HEIGHT}
                stroke='var(--mantine-color-dimmed)'
                strokeWidth={1}
                strokeDasharray='2 2'
                vectorEffect='non-scaling-stroke'
              />
            )}
          </svg>
          <Group justify='space-between' mt={2}>
            <Text size='xs' c='dimmed'>{showDay(readings[0].date)}</Text>
            <Text size='xs' c='dimmed'>{showDay(latest.date)}</Text>
          </Group>
        </Box>
      )}
    </Stack>
  );
}

/** A name with what is known of when it was seen beside it. */
function SightingRow({ name, sighting }: { name: string; sighting: CameraSighting }) {
  return (
    <Group justify='space-between' gap='xs' wrap='nowrap' align='baseline'>
      <Text size='sm' style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{name}</Text>
      <Text size='xs' c='dimmed' ta='right' style={{ flexShrink: 0 }}>
        {pictures(sighting.files)}
        {sighting.first
          ? (
            <>
              <br />
              {seen(sighting)}
            </>
          )
          : null}
      </Text>
    </Group>
  );
}

/**
 * What the camera's pictures say about it in their maker notes (`camera-usage`): its shutter count
 * over time, the firmware it ran and the lenses used on it. A section only where its pictures carry
 * it; nothing at all while it is read, or when none do.
 */
export function CameraUsageSections({ usage }: { usage: CameraUsage | null }) {
  if (!usage) return null;
  return (
    <>
      {usage.shutter.length > 0 && (
        <InfoSection title='Shutter count'>
          <ShutterChart readings={usage.shutter} />
        </InfoSection>
      )}
      {usage.firmware.length > 0 && (
        <InfoSection title='Firmware'>
          {usage.firmware.map((each) => <SightingRow key={each.version} name={each.version} sighting={each} />)}
        </InfoSection>
      )}
      {usage.lenses.length > 0 && (
        <InfoSection title='Lenses'>
          {usage.lenses.map((each) => <SightingRow key={each.lens} name={each.lens} sighting={each} />)}
        </InfoSection>
      )}
    </>
  );
}
