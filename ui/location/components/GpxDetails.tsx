import { Alert, Loader, Table, Text } from '@mantine/core';
import { formatBytes, formatDuration, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { type ReactNode, useEffect, useState } from 'react';
import type { GpxInfo } from '@archive/location/api';

/** `2001-01-01T10:00:00.000Z` as `2001-01-01 10:00`. */
const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

/** When the points were recorded: the day and time of the first, the time (or day) of the last, and how long between. */
const recorded = (start: string, end?: string): string => {
  if (!end || end === start) return `${minute(start)} UTC`;
  const last = end.slice(0, 10) === start.slice(0, 10) ? minute(end).slice(11) : minute(end);
  return `${minute(start)} – ${last} UTC (${formatDuration(Date.parse(end) - Date.parse(start))})`;
};

/** What a GPX file (`path`) says about itself (`gpx-info`), as rows of a table. */
export function GpxDetails({ path }: { path: string }) {
  const [info, setInfo] = useState<GpxInfo | null>(null);

  useEffect(() => {
    let live = true;
    setInfo(null);
    execCommand<GpxInfo[]>(`gpx-info ${shq(path)}`)
      .then(([answer]) => live && setInfo(answer))
      .catch((err) => live && setInfo({ path, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [path]);

  if (!info) return <Loader size='sm' />;
  if ('error' in info) return <Alert color='red' variant='light'>{info.error}</Alert>;

  const rows: [string, ReactNode][] = [
    ['Name', info.name],
    ['Description', info.description],
    ['Tracks', info.tracks.length > 0 ? info.tracks.join(', ') : undefined],
    ['Creator', info.creator],
    ['Recorded', info.start ? recorded(info.start, info.end) : 'no point has a time'],
    ['Points', `${info.points.toLocaleString()}${info.timed < info.points ? ` (${info.timed.toLocaleString()} with a time)` : ''}`],
    ['File time', info.time ? `${minute(info.time)} UTC` : undefined],
    ['Size', formatBytes(info.size)],
    ['Matches', info.matches.length > 0 ? info.matches.map((track) => track.name).join(', ') : 'no track it names'],
  ];

  return (
    <Table verticalSpacing={2} withRowBorders={false}>
      <Table.Tbody>
        {rows.filter(([, value]) => value !== undefined).map(([label, value]) => (
          <Table.Tr key={label}>
            <Table.Td w='7rem' style={{ verticalAlign: 'top' }}>
              <Text size='xs' c='dimmed'>{label}</Text>
            </Table.Td>
            <Table.Td>
              <Text size='xs' style={{ overflowWrap: 'anywhere' }}>{value}</Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
