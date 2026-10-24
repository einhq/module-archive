import type { StagingAcceptResult } from '@archive/staging/api';
import type { MatchConfidence } from '@archive/staging/api';
import { Dialog, DialogActions } from '@ein/ui/components';
import { execCommand } from '@ein/ui/signals';
import { Alert, Button, Group, Loader, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { acceptSummary } from '../lib/bulk.ts';
import { type GroupRef, PLAN_PER_COMMAND, planCommands } from '../lib/selection-command.ts';

type Props<G extends GroupRef> = {
  /** The groups whose proposals would be accepted; null keeps the dialog closed. */
  groups: readonly G[] | null;
  onClose: () => void;
  /** File the groups the plan files at `floor`, each by its proposal. */
  onConfirm: (groups: G[], floor: MatchConfidence) => void;
};

/** The albums the plan names before the rest are summed up. */
const ALBUMS_SHOWN = 8;

const FLOORS: { value: MatchConfidence; label: string }[] = [
  { value: 'low', label: 'Every proposal' },
  { value: 'medium', label: 'Likely and sure' },
  { value: 'high', label: 'Only sure' },
];

const photos = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}`;
const groupsOf = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'group' : 'groups'}`;

/**
 * Enter over many groups: what accepting their proposals would do, read first with `staging
 * accept --dry-run` (50 groups a call) and summed by destination — each existing album with the
 * groups and photos it would get, the groups that would become new albums under their own names,
 * and those left as they are (changed meanwhile, without a proposal, or less sure than asked).
 * How sure a proposal must be is chosen here; nothing is filed until it is confirmed.
 */
export function BulkConfirmDialog<G extends GroupRef>({ groups, onClose, onConfirm }: Props<G>) {
  const [plan, setPlan] = useState<{ rows: StagingAcceptResult['plan']; changed: string[]; read: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [floor, setFloor] = useState<MatchConfidence>('low');

  useEffect(() => {
    if (!groups) return;
    const controller = new AbortController();
    setPlan({ rows: [], changed: [], read: 0 });
    setError(null);
    (async () => {
      let read = 0;
      const rows: StagingAcceptResult['plan'] = [];
      const changed: string[] = [];
      for (const command of planCommands(groups)) {
        const answer = await execCommand<StagingAcceptResult>(command, { signal: controller.signal });
        rows.push(...answer.plan);
        changed.push(...answer.skipped.filter((skip) => skip.reason === 'changed').map((skip) => skip.group));
        read = Math.min(groups.length, read + PLAN_PER_COMMAND);
        if (!controller.signal.aborted) setPlan({ rows: [...rows], changed: [...changed], read });
      }
      if (!controller.signal.aborted) setPlan({ rows, changed, read: groups.length });
    })().catch((value) => {
      if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value));
    });
    return () => controller.abort();
  }, [groups]);

  const total = groups?.length ?? 0;
  const ready = plan !== null && plan.read >= total && error === null;
  const summary = useMemo(() => plan ? acceptSummary(plan.rows, plan.changed, floor) : null, [plan, floor]);
  const filed = useMemo(() => {
    if (!groups || !summary) return [];
    const byPath = new Map(groups.map((group) => [group.path, group]));
    return summary.filed.map((path) => byPath.get(path)).filter((group): group is G => group !== undefined);
  }, [groups, summary]);
  const filedPhotos = filed.reduce((sum, group) => sum + (group.memberCount ?? 0), 0);
  const shownAlbums = summary?.existing.slice(0, ALBUMS_SHOWN) ?? [];
  const moreAlbums = (summary?.existing ?? []).slice(ALBUMS_SHOWN);

  return (
    <Dialog
      opened={groups !== null}
      onClose={onClose}
      title='Accept the proposals?'
      subtitle={`${groupsOf(total)} selected`}
      icon='checks'
      pattern='staging'
      size='md'
      floating
    >
      <Stack gap='sm'>
        {error && <Alert color='red' variant='light'>Couldn't read the plan: {error}</Alert>}
        {!ready && !error && (
          <Group gap='xs'>
            <Loader size='xs' />
            <Text size='sm' c='dimmed'>Reading what each group would get: {(plan?.read ?? 0).toLocaleString()} of {total.toLocaleString()}…</Text>
          </Group>
        )}
        {ready && summary && (
          <>
            <SegmentedControl size='xs' value={floor} onChange={(value) => setFloor(value as MatchConfidence)} data={FLOORS} />
            <Table withRowBorders={false} verticalSpacing={4} fz='sm'>
              <Table.Tbody>
                {shownAlbums.map((album) => (
                  <Table.Tr key={album.path}>
                    <Table.Td>
                      <Text size='sm' truncate title={album.path}>Into “{album.title}”</Text>
                    </Table.Td>
                    <Table.Td ta='right' c='dimmed'>{groupsOf(album.groups)} · {photos(album.files)}</Table.Td>
                  </Table.Tr>
                ))}
                {moreAlbums.length > 0 && (
                  <Table.Tr>
                    <Table.Td>Into {moreAlbums.length.toLocaleString()} more albums</Table.Td>
                    <Table.Td ta='right' c='dimmed'>
                      {groupsOf(moreAlbums.reduce((sum, album) => sum + album.groups, 0))} · {photos(moreAlbums.reduce((sum, album) => sum + album.files, 0))}
                    </Table.Td>
                  </Table.Tr>
                )}
                {summary.newAlbums.groups > 0 && (
                  <Table.Tr>
                    <Table.Td>New albums, each under its group's name</Table.Td>
                    <Table.Td ta='right' c='dimmed'>{groupsOf(summary.newAlbums.groups)} · {photos(summary.newAlbums.files)}</Table.Td>
                  </Table.Tr>
                )}
                {summary.matchedDays.groups > 0 && (
                  <Table.Tr>
                    <Table.Td>Everyday days into the albums they match; the rest stay</Table.Td>
                    <Table.Td ta='right' c='dimmed'>{groupsOf(summary.matchedDays.groups)} · {photos(summary.matchedDays.files)}</Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
            {summary.skipped.changed + summary.skipped.unsure + summary.skipped.none > 0 && (
              <Text size='xs' c='dimmed'>
                Left as they are: {[
                  summary.skipped.changed > 0 ? `${groupsOf(summary.skipped.changed)} changed since you looked` : '',
                  summary.skipped.unsure > 0 ? `${groupsOf(summary.skipped.unsure)} less sure than that` : '',
                  summary.skipped.none > 0 ? `${groupsOf(summary.skipped.none)} with no proposal` : '',
                ].filter(Boolean).join(', ')}.
              </Text>
            )}
            <Text size='xs' c='dimmed'>Filed 20 groups a call; once it is done, Undo all takes the whole of it back.</Text>
          </>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose}>Cancel</Button>
        <Button onClick={() => onConfirm(filed, floor)} disabled={!ready || filed.length === 0} data-autofocus>
          File {groupsOf(filed.length)}
          {filedPhotos > 0 ? ` · ${photos(filedPhotos)}` : ''}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
