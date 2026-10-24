import type { DuplicateSet } from '@archive/media/api';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { displayUrl, formatBytes, gridUrl } from '@ein/ui/lib';
import { Badge, Box, Button, Group, Image, Kbd, SimpleGrid, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { compareKey, compareMembers, type CompareState, flagLines, keepLine, memberFacts, scoreLine } from '../lib/duplicate-sets.ts';

type Props = {
  /** The set compared; null keeps the dialog closed. */
  set: DuplicateSet | null;
  onClose: () => void;
  /** Resolve the set keeping `keep`: drop the files alike to it (`staging dedupe <key> --keep`). */
  onResolve: (set: DuplicateSet, keep: string) => void;
  /** The files are not duplicates (`staging separate`); absent for copies, which always are. */
  onSeparate?: (set: DuplicateSet) => void;
};

/** Files shown side by side at most; the rest are a row of their own below. */
const COLUMNS = 4;

/**
 * A duplicate set's files side by side, large enough to tell them apart: each with its size in
 * pixels and bytes, when it was taken, its camera and how alike it is, and which one is kept and
 * which go. ← and → move between them, K keeps the one in focus, Enter resolves the set keeping
 * the one marked, and X — for look-alikes — records that they are not duplicates.
 */
export function CompareDialog({ set, onClose, onResolve, onSeparate }: Props) {
  const members = set ? compareMembers(set) : [];
  const [state, setState] = useState<CompareState>({ focus: 0, keep: set?.keep ?? '' });
  useEffect(() => setState({ focus: 0, keep: set?.keep ?? '' }), [set?.key]);

  // A window capture listener, and every key it takes stops there: under the dialog the page or
  // the lightbox binds the same keys (arrows, Enter, Escape), and one press would act on both.
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyRef.current = (event: KeyboardEvent) => {
    if (!set || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const result = event.key === 'Escape' ? { close: true as const } : compareKey(event.key, state, members);
    if (!result) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if ('close' in result) onClose();
    else if ('state' in result) setState(result.state);
    else if ('apply' in result) onResolve(set, result.apply);
    else if (onSeparate && set.kind === 'near') onSeparate(set);
  };
  useEffect(() => {
    if (!set) return;
    const onKey = (event: KeyboardEvent) => keyRef.current(event);
    globalThis.addEventListener('keydown', onKey, true);
    return () => globalThis.removeEventListener('keydown', onKey, true);
  }, [set !== null]);

  if (!set) return null;
  const marked = state.keep;
  // What resolving would drop, as far as the dialog can tell: every staged file but the one marked.
  const dropped = (id: string) => id !== marked && set.staged.some((member) => member.id === id);
  const score = scoreLine(set.score);

  return (
    <Dialog
      opened
      onClose={onClose}
      closeOnEscape={false}
      size='screen'
      title={set.kind === 'near' ? 'Look-alikes' : 'Copies'}
      subtitle={[score, keepLine(set)].filter(Boolean).join(' · ')}
    >
      <Stack gap='md' p='md'>
        <SimpleGrid cols={{ base: 1, sm: Math.min(COLUMNS, members.length) }} spacing='md'>
          {members.map((member, index) => {
            const kept = member.id === marked;
            const gone = dropped(member.id);
            return (
              <Box
                key={member.id}
                onClick={() => setState((current) => ({ ...current, focus: index }))}
                style={{
                  borderRadius: 'var(--mantine-radius-md)',
                  outline: index === state.focus ? '2px solid var(--mrx-accent)' : undefined,
                  outlineOffset: 2,
                  opacity: kept || gone ? 1 : 0.7,
                  cursor: 'pointer',
                }}
              >
                <Box pos='relative'>
                  <Image
                    src={displayUrl(
                      member.previewPath,
                      'photo',
                      member.thumbnails,
                      member.width && member.height ? { width: member.width, height: member.height } : undefined,
                    )}
                    fallbackSrc={gridUrl(member.previewPath, member.thumbnails)}
                    alt={member.name}
                    fit='contain'
                    h='55vh'
                    radius='sm'
                    style={{ background: 'var(--mrx-surface-sunken)' }}
                  />
                  <Badge
                    pos='absolute'
                    top={8}
                    left={8}
                    color={kept ? 'teal' : gone ? 'red' : 'gray'}
                    variant='filled'
                    leftSection={<TablerIcon name={kept ? 'check' : gone ? 'x' : 'folder'} size={12} />}
                  >
                    {kept ? (member.place === 'library' ? 'Keep · library' : 'Keep') : gone ? 'Drop' : member.place === 'library' ? 'Library' : 'Stays'}
                  </Badge>
                </Box>
                <Text size='sm' mt={6} truncate title={member.path}>{member.place === 'library' && member.album ? member.album.name : member.name}</Text>
                {memberFacts(member, formatBytes).map((line) => <Text key={line} size='xs' c='dimmed'>{line}</Text>)}
                {member.copies.length > 0 && <Text size='xs' c='dimmed'>and {member.copies.length} byte {member.copies.length === 1 ? 'copy' : 'copies'}</Text>}
              </Box>
            );
          })}
        </SimpleGrid>
        {flagLines(set).map((line) => (
          <Group key={line} gap={6} wrap='nowrap'>
            <TablerIcon name='alert-triangle' size={14} />
            <Text size='xs' c='yellow'>{line}</Text>
          </Group>
        ))}
        <Text size='xs' c='dimmed'>
          <Kbd size='xs'>←</Kbd> <Kbd size='xs'>→</Kbd> move · <Kbd size='xs'>K</Kbd> keep this one · <Kbd size='xs'>Enter</Kbd> remove the others
          {set.kind === 'near' && onSeparate
            ? (
              <>
                {' · '}
                <Kbd size='xs'>X</Kbd> not duplicates
              </>
            )
            : null}
        </Text>
      </Stack>
      <DialogActions>
        {set.kind === 'near' && onSeparate && <Button variant='default' onClick={() => onSeparate(set)}>Not duplicates</Button>}
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button color='red' leftSection={<TablerIcon name='trash' size={14} />} onClick={() => onResolve(set, marked)}>Remove the others</Button>
      </DialogActions>
    </Dialog>
  );
}
