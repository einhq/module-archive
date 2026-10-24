import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { Alert, Button, Radio, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { execCommand } from '@ein/ui/signals';
import { shq } from '@ein/ui/lib';
import type { FamilyNode } from '@archive/people/api';

type RemoveRelationModalProps = {
  /** The person whose ties are being cut, or null while closed. */
  subject: FamilyNode | null;
  /** Everyone drawn, so a tie can be named rather than shown as a path. */
  nodes: Record<string, FamilyNode>;
  onClose: () => void;
  onApplied: () => void;
};

type Tie = { path: string; label: string };

/**
 * Cut one tie.
 *
 * `person-remove` takes two people and removes whatever relation is between
 * them, in both directions — so the choice here is only *who*, never which side.
 * Ties to people outside the drawing are not offered: the whole graph is not
 * loaded, and a list that silently omitted half of them would be worse than one
 * that says what it covers.
 */
export function RemoveRelationModal({ subject, nodes, onClose, onApplied }: RemoveRelationModalProps) {
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPick(null);
    setError(null);
  }, [subject]);

  const name = (path: string): string => nodes[path]?.name ?? path.split('/').pop() ?? path;

  const ties: Tie[] = subject
    ? [
      ...subject.parents.map((path) => ({ path, label: `${name(path)} — parent` })),
      ...subject.partners.map((partner) => ({ path: partner.path, label: `${name(partner.path)} — partner` })),
      ...subject.children.map((path) => ({ path, label: `${name(path)} — child` })),
    ].filter((tie) => nodes[tie.path])
    : [];

  const submit = async () => {
    if (!subject || !pick) return;
    setBusy(true);
    setError(null);
    try {
      await execCommand(`person-remove ${shq(subject.path)} ${shq(pick)}`);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog opened={subject !== null} onClose={onClose} title='Remove a relation' subtitle={`Of ${subject?.name ?? ''}`} icon='link-off' pattern='person' size='md' floating>
      <Stack gap='md'>
        {ties.length === 0 ? <Text size='sm' c='dimmed'>Nothing to remove — no relations of theirs are on screen.</Text> : (
          <>
            <Text size='sm' c='dimmed'>
              The tie goes both ways, so this removes it from both people. Neither person is deleted.
            </Text>
            <Radio.Group value={pick} onChange={setPick}>
              <Stack gap='xs'>
                {ties.map((tie) => <Radio key={`${tie.path}-${tie.label}`} value={tie.path} label={tie.label} />)}
              </Stack>
            </Radio.Group>
          </>
        )}

        {error && (
          <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />} variant='light'>
            {error}
          </Alert>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button color='red' onClick={submit} loading={busy} disabled={!pick}>Remove</Button>
      </DialogActions>
    </Dialog>
  );
}
