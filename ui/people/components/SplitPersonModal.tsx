import { Alert, Badge, Button, Group, Paper, SegmentedControl, Slider, Stack, Text } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PersonEntry } from '../hooks/usePeople.ts';
import { useSubclusters } from '../hooks/useSubclusters.ts';
import { cutAtSimilarity, cutIntoK, cutRange, groupsFrom } from '../lib/face-cut.ts';
import { closeLightboxWithoutReturn, execCommand, isLightboxOpen, MediaItem, openMediaAt } from '@ein/ui/signals';
import { mediaItemFrom } from '@ein/ui/lib';
import { type DetachDestination, detachFromPerson } from '../lib/person-detach.ts';
import type { AppliedFaceChange } from '../lib/face-change.ts';
import { Dialog, DialogActions, PageLoader, TablerIcon } from '@ein/ui/components';
import { EntityPicker, personOptions } from '../../components/EntityPicker.tsx';
import { FaceCrop } from './FaceCrop.tsx';

const CROP_SIZE = 56;

/** Crops shown per group before it collapses behind a count. */
const PREVIEW_CROPS = 24;

/**
 * Groups given their own card. A chained person only comes apart at a hundred
 * groups or more, and rendering all of them would be thousands of crops for a
 * tail nobody acts on. The rest are counted, kept, and left alone.
 */
const MAX_CARDS = 30;

/** What the reviewer has decided to do with one group. */
type Action = 'keep' | 'split' | 'discard' | 'merge';

type Props = {
  /** The person to take apart; null closes the modal. */
  personPath: string | null;
  personName: string;
  /** People who already have a name, as merge targets for a group. */
  named: PersonEntry[];
  onClose: () => void;
  /** A successful local change, or null when a partial failure needs a refresh. */
  onApplied: (change: AppliedFaceChange | null) => void;
};

/**
 * Re-cluster one person's faces and take the wrong ones off them.
 *
 * Clustering fuses two people on a single weak edge and the popup next door can
 * only *show* that. This is the repair: `subcluster-faces` re-clusters the same
 * faces with average linkage, and the reviewer cuts the result where the two
 * people actually part. The cut happens in the browser, so the slider is free —
 * the server is asked once, when the modal opens.
 *
 * Every group defaults to `keep`. A strict threshold can produce two hundred
 * groups, and defaulting those to "split off" would mint two hundred people on
 * one click.
 */
export function SplitPersonModal({ personPath, personName, named, onClose, onApplied }: Props) {
  const { faces, merges, suggested, withoutVector, loading, error } = useSubclusters(personPath);

  const [threshold, setThreshold] = useState<number | null>(null);
  const [actions, setActions] = useState<Record<number, Action>>({});
  const [mergeTargets, setMergeTargets] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const range = useMemo(() => cutRange(merges), [merges]);

  // Open on the cut the dendrogram's own shape suggests — the largest gap in
  // the top merges, which on a fused person is the join between the two people.
  // A fixed starting value would be wrong for everyone: the useful similarities
  // depend entirely on how alike this person's crops happen to be.
  useEffect(() => {
    if (suggested !== null && threshold === null) setThreshold(suggested);
  }, [suggested, threshold]);

  const allGroups = useMemo(() => {
    if (faces.length === 0) return [];
    if (threshold === null) return groupsFrom(cutIntoK(faces.length, merges, 1));
    return groupsFrom(cutAtSimilarity(faces.length, merges, threshold));
  }, [faces.length, merges, threshold]);

  // Only the cards get actions; the tail is kept as it is. Groups arrive
  // largest-first, so what is dropped here is always the smallest.
  const groups = useMemo(() => allGroups.slice(0, MAX_CARDS), [allGroups]);
  const tail = useMemo(() => allGroups.slice(MAX_CARDS), [allGroups]);
  const tailFaces = tail.reduce((sum, g) => sum + g.length, 0);

  // A cut renumbers everything, so decisions made against the previous one are
  // meaningless. Clearing them is the honest move: silently re-applying an
  // action to a group that now holds different faces is how you lose a person.
  useEffect(() => {
    setActions({});
    setMergeTargets({});
    setExpanded({});
  }, [groups.length, threshold]);

  const actionOf = (index: number): Action => actions[index] ?? 'keep';
  const setAction = (index: number, action: Action) => setActions((prev) => ({ ...prev, [index]: action }));

  /**
   * Open the photo a crop was cut from, with the lightbox's arrows walking that
   * *group* rather than the whole person.
   *
   * A crop is 56 pixels of a face and the question here is whether a group is
   * somebody else — which is often only answerable from the photo. Scoping the
   * walk to the group is what makes it a way to check the group: flick through
   * and see whether the same person keeps turning up.
   */
  const openPhoto = (group: number[], face: number) => {
    const seen = new Set<string>();
    const items: MediaItem[] = [];
    for (const member of group) {
      const path = faces[member].filePath;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      // Faces only come from images, and the display derivative is already in
      // the display frame, so neither kind nor dimensions need asking for.
      items.push(mediaItemFrom({ path, type: 'photo' }));
    }
    const index = items.findIndex((item) => item.path === faces[face].filePath);
    if (index >= 0) openMediaAt(index, items);
  };

  /** A group of one is nobody: it can stay or go, but it cannot become a person. */
  const isSingleton = (group: number[]) => group.length === 1;

  const kept = groups.filter((_, i) => actionOf(i) === 'keep');
  const leaving = groups.filter((_, i) => actionOf(i) !== 'keep');
  const keptFaces = kept.reduce((sum, g) => sum + g.length, 0) + tailFaces;
  const splitGroups = groups.filter((_, i) => actionOf(i) === 'split').length;
  const mergeGroups = groups.filter((_, i) => actionOf(i) === 'merge').length;
  const discardFaces = groups.filter((_, i) => actionOf(i) === 'discard').reduce((sum, g) => sum + g.length, 0);

  const incomplete = groups.some((_, i) => actionOf(i) === 'merge' && !mergeTargets[i]);
  const canApply = leaving.length > 0 && keptFaces > 0 && !incomplete;

  const close = () => {
    setThreshold(null);
    setActions({});
    setMergeTargets({});
    setExpanded({});
    setActionError(null);
    onClose();
  };

  /**
   * Escape belongs to the lightbox while it is up.
   *
   * Several listeners answer Escape (this modal's, the lightbox's `useHotkeys`,
   * the lightbox modal's own `closeOnEscape`), so checking a signal and returning
   * early would let one press close *both* dialogs and throw away every group
   * decision made so far. This consumes the event instead: when the lightbox is
   * up it closes only the lightbox and stops the key there.
   *
   * **On `window`, capture phase** — not `document`. Window is the outermost
   * target in the capture path; a document-capture listener runs after
   * Mantine's window ones, too late to stop them.
   *
   * `closeOnEscape` is off on the modal below for a related reason: reading a
   * signal during render does not subscribe React to it, so that prop would hold
   * whatever was true at the last render.
   */
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!personPath) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isLightboxOpen.value) closeLightboxWithoutReturn();
      else closeRef.current();
    };
    globalThis.addEventListener('keydown', onKeyDown, true);
    return () => globalThis.removeEventListener('keydown', onKeyDown, true);
  }, [personPath]);

  const splitOffAllButLargest = () => {
    // Groups arrive largest-first, so this is "everything except the first".
    const next: Record<number, Action> = {};
    for (let i = 1; i < groups.length; i++) next[i] = isSingleton(groups[i]) ? 'discard' : 'split';
    setActions(next);
  };

  /** What one group's action means to `person-detach`. */
  const destinationOf = (action: Action, target?: string): DetachDestination => {
    if (action === 'discard') return { kind: 'unassign' };
    if (action !== 'merge') return { kind: 'new-person' };
    // `canApply` blocks this, so reaching it means the guard is gone.
    if (!target) throw new Error('no person picked for the merged group');
    return { kind: 'person', path: target };
  };

  /** Move one group's faces, minting at most one person for it. */
  const applyGroup = (group: number[], action: Action, target?: string) => detachFromPerson(execCommand, group.map((i) => faces[i].facePath), destinationOf(action, target));

  const apply = async () => {
    setActionError(null);
    setBusy(true);
    try {
      const removedFaces: AppliedFaceChange['removedFaces'] = [];
      const created: AppliedFaceChange['created'] = [];
      for (const [index, group] of groups.entries()) {
        const action = actionOf(index);
        if (action === 'keep') continue;
        const moved = group.map((member) => faces[member]);
        const target = await applyGroup(group, action, mergeTargets[index]);
        removedFaces.push(...moved);
        if (action === 'split') {
          if (!target?.id || !target.name) throw new Error('person-detach did not report the new person details');
          created.push({ person: { id: target.id, path: target.path, name: target.name }, faces: moved });
        }
      }
      close();
      onApplied({ removedFaces, created });
    } catch (err) {
      // A partial batch throws with some groups already moved, so the caller
      // refetches either way — the list has to tell the truth.
      setActionError(err instanceof Error ? err.message : String(err));
      onApplied(null);
    } finally {
      setBusy(false);
    }
  };

  const summary = () => {
    const parts = [`${keptFaces} ${keptFaces === 1 ? 'face stays' : 'faces stay'}`];
    if (splitGroups > 0) parts.push(`${splitGroups} new unidentified ${splitGroups === 1 ? 'person' : 'people'}`);
    if (mergeGroups > 0) parts.push(`${mergeGroups} ${mergeGroups === 1 ? 'group' : 'groups'} merged into someone`);
    if (discardFaces > 0) parts.push(`${discardFaces} unassigned and locked`);
    return parts.join(' · ');
  };

  return (
    <Dialog
      opened={!!personPath}
      onClose={close}
      title={`Split ${personName}`}
      icon='cut'
      pattern='person'
      size='xl'
      // Handled above instead, so the lightbox can keep Escape for itself.
      closeOnEscape={false}
    >
      <Stack gap='md'>
        <Text size='sm' c='dimmed'>
          These faces re-clustered against each other, more strictly than the pass that grouped them. Drag the slider until the people come apart, then say what happens to
          each group. Click a face to see the photo it came from — the arrows then walk that group.
        </Text>

        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error.message}</Alert>}
        {withoutVector > 0 && (
          <Alert color='yellow' variant='light'>
            {withoutVector} {withoutVector === 1 ? 'face has' : 'faces have'} no embedding (a hand-drawn tag) and stay where they are.
          </Alert>
        )}

        {loading ? <PageLoader label='Comparing every face against every other' /> : faces.length < 2 ? <Text size='sm'>Not enough faces to split.</Text> : (
          <>
            <Group align='center' gap='md' wrap='nowrap'>
              <Text size='sm' fw={500} style={{ whiteSpace: 'nowrap' }}>Similarity</Text>
              <Slider
                flex={1}
                min={range.min}
                max={range.max}
                step={0.001}
                value={threshold ?? range.min}
                onChange={setThreshold}
                label={(v) => v.toFixed(3)}
              />
              <Badge variant='light' style={{ whiteSpace: 'nowrap' }}>{allGroups.length} groups</Badge>
            </Group>

            <Group gap='xs'>
              <Button size='xs' variant='default' onClick={() => setThreshold(range.min)} disabled={busy}>
                One group
              </Button>
              <Button
                size='xs'
                variant='default'
                onClick={() => {
                  // The two-people case, which is what a bad merge usually is:
                  // undo the final join and nothing else.
                  const last = merges[merges.length - 1];
                  if (last) setThreshold(Math.min(range.max, last[2] + 0.0005));
                }}
                disabled={busy || merges.length === 0}
              >
                Split in two
              </Button>
              <Button
                size='xs'
                variant='default'
                onClick={() => suggested !== null && setThreshold(suggested)}
                disabled={busy || suggested === null}
              >
                Suggested
              </Button>
              <Button size='xs' variant='default' onClick={splitOffAllButLargest} disabled={busy || groups.length < 2}>
                Split off all but the largest
              </Button>
            </Group>

            <Stack gap='sm'>
              {groups.map((group, index) => {
                const action = actionOf(index);
                const showAll = expanded[index];
                const shown = showAll ? group : group.slice(0, PREVIEW_CROPS);
                return (
                  <Paper
                    key={`${threshold}-${index}`}
                    p='xs'
                    radius='sm'
                    bg={action === 'keep' ? 'var(--mrx-surface-sunken)' : 'var(--mrx-surface-overlay)'}
                  >
                    <Stack gap='xs'>
                      <Group justify='space-between' wrap='nowrap'>
                        <Group gap='xs'>
                          <Text size='sm' fw={500}>{index === 0 ? 'Largest group' : `Group ${index + 1}`}</Text>
                          <Badge size='sm' variant='light'>{group.length} {group.length === 1 ? 'face' : 'faces'}</Badge>
                        </Group>
                        <SegmentedControl
                          size='xs'
                          value={action}
                          onChange={(value) => setAction(index, value as Action)}
                          disabled={busy}
                          data={[
                            { value: 'keep', label: 'Keep' },
                            // A group of one is noise, not a person — offering
                            // "split off" would fabricate one out of it.
                            ...(isSingleton(group) ? [] : [{ value: 'split', label: 'Split off' }]),
                            { value: 'merge', label: 'Merge into…' },
                            { value: 'discard', label: 'Not a person' },
                          ]}
                        />
                      </Group>

                      {action === 'merge' && (
                        <EntityPicker
                          kind='person'
                          size='xs'
                          value={mergeTargets[index] ?? null}
                          onChange={(value) => setMergeTargets((prev) => ({ ...prev, [index]: value ?? '' }))}
                          data={personOptions(named)}
                        />
                      )}

                      <Group gap={4}>
                        {shown.map((face) => (
                          <FaceCrop
                            key={faces[face].facePath}
                            facePath={faces[face].facePath}
                            size={CROP_SIZE}
                            alt=''
                            title={faces[face].filePath}
                            onClick={faces[face].filePath ? () => openPhoto(group, face) : undefined}
                            // Thirty groups of crops is hundreds of requests
                            // for rows nobody has scrolled to.
                            lazy
                          />
                        ))}
                        {group.length > PREVIEW_CROPS && (
                          <Button
                            size='compact-xs'
                            variant='subtle'
                            onClick={() => setExpanded((prev) => ({ ...prev, [index]: !showAll }))}
                          >
                            {showAll ? 'show fewer' : `+${group.length - PREVIEW_CROPS} more`}
                          </Button>
                        )}
                      </Group>
                    </Stack>
                  </Paper>
                );
              })}

              {tail.length > 0 && (
                <Text size='xs' c='dimmed' ta='center' py='xs'>
                  {tail.length} smaller {tail.length === 1 ? 'group' : 'groups'} ({tailFaces}{' '}
                  {tailFaces === 1 ? 'face' : 'faces'}) stay as they are. Loosen the slider to bring them up here.
                </Text>
              )}
            </Stack>
          </>
        )}

        {actionError && <Alert color='red'>{actionError}</Alert>}
      </Stack>
      <DialogActions
        hint={leaving.length === 0
          ? 'Nothing marked to leave.'
          : keptFaces === 0
          ? 'At least one group has to stay — moving all of them is a rename, not a split.'
          : incomplete
          ? 'Pick who the merged group belongs to.'
          : summary()}
      >
        <Button variant='default' onClick={close} disabled={busy}>Cancel</Button>
        <Button onClick={apply} loading={busy} disabled={!canApply}>
          Apply to {leaving.length} {leaving.length === 1 ? 'group' : 'groups'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
