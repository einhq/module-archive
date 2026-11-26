import type { StagingCandidate } from '@archive/staging/api';
import { Dialog, formatRange, MediaGrid, TablerIcon } from '@ein/ui/components';
import { useAccessIds, useEntityComplete } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';
import { ActionIcon, Alert, Box, Button, CloseButton, Group, List, Loader, Paper, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { albumRoute } from '../../media/lib/album-path.ts';
import { useAlbumSample } from '../hooks/useAlbumSample.ts';
import { useGroupDetails } from '../hooks/useGroupDetails.ts';
import type { GroupRow } from '../hooks/useGroupIndex.ts';
import type { AlbumTarget } from '../lib/destinations.ts';
import { cardTitle } from '../lib/group-title.ts';
import { isLaneGroup } from '../lib/lanes.ts';

type Props = {
  /** The group whose suggestions are shown; none: the dialog is closed. */
  row: GroupRow | null;
  /** What Move here files, in words: the group's photos, or those of it selected. */
  what?: string;
  onClose: () => void;
  onMove: (album: AlbumTarget) => void;
  /** "Not this album": the group is matched again without the candidate. */
  onReject: (candidate: StagingCandidate) => void;
};

/** Pictures shown of each album, in one low row. */
const PICTURES = 12;
const ROW = 96;
/** Albums found by name that are shown at once. */
const FOUND_SHOWN = 5;

/**
 * One album the dialog offers: its name, with a link that opens it in another tab, and what is
 * known of it; why it is suggested, a point each; a row of its pictures nearest the group's days;
 * and Move here.
 */
function AlbumOffer(
  { album, timeStart, timeEnd, detail, p, reasons, writable, onMove, onReject }: {
    album: AlbumTarget;
    /** When the group was taken, which the pictures shown are nearest to. */
    timeStart?: string;
    timeEnd?: string;
    detail?: string;
    /** How likely it is where the group goes, for a suggestion. */
    p?: number;
    reasons?: readonly string[];
    writable: boolean;
    onMove: () => void;
    onReject?: () => void;
  },
) {
  const { items, loaded, error } = useAlbumSample(album.path, timeStart, timeEnd, PICTURES);
  return (
    <Paper withBorder radius='md' p='md'>
      <Group justify='space-between' wrap='nowrap' gap='md' align='flex-start' mb='sm'>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap='nowrap'>
            <Text fw={600} truncate title={album.path} c={writable ? undefined : 'dimmed'} style={{ minWidth: 0 }}>{album.title}</Text>
            <Tooltip label='Open the album in a new tab'>
              <ActionIcon
                component='a'
                href={albumRoute(album.path)}
                target='_blank'
                rel='noopener'
                size='sm'
                variant='subtle'
                color='gray'
                aria-label={`Open ${album.title} in a new tab`}
              >
                <TablerIcon name='external-link' size={14} />
              </ActionIcon>
            </Tooltip>
            {p !== undefined && <Text size='sm' c='dimmed' style={{ flexShrink: 0 }}>{Math.round(p * 100)}%</Text>}
          </Group>
          {detail && <Text size='sm' c='dimmed' truncate mt={2}>{detail}</Text>}
        </Box>
        <Group gap={4} wrap='nowrap'>
          {onReject && <Button size='compact-sm' variant='subtle' color='gray' onClick={onReject}>Not this album</Button>}
          <Button size='compact-sm' variant='light' leftSection={<TablerIcon name='photo-check' size={14} />} disabled={!writable} onClick={onMove}>
            Move here
          </Button>
        </Group>
      </Group>
      {reasons && reasons.length > 0 && (
        <List size='sm' spacing={6} mb='md' icon={<TablerIcon name='point-filled' size={12} color='var(--mrx-accent)' />} center>
          {reasons.map((reason) => <List.Item key={reason}>{reason}</List.Item>)}
        </List>
      )}
      {error
        ? <Alert color='red' variant='light' py={4}>{error}</Alert>
        : !loaded
        ? <MediaGrid items={[]} loading targetRowHeight={ROW} />
        : items.length === 0
        ? <Text size='xs' c='dimmed'>No pictures here.</Text>
        : (
          <Box style={{ maxHeight: ROW, overflow: 'hidden' }}>
            <MediaGrid items={items} targetRowHeight={ROW} tileKeys={false} />
          </Box>
        )}
    </Paper>
  );
}

/**
 * Add to existing (on a Sort card): the library albums the group was matched to, best first, each with
 * how likely and why, a row of its own pictures nearest the group's days, Move here, and Not this
 * album; and a search by name for any other album the reader may file into, shown the same way.
 * A picture opens in the lightbox over the dialog; an album's link opens it in another tab.
 */
export function AddToExistingDialog({ row, what, onClose, onMove, onReject }: Props) {
  const access = useAccessIds();
  const [query, setQuery] = useState('');
  const opened = row !== null;
  useEffect(() => {
    if (opened) setQuery('');
  }, [opened, row?.name]);
  const details = useGroupDetails(useMemo(() => row ? [row] : [], [row]));
  const detail = row ? details.get(row.path) : undefined;
  const candidates = detail?.candidates ?? [];
  const words = query.trim();
  const { hits, loading } = useEntityComplete(opened && words ? words : undefined, ['album']);
  const suggested = new Set(candidates.map((candidate) => candidate.album.path));
  const found = hits.filter((hit) => !suggested.has(hit.path) && canWrite(hit.ownership, access)).slice(0, FOUND_SHOWN);
  const matched = row?.staging.matchedAt !== undefined;
  const lane = row !== null && isLaneGroup(row);

  return (
    <Dialog
      opened={opened}
      onClose={onClose}
      title={row ? `Add “${cardTitle(row.title)}” to an existing album` : 'Add to an existing album'}
      subtitle={what}
      icon='library-plus'
      pattern='album'
      size='lg'
    >
      <Stack gap='sm'>
        <TextInput
          data-autofocus
          placeholder='Find another album'
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          leftSection={<TablerIcon name='search' size={16} />}
          rightSection={loading ? <Loader size={14} /> : query ? <CloseButton size='sm' aria-label='Clear the search' onClick={() => setQuery('')} /> : undefined}
        />
        {words
          ? (
            <Stack gap='md' mih={200}>
              {!loading && found.length === 0 && <Text size='sm' c='dimmed' px='xs'>No other album you can add to is called that.</Text>}
              {found.map((hit) => (
                <AlbumOffer
                  key={hit.path}
                  album={{ path: hit.path, title: hit.name }}
                  timeStart={row?.timeStart}
                  timeEnd={row?.timeEnd}
                  writable
                  onMove={() => onMove({ path: hit.path, title: hit.name })}
                />
              ))}
            </Stack>
          )
          : (
            <Stack gap='md' mih={200}>
              {lane
                ? <Text size='sm' c='dimmed' px='xs'>Its days are matched to albums one by one: expand it to see them, or find an album by name above.</Text>
                : !matched
                ? <Text size='sm' c='dimmed' px='xs'>It has not been compared with the library yet. Find an album by name above.</Text>
                : !detail
                ? <Loader size='sm' mx='auto' my='md' />
                : candidates.length === 0 && <Text size='sm' c='dimmed' px='xs'>No album in the library fits it well. Find one by name above.</Text>}
              {candidates.map((candidate) => (
                <AlbumOffer
                  key={candidate.album.path}
                  album={{ path: candidate.album.path, title: candidate.album.title }}
                  timeStart={row?.timeStart}
                  timeEnd={row?.timeEnd}
                  detail={[
                    formatRange(candidate.album.timeStart, candidate.album.timeEnd),
                    candidate.album.count !== undefined ? `${candidate.album.count.toLocaleString()} photos` : '',
                    candidate.album.writable ? '' : 'view only',
                  ].filter(Boolean).join(' · ')}
                  p={candidate.p}
                  reasons={candidate.reasons}
                  writable={candidate.album.writable}
                  onMove={() => onMove({ path: candidate.album.path, title: candidate.album.title })}
                  onReject={() => onReject(candidate)}
                />
              ))}
            </Stack>
          )}
      </Stack>
    </Dialog>
  );
}
