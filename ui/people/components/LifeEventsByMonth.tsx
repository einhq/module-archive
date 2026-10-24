import { Box, Card, Group, SimpleGrid, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import type { LifeEventKind, LifeEventStats } from '@archive/people/api';
import { STATS_COLORS, TablerIcon } from '@ein/ui/components';

type Props = { events: LifeEventStats };

const HEIGHT = 150;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SERIES: Array<{ kind: LifeEventKind; label: string; color: string }> = [
  { kind: 'births', label: 'Births', color: STATS_COLORS.births },
  { kind: 'engagements', label: 'Engagements', color: STATS_COLORS.engagements },
  { kind: 'marriages', label: 'Marriages', color: STATS_COLORS.marriages },
  { kind: 'deaths', label: 'Deaths', color: STATS_COLORS.deaths },
];

function LifeEventChart({ events, kind, label, color }: Props & typeof SERIES[number]) {
  const peak = Math.max(1, ...events.months.map((month) => month[kind]));

  return (
    <Card>
      <Group gap='xs' mb='md' wrap='nowrap'>
        <TablerIcon name='calendar-stats' size={18} color={color} />
        <Title order={4}>{label} by month</Title>
        <Text size='sm' c='dimmed' ml='auto'>{events.totals[kind].toLocaleString()}</Text>
      </Group>

      <Group gap='xs' align='stretch' wrap='nowrap'>
        <Stack h={HEIGHT} w={34} justify='space-between' gap={0} style={{ flexShrink: 0 }}>
          <Text size='xs' c='dimmed' ta='right'>{peak.toLocaleString()}</Text>
          <Text size='xs' c='dimmed' ta='right'>0</Text>
        </Stack>

        <Box style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
          <Box style={{ minWidth: 420 }}>
            <Box
              role='img'
              aria-label={`${label}: ${events.months.map((month) => `${MONTHS[month.month - 1]} ${month[kind]}`).join(', ')}`}
              style={{
                height: HEIGHT,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 5,
                borderBottom: '1px solid var(--mrx-border-subtle)',
                backgroundImage: 'linear-gradient(to bottom, var(--mrx-border-subtle) 1px, transparent 1px)',
                backgroundSize: '100% 50%',
              }}
            >
              {events.months.map((month) => (
                <Tooltip key={month.month} label={`${MONTHS[month.month - 1]}: ${month[kind].toLocaleString()}`} withArrow openDelay={0}>
                  <Box
                    style={{
                      flex: 1,
                      minWidth: 12,
                      height: month[kind] > 0 ? Math.max(2, (month[kind] / peak) * HEIGHT) : 1,
                      background: month[kind] > 0 ? color : 'var(--mrx-surface-overlay)',
                      borderRadius: '3px 3px 0 0',
                      cursor: 'default',
                    }}
                  />
                </Tooltip>
              ))}
            </Box>

            <Box style={{ display: 'flex', gap: 5 }} mt={5}>
              {MONTHS.map((month) => <Text key={month} size='xs' c='dimmed' ta='center' style={{ flex: 1 }}>{month}</Text>)}
            </Box>
          </Box>
        </Box>
      </Group>

      <Text size='xs' c='dimmed' mt='xs'>All years</Text>
    </Card>
  );
}

/** The charts' cards while the counts are on the way: the same boxes, so the page does not jump. */
export function LifeEventsByMonthSkeleton() {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing='lg' aria-hidden>
      {SERIES.map((series) => (
        <Card key={series.kind}>
          <Group gap='xs' mb='md' wrap='nowrap'>
            <Skeleton height={20} width='40%' radius='sm' />
            <Skeleton height={14} width={60} radius='sm' ml='auto' />
          </Group>
          <Skeleton height={HEIGHT + 22} radius='sm' />
          <Skeleton height={12} width={60} radius='sm' mt='xs' />
        </Card>
      ))}
    </SimpleGrid>
  );
}

export function LifeEventsByMonth({ events }: Props) {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing='lg'>
      {SERIES.map((series) => <LifeEventChart key={series.kind} events={events} {...series} />)}
    </SimpleGrid>
  );
}
