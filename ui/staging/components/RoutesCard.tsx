import type { GpxInfo, TrackEntry, TrackStageResult } from '@archive/location/api';
import { stagingRoots } from '@archive/staging/paths';
import { formatRange, TablerIcon } from '@ein/ui/components';
import { useCommand, usePhone } from '@ein/ui/hooks';
import { formatBytes, type NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { ActionIcon, Alert, Box, Button, Checkbox, Group, Menu, SimpleGrid, Text, Tooltip } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isGpx } from '../../location/components/RouteImport.tsx';
import { useTracks } from '../../location/hooks/useTracks.ts';
import { frameStyle, SECTION_METRICS } from './GroupSection.tsx';

/** How many devices get a button of their own; the rest are in the menu beside them. */
const DEVICE_BUTTONS = 3;

/** How many files are listed before Show all. */
const SHOWN = 24;

/** How many `gpx-info` reads run at once: each reads a whole file on the server. */
const READS = 3;

/** `2001-01-01T10:00:00.000Z` as `10:00`, in UTC as the file has it. */
const clock = (iso: string): string => iso.slice(11, 16);

/** What a file's line says after its name: when it was recorded (not the day when its name starts with it), how many points, how large. */
const fileFacts = (name: string, size: number | undefined, info: GpxInfo | undefined): string => {
  const facts: string[] = [];
  if (info && !('error' in info)) {
    if (info.start) {
      const day = info.start.slice(0, 10);
      facts.push(`${name.startsWith(day) ? '' : `${day} `}${clock(info.start)}${info.end && info.end !== info.start ? `–${clock(info.end)}` : ''}`);
    }
    facts.push(`${info.points.toLocaleString()} points`);
  }
  if (size !== undefined) facts.push(formatBytes(size));
  return facts.join(' · ');
};

/** `n` GPX files, in words. */
const files = (n: number): string => n === 1 ? '1 GPX file' : `${n.toLocaleString()} GPX files`;

type Props = {
  /** Whose staging area's `routes/` it lists. */
  user: string;
  /** Some files joined a track and left `routes/`. */
  onChanged: () => void;
};

/**
 * The GPX files waiting in the reader's staging area (`routes/`, where `track-stage` keeps a
 * staged one that names no device it knows), as a card at the head of the Sort stream, framed like
 * a group's. Its header has a button per device (the few last heard from, the rest in its menu), which adds
 * the checked files' routes, or all of them when none is checked, to that device's track
 * (`track-stage --track`), one file after another. Each file is a line with what it says of
 * itself (`gpx-info`, read once the card is shown). A file that fails is named with why; nothing
 * is drawn when no file waits.
 */
export function RoutesCard({ user, onChanged }: Props) {
  const phone = usePhone();
  const navigate = useNavigate();
  const routesPath = stagingRoots(user).routesPath;
  const listing = useCommand<NodeChildEntry[]>(`ls -l ${shq(routesPath)}`);
  const { tracks } = useTracks();
  const [infos, setInfos] = useState<ReadonlyMap<string, GpxInfo>>(() => new Map());
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState<{ track: string; done: number; of: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const entries = useMemo(
    () =>
      (listing.data ?? [])
        .filter((entry) => entry.node.type === 'file' && isGpx(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [listing.data],
  );
  const pathOf = (name: string) => `${routesPath}/${name}`;
  const names = entries.map((entry) => entry.name).join('\n');

  // What each file says of itself, a few reads at a time; a file that cannot be read says why.
  useEffect(() => {
    let live = true;
    const queue = names ? names.split('\n') : [];
    const next = async (): Promise<void> => {
      const name = queue.shift();
      if (!name || !live) return;
      const path = pathOf(name);
      const info = await execCommand<GpxInfo[]>(`gpx-info ${shq(path)}`)
        .then(([answer]) => answer)
        .catch((err): GpxInfo => ({ path, error: err instanceof Error ? err.message : String(err) }));
      if (live) setInfos((previous) => new Map(previous).set(name, info));
      return next();
    };
    void Promise.all(Array.from({ length: READS }, next));
    return () => {
      live = false;
    };
  }, [names, routesPath]);

  if (entries.length === 0) return null;

  const acting = checked.size > 0 ? entries.filter((entry) => checked.has(entry.name)) : entries;
  const of = checked.size > 0 ? `the ${files(acting.length)} checked` : entries.length === 1 ? 'the GPX file' : `all ${files(entries.length)}`;
  const known = [...infos.values()].filter((info): info is Extract<GpxInfo, { points: number }> => !('error' in info));
  const starts = known.map((info) => info.start).filter((at): at is string => !!at).sort();
  const ends = known.map((info) => info.end ?? info.start).filter((at): at is string => !!at).sort();
  const range = starts.length > 0 ? formatRange(starts[0], ends[ends.length - 1]) : '';
  const bytes = entries.reduce((sum, entry) => sum + (entry.node.attrs.size ?? 0), 0);
  const shown = showAll ? entries : entries.slice(0, SHOWN);

  const add = async (track: TrackEntry) => {
    const batch = acting.map((entry) => entry.name);
    setErrors([]);
    setAdding({ track: track.path, done: 0, of: batch.length });
    const failed: string[] = [];
    let points = 0;
    for (const [index, name] of batch.entries()) {
      try {
        const result = await execCommand<TrackStageResult>(`track-stage ${shq(pathOf(name))} --track ${shq(track.path)}`);
        if (result.status === 'imported') points += result.imported;
        else failed.push(`${name}: ${result.reason}`);
      } catch (err) {
        failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      setAdding({ track: track.path, done: index + 1, of: batch.length });
    }
    setAdding(null);
    setErrors(failed);
    setChecked(new Set());
    const added = batch.length - failed.length;
    if (added > 0) notify({ message: `${files(added)} added to ${track.name}: ${points.toLocaleString()} new points` });
    void listing.refetch();
    onChanged();
  };

  const toggle = (name: string) =>
    setChecked((previous) => {
      const next = new Set(previous);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  // The devices last heard from first.
  const devices = [...tracks].sort((a, b) => (b.lastTs ?? '').localeCompare(a.lastTs ?? ''));
  const own = devices.slice(0, DEVICE_BUTTONS);
  const more = devices.slice(DEVICE_BUTTONS);
  const deviceButtons = (
    <>
      {own.map((track) => (
        <Tooltip key={track.path} label={`Add ${of} to ${track.name}’s track`}>
          <Button
            size='compact-sm'
            variant='default'
            leftSection={<TablerIcon name='route' size={14} />}
            loading={adding?.track === track.path}
            disabled={!!adding && adding.track !== track.path}
            onClick={() => void add(track)}
            style={{ maxWidth: 220 }}
          >
            <Text span inherit truncate>{track.name}</Text>
          </Button>
        </Tooltip>
      ))}
      {tracks.length === 0 && <Text size='xs' c='dimmed'>No device has a track yet</Text>}
    </>
  );

  return (
    <Box px='md' pb={12} data-routes-card>
      <Box px='sm' pb={10} style={frameStyle(false, false)}>
        <Group gap='sm' mih={phone ? SECTION_METRICS.phone.header : SECTION_METRICS.desktop.header} align='center' wrap='nowrap'>
          <Checkbox
            size='xs'
            checked={checked.size === entries.length}
            indeterminate={checked.size > 0 && checked.size < entries.length}
            onChange={() => setChecked(checked.size === entries.length ? new Set() : new Set(entries.map((entry) => entry.name)))}
            aria-label='Check every file'
            styles={{ input: { cursor: 'pointer' } }}
          />
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap={6} wrap='nowrap'>
              <TablerIcon name='route' size={16} />
              <Text fw={600} truncate>{files(entries.length)}</Text>
            </Group>
            <Text size='xs' c='dimmed' mt={2} truncate>
              {adding ? `Adding ${Math.min(adding.done + 1, adding.of)} of ${adding.of}…` : [
                'They name no device EiN knows: choose the one they were recorded on',
                range,
                formatBytes(bytes),
              ].filter(Boolean).join(' · ')}
            </Text>
          </Box>
          <Group gap={4} wrap='nowrap'>
            {!phone && deviceButtons}
            <Menu position='bottom-end' shadow='md' withinPortal>
              <Menu.Target>
                <ActionIcon variant='subtle' color='gray' aria-label='Actions for the GPX files'>
                  <TablerIcon name='dots-vertical' size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {more.length > 0 && (
                  <>
                    <Menu.Label>Add {of} to</Menu.Label>
                    {more.map((track) => (
                      <Menu.Item key={track.path} disabled={!!adding} leftSection={<TablerIcon name='route' size={14} />} onClick={() => void add(track)}>
                        {track.name}
                      </Menu.Item>
                    ))}
                    <Menu.Divider />
                  </>
                )}
                <Menu.Item leftSection={<TablerIcon name='list-tree' size={14} />} onClick={() => navigate('/staging/routes')}>
                  Open the files
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing='xs' verticalSpacing={4}>
          {shown.map((entry) => {
            const info = infos.get(entry.name);
            const error = info && 'error' in info ? info.error : undefined;
            return (
              <Checkbox
                key={entry.name}
                size='xs'
                checked={checked.has(entry.name)}
                onChange={() => toggle(entry.name)}
                styles={{ body: { alignItems: 'center' }, labelWrapper: { minWidth: 0 }, input: { cursor: 'pointer' }, label: { cursor: 'pointer' } }}
                label={
                  <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                    <Text size='sm' truncate style={{ flexShrink: 0, maxWidth: '50%' }}>{entry.name}</Text>
                    <Text size='xs' c={error ? 'red.4' : 'dimmed'} truncate title={error}>
                      {error ?? fileFacts(entry.name, entry.node.attrs.size, info)}
                    </Text>
                  </Group>
                }
              />
            );
          })}
        </SimpleGrid>
        {entries.length > SHOWN && (
          <Button size='compact-xs' variant='subtle' mt={6} onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${entries.length.toLocaleString()}`}
          </Button>
        )}

        {phone && <Group mt={8} gap='xs'>{deviceButtons}</Group>}

        {errors.length > 0 && (
          <Alert color='red' variant='light' mt='sm' withCloseButton onClose={() => setErrors([])}>
            {errors.map((message) => <Text key={message} size='sm'>{message}</Text>)}
          </Alert>
        )}
      </Box>
    </Box>
  );
}
