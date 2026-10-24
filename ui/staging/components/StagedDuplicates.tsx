import type { DuplicateSet } from '@archive/media/api';
import { categoryPath, stagedPlace } from '@archive/staging/paths';
import { TablerIcon } from '@ein/ui/components';
import { thumbnailUrl } from '@ein/ui/lib';
import { currentUser } from '@ein/ui/signals';
import { Badge, Box, Button, Group, Stack, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useEffect, useState } from 'react';
import { useDuplicateSets } from '../hooks/useDuplicateSets.ts';
import { useSetActions } from '../hooks/useSetActions.ts';
import { fileSetLine, keepLine, scoreLine } from '../lib/duplicate-sets.ts';
import { CompareDialog } from './CompareDialog.tsx';

type Props = {
  /** The file the lightbox shows. */
  path: string;
  /** Lays a section out beside its icon, as the sidebar's other sections are. */
  row: (children: ReactNode) => ReactNode;
  /** The compare dialog opened or closed over the lightbox, which leaves it the keys while open. */
  onLayer: (open: boolean) => void;
};

/**
 * The duplicate sets a staged file of the reader's own belongs to (`staging duplicates <file>`),
 * in the lightbox: for each, whether the file is kept or what it copies or looks like, the set's
 * other files, and why the kept one is kept. **Compare** shows the files side by side, where the
 * set is resolved keeping any staged one (`staging dedupe` in the file's category); look-alikes
 * can be said to be no duplicates (`staging separate`). Either says so with Undo. Draws nothing
 * for a file that is not staged, or that is in no set.
 */
export function StagedDuplicates({ path, row, onLayer }: Props) {
  useSignals();
  const place = stagedPlace(path);
  const own = place !== undefined && place.user === currentUser.value?.username;
  const { page, reread } = useDuplicateSets(path, '', own);
  const [comparing, setComparing] = useState<DuplicateSet | null>(null);
  useEffect(() => onLayer(comparing !== null), [comparing !== null]);
  useEffect(() => () => onLayer(false), []);

  const actions = useSetActions(place ? categoryPath(place.user, place.category) : '', reread);

  if (!own || !page || page.sets.length === 0) return null;

  const resolve = (set: DuplicateSet, keep: string) => {
    setComparing(null);
    void actions.resolve(set, keep);
  };
  const keepApart = (set: DuplicateSet) => {
    setComparing(null);
    void actions.keepApart(set);
  };

  return (
    <>
      {row(page.sets.map((set) => <SetRow key={set.key} set={set} path={path} onCompare={() => setComparing(set)} onSeparate={() => keepApart(set)} />))}
      <CompareDialog set={comparing} onClose={() => setComparing(null)} onResolve={resolve} onSeparate={keepApart} />
    </>
  );
}

/** One set: what it says of the file at `path`, its other files as thumbnails with the kept one marked, why, and what can be done. */
function SetRow({ set, path, onCompare, onSeparate }: { set: DuplicateSet; path: string; onCompare: () => void; onSeparate: () => void }) {
  const members = [...set.existing, ...set.staged];
  const id = members.find((member) => member.path === path)?.id ?? '';
  const others = members.filter((member) => member.id !== id);
  const score = scoreLine(set.score);
  return (
    <Stack gap={6}>
      <Group justify='space-between' gap='xs' wrap='nowrap'>
        <Text size='sm' fw={600}>{fileSetLine(set, id)}</Text>
        {score && <Badge size='sm' variant='light' color='blue' tt='none' fw={500}>{score}</Badge>}
      </Group>
      <Box style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {others.map((member) => (
          <Box
            key={member.id}
            title={member.album ? `${member.name} · ${member.album.name}` : member.name}
            style={{ position: 'relative', flex: '0 0 72px', width: 72, height: 72, borderRadius: 6, overflow: 'hidden', background: 'var(--mrx-media-bg)' }}
          >
            <img src={thumbnailUrl(member.previewPath, member.thumbnails)} alt='' loading='lazy' style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {member.id === set.keep && <Badge size='xs' variant='filled' color='dark' style={{ position: 'absolute', left: 3, bottom: 3 }}>Kept</Badge>}
          </Box>
        ))}
      </Box>
      <Text size='xs' c='dimmed'>{keepLine(set)}</Text>
      <Group gap={6}>
        <Button size='compact-xs' variant='light' leftSection={<TablerIcon name='layout-columns' size={14} />} onClick={onCompare}>Compare</Button>
        {set.kind === 'near' && <Button size='compact-xs' variant='subtle' color='gray' onClick={onSeparate}>Not duplicates</Button>}
      </Group>
    </Stack>
  );
}
