import type { DuplicateMember, DuplicateSet } from '@archive/media/api';
import { categoryPath, stagedPlace } from '@archive/staging/paths';
import { TablerIcon } from '@ein/ui/components';
import { gridUrl } from '@ein/ui/lib';
import { currentUser } from '@ein/ui/signals';
import { Box, SimpleGrid, UnstyledButton } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useEffect, useState } from 'react';
import { useDuplicateSets } from '../hooks/useDuplicateSets.ts';
import { useSetActions } from '../hooks/useSetActions.ts';
import { memberWhere } from '../lib/duplicate-sets.ts';
import { CompareDialog } from './CompareDialog.tsx';

type Props = {
  /** The file the lightbox shows. */
  path: string;
  /** Lays the grid out as one of the sidebar's sections, headed with how many files it shows. */
  section: (count: number, children: ReactNode) => ReactNode;
  /** The compare dialog opened or closed over the lightbox, which leaves it the keys while open. */
  onLayer: (open: boolean) => void;
};

/**
 * The exact copies of a staged file of the reader's own (`staging duplicates <file>`), in the
 * lightbox: the other files with its bytes, in the library or staged, as a small grid like the
 * Similar one, each named with where it lies on hover. A click opens them side by side with that
 * one in focus, where the set is resolved keeping any staged file (`staging dedupe` in the file's
 * category), with Undo. Look-alikes are not duplicates: Similar shows them. Draws nothing for a
 * file that is not staged, or that has no copies.
 */
export function StagedDuplicates({ path, section, onLayer }: Props) {
  useSignals();
  const place = stagedPlace(path);
  const own = place !== undefined && place.user === currentUser.value?.username;
  const { page, reread } = useDuplicateSets(path, '', own);
  const [comparing, setComparing] = useState<{ set: DuplicateSet; focus: string } | null>(null);
  useEffect(() => onLayer(comparing !== null), [comparing !== null]);
  useEffect(() => () => onLayer(false), []);

  const actions = useSetActions(place ? categoryPath(place.user, place.category) : '', reread);

  const others = (page?.sets ?? []).filter((set) => set.kind === 'exact').flatMap((set) =>
    [...set.existing, ...set.staged].filter((member) => member.path !== path).map((member) => ({ set, member }))
  );
  if (!own || others.length === 0) return null;

  const resolve = (set: DuplicateSet, keep: string) => {
    setComparing(null);
    void actions.resolve(set, keep);
  };

  return (
    <>
      {section(
        others.length,
        <SimpleGrid cols={4} spacing={4}>
          {others.map(({ set, member }) => <CopyTile key={member.id} member={member} onOpen={() => setComparing({ set, focus: member.id })} />)}
        </SimpleGrid>,
      )}
      <CompareDialog set={comparing?.set ?? null} focus={comparing?.focus} onClose={() => setComparing(null)} onResolve={resolve} />
    </>
  );
}

/** Another file with the same bytes: its picture, a library mark when it is in the library, and its name and place on hover. */
function CopyTile({ member, onOpen }: { member: DuplicateMember; onOpen: () => void }) {
  const label = `${member.name}\n${memberWhere(member)}\n${member.path}`;
  return (
    <UnstyledButton
      onClick={onOpen}
      title={label}
      aria-label={`Compare with ${member.name}`}
      style={{ position: 'relative', aspectRatio: '1', overflow: 'hidden', borderRadius: 4 }}
    >
      <img
        src={gridUrl(member.previewPath, member.thumbnails)}
        alt=''
        loading='lazy'
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      {member.place === 'library' && (
        <Box className='mrx-tile-badge' px={4} py={1} style={{ position: 'absolute', left: 3, bottom: 3, display: 'flex' }}>
          <TablerIcon name='library' size={12} />
        </Box>
      )}
    </UnstyledButton>
  );
}
