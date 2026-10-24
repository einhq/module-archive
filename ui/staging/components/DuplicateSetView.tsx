import type { DuplicateMember, DuplicateSet } from '@archive/media/api';
import { TablerIcon } from '@ein/ui/components';
import { formatBytes, gridUrl, thumbnailUrl } from '@ein/ui/lib';
import { Badge, Box, Button, Card, Group, Image, Stack, Text } from '@mantine/core';
import { blockedLine, copiesWord, flagLines, gainsLine, keepLine, scoreLine } from '../lib/duplicate-sets.ts';

/** A tile's side, in pixels. */
const TILE = 168;

const when = (takenAt: string | undefined) => takenAt ? new Date(takenAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

type Props = {
  set: DuplicateSet;
  /** The set the keys act on. */
  focused: boolean;
  /** Nothing can be done to it now: a bulk run is going. */
  disabled: boolean;
  /** Resolve it, keeping its kept file or the staged one `keep` names. */
  onResolve: (set: DuplicateSet, keep?: string) => void;
  onFocus: (set: DuplicateSet) => void;
  /** Look at its files side by side. */
  onCompare: (set: DuplicateSet) => void;
  /** Its files are not duplicates (look-alikes only). */
  onSeparate: (set: DuplicateSet) => void;
};

/**
 * One duplicate set on the Duplicates tab: the kept file first, marked with where it is, then the
 * files resolving it drops, each drawn from its renditions or its twin's, with its size, picture
 * size, name and time — for look-alikes how alike it is too; a library file with the album holding
 * it. Below them why the kept one is kept, what it gains, and what to look out for; then Remove,
 * which drops the others, and Compare, which shows them side by side. In a set within the inbox each
 * other staged file can be kept instead; look-alikes can be said to be no duplicates.
 */
export function DuplicateSetView({ set, focused, disabled, onResolve, onFocus, onCompare, onSeparate }: Props) {
  const members = [...set.existing, ...set.staged].sort((a, b) => (a.id === set.keep ? -1 : b.id === set.keep ? 1 : 0));
  const blocked = blockedLine(set);
  const gains = gainsLine(set.carries);
  const score = scoreLine(set.score);
  const what = set.kind === 'near'
    ? (set.where === 'library' ? 'like a library photo' : 'alike in this import')
    : set.where === 'library'
    ? 'of a library photo'
    : 'of a photo in this import';
  const dropping = set.kind === 'near' ? `${set.discard.length.toLocaleString()} ${set.discard.length === 1 ? 'photo' : 'photos'}` : copiesWord(set.discard.length);
  // A look-alike waits for a person, not for --apply: Remove stays open for it.
  const resolvable = set.blocked === undefined || set.blocked === 'needs-review';
  return (
    <Card
      withBorder
      radius='md'
      p='md'
      onClick={() => onFocus(set)}
      style={focused ? { borderColor: 'var(--mantine-primary-color-filled)', boxShadow: '0 0 0 1px var(--mantine-primary-color-filled)' } : undefined}
      aria-current={focused || undefined}
    >
      <Stack gap='sm'>
        <Group justify='space-between' wrap='nowrap'>
          <Text fw={600} size='sm'>
            {dropping} {what}
          </Text>
          <Group gap={6} wrap='nowrap'>
            {score && <Badge variant='light' color='blue'>{score}</Badge>}
            {set.reclaimableBytes > 0 && <Badge variant='light' color='gray'>{formatBytes(set.reclaimableBytes)}</Badge>}
          </Group>
        </Group>
        <Group gap='sm' align='flex-start' wrap='wrap'>
          {members.map((member) => (
            <MemberTile
              key={member.id}
              member={member}
              kept={member.id === set.keep}
              dropped={set.discard.includes(member.id)}
              canKeep={!disabled && (set.where === 'inbox' || set.kind === 'near') && member.place === 'inbox' && member.id !== set.keep && resolvable}
              onKeep={() => onResolve(set, member.id)}
            />
          ))}
        </Group>
        <Text size='xs' c='dimmed'>
          {keepLine(set)}
          {gains ? ` · ${gains}` : ''}
        </Text>
        {[...flagLines(set), ...(blocked ? [blocked] : [])].map((line) => (
          <Group key={line} gap={6} wrap='nowrap'>
            <TablerIcon name='alert-triangle' size={14} />
            <Text size='xs' c='yellow'>{line}</Text>
          </Group>
        ))}
        <Group gap='xs'>
          <Button
            size='xs'
            variant={focused ? 'filled' : 'light'}
            color='red'
            leftSection={<TablerIcon name='trash' size={14} />}
            disabled={disabled || !resolvable || set.discard.length === 0}
            onClick={(event) => {
              event.stopPropagation();
              onResolve(set);
            }}
          >
            Remove {dropping}
          </Button>
          <Button
            size='xs'
            variant='subtle'
            leftSection={<TablerIcon name='layout-columns' size={14} />}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              onCompare(set);
            }}
          >
            Compare
          </Button>
          {set.kind === 'near' && (
            <Button
              size='xs'
              variant='subtle'
              color='gray'
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onSeparate(set);
              }}
            >
              Not duplicates
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function MemberTile({ member, kept, dropped, canKeep, onKeep }: { member: DuplicateMember; kept: boolean; dropped: boolean; canKeep: boolean; onKeep: () => void }) {
  const size = [member.width && member.height ? `${member.width}×${member.height}` : null, member.size !== undefined ? formatBytes(member.size) : null].filter(Boolean).join(
    ' · ',
  );
  const taken = when(member.takenAt);
  return (
    <Box w={TILE} style={{ opacity: dropped || kept ? 1 : 0.6 }}>
      <Box pos='relative'>
        <Image
          src={gridUrl(member.previewPath, member.thumbnails)}
          fallbackSrc={thumbnailUrl(member.previewPath, member.thumbnails)}
          alt={member.name}
          h={TILE}
          w={TILE}
          fit='cover'
          radius='sm'
          loading='lazy'
        />
        <Badge
          pos='absolute'
          top={6}
          left={6}
          size='sm'
          color={kept ? 'teal' : dropped ? 'red' : 'gray'}
          variant='filled'
          leftSection={<TablerIcon name={kept ? 'check' : dropped ? 'x' : 'folder'} size={12} />}
        >
          {kept ? (member.place === 'library' ? 'Keep · library' : 'Keep') : dropped ? 'Drop' : 'Elsewhere'}
        </Badge>
      </Box>
      <Text size='xs' mt={4} truncate title={member.path}>{member.place === 'library' && member.album ? member.album.name : member.name}</Text>
      {size && <Text size='xs' c='dimmed'>{size}</Text>}
      {taken && <Text size='xs' c='dimmed'>{taken}</Text>}
      {dropped && member.carries.length > 0 && <Text size='xs' c='dimmed'>gives {member.carries.join(', ')}</Text>}
      {canKeep && (
        <Button
          size='compact-xs'
          variant='subtle'
          mt={2}
          onClick={(event) => {
            event.stopPropagation();
            onKeep();
          }}
        >
          Keep this one
        </Button>
      )}
    </Box>
  );
}
