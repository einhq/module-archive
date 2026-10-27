import { Alert, Badge, Box, Button, Center, Checkbox, Group, Loader, Paper, Slider, Stack, Switch, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { PersonEntry } from '../hooks/usePeople.ts';
import type { UnknownPeopleFaceChange, UnknownPerson } from '../hooks/useUnknownPeople.ts';
import { type PersonFace, usePersonFaces } from '../hooks/usePersonFaces.ts';
import { type PersonVoice, usePersonVoices } from '../hooks/usePersonVoices.ts';
import { type SubclusterKind, useSubclusters } from '../hooks/useSubclusters.ts';
import { cutAtSimilarity, cutIntoK, cutRange, groupsFrom } from '../lib/face-cut.ts';
import { stopClip } from '../lib/clip-player.ts';
import { useSelection } from '@ein/ui/hooks';
import { mediaItemFrom } from '@ein/ui/lib';
import { closeLightboxWithoutReturn, isLightboxOpen, type MediaItem, notify, openMediaAt } from '@ein/ui/signals';
import { Dialog, DialogActions, PageLoader, TablerIcon } from '@ein/ui/components';
import { type EvidenceChange, EvidenceSelectionBar } from './EvidenceSelectionBar.tsx';
import { FaceCrop } from './FaceCrop.tsx';
import { QuickName } from './QuickName.tsx';
import { VoiceTile } from './VoiceTile.tsx';

/** A face in the full grid, and in a group. */
const CROP_SIZE = 72;
const GROUP_CROP_SIZE = 56;

/**
 * Groups given a row of their own. A chained person only comes apart at a hundred groups or more,
 * and rows for all of them would be thousands of crops for a tail nobody acts on.
 */
const MAX_GROUPS = 30;

type Props = {
  /** The person to review; null closes the dialog. */
  person: UnknownPerson | null;
  /** People who already have a name, to add this one to or move some of it to. */
  named: PersonEntry[];
  onClose: () => void;
  /** Name the person and move them into /people. Returns the new path. */
  onName: (path: string, name: string) => Promise<string>;
  /** Fold the person into an existing one. */
  onMerge: (srcPath: string, dstPath: string) => Promise<void>;
  /** Say the person is not a person at all: everything they hold is unassigned and locked, and they go. */
  onDiscard: (path: string) => Promise<void>;
  /** Reconcile a successful face move, or refresh after a partial failure or a move of voices. */
  onFacesChanged?: (change: UnknownPeopleFaceChange | null) => void;
  /** This dialog is above an existing lightbox, so Escape closes this layer first. */
  overLightbox?: boolean;
};

/** The photos behind faces, in the order shown and without repeats, for the lightbox to walk. */
const photosOf = (faces: PersonFace[]): MediaItem[] => {
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const face of faces) {
    if (!face.filePath || seen.has(face.filePath)) continue;
    seen.add(face.filePath);
    // Faces only ever come from images, and the display derivative is already in the display
    // frame, so neither kind nor dimensions need asking for.
    items.push(mediaItemFrom({ path: face.filePath, type: 'photo' }));
  }
  return items;
};

type FaceTileProps = {
  face: PersonFace;
  size: number;
  picked: boolean;
  /** Something is picked, so a click on the crop picks too rather than opening its photo. */
  picking: boolean;
  onPick: (event: { shiftKey: boolean }) => void;
  onOpen: () => void;
};

/** One face: its crop opens the photo it was cut from, its box picks it. */
function FaceTile({ face, size, picked, picking, onPick, onOpen }: FaceTileProps) {
  return (
    <Box className='mrx-face-pick' data-selected={picked || undefined} style={{ position: 'relative' }}>
      <FaceCrop facePath={face.facePath} size={size} alt='' lazy title={face.filePath} selected={picked} onClick={(event) => picking ? onPick(event) : onOpen()} />
      <Box
        className='mrx-face-check'
        style={{ position: 'absolute', top: 0, left: 0 }}
        onClick={(event) => {
          event.stopPropagation();
          onPick(event);
        }}
      >
        <Checkbox
          checked={picked}
          readOnly
          size='xs'
          radius='xl'
          aria-label={`Pick the face from ${face.filePath ?? 'this photo'}`}
          styles={{ input: { cursor: 'pointer' } }}
        />
      </Box>
    </Box>
  );
}

/**
 * One kind of evidence sorted into groups by how alike it is, on asking: re-clustered on the server
 * once, cut in the browser wherever the slider says.
 */
function useGrouping<K extends SubclusterKind>(kind: K, personPath: string | null) {
  const [grouped, setGrouped] = useState(false);
  const [threshold, setThreshold] = useState<number | null>(null);
  const sub = useSubclusters(kind, grouped ? personPath : null);
  const range = useMemo(() => cutRange(sub.merges), [sub.merges]);
  useEffect(() => {
    setGrouped(false);
    setThreshold(null);
  }, [personPath]);
  // Open on the cut the clustering's own shape suggests: on two people fused, the join between them.
  useEffect(() => {
    if (sub.suggested !== null && threshold === null) setThreshold(sub.suggested);
  }, [sub.suggested, threshold]);
  const groups = useMemo(() => {
    if (!grouped || sub.items.length === 0) return [];
    return groupsFrom(threshold === null ? cutIntoK(sub.items.length, sub.merges, 1) : cutAtSimilarity(sub.items.length, sub.merges, threshold));
  }, [grouped, sub.items.length, sub.merges, threshold]);
  return { grouped, setGrouped, threshold, setThreshold, range, groups, sub };
}

type Grouping<K extends SubclusterKind> = ReturnType<typeof useGrouping<K>>;

/** The switch that sorts a section into groups. */
function GroupSwitch({ grouping }: { grouping: Grouping<SubclusterKind> }) {
  return <Switch size='sm' label='Adjust group threshold' checked={grouping.grouped} onChange={(event) => grouping.setGrouped(event.currentTarget.checked)} />;
}

type GroupsProps<T> = {
  grouping: {
    threshold: number | null;
    setThreshold: (value: number) => void;
    range: { min: number; max: number };
    groups: number[][];
    sub: { items: T[]; loading: boolean; error: Error | null };
  };
  loadingLabel: string;
  /** What one item is called, and many. */
  noun: [string, string];
  /** Why some items are in no group, when some are. */
  ungrouped: string | null;
  keyOf: (item: T) => string;
  selection: ReturnType<typeof useSelection>;
  /** One item's tile, shown among the members of its group. */
  tile: (item: T, members: T[]) => ReactNode;
};

/** A section's items in groups cut wherever the slider says; a group's box picks all of it. */
function Groups<T>({ grouping, loadingLabel, noun, ungrouped, keyOf, selection, tile }: GroupsProps<T>) {
  const { threshold, setThreshold, range, groups, sub: { items, loading, error } } = grouping;
  if (loading) return <PageLoader label={loadingLabel} />;
  if (error) return <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error.message}</Alert>;
  const count = (n: number) => `${n} ${n === 1 ? noun[0] : noun[1]}`;
  const shown = groups.slice(0, MAX_GROUPS);
  const tail = groups.slice(MAX_GROUPS);
  const tailItems = tail.reduce((sum, group) => sum + group.length, 0);
  return (
    <Stack gap='sm'>
      <Group align='center' gap='md' wrap='nowrap'>
        <Text size='sm' style={{ whiteSpace: 'nowrap' }}>How alike</Text>
        <Slider flex={1} min={range.min} max={range.max} step={0.001} value={threshold ?? range.min} onChange={setThreshold} label={(value) => value.toFixed(3)} />
        <Badge variant='light' style={{ whiteSpace: 'nowrap' }}>{groups.length} {groups.length === 1 ? 'group' : 'groups'}</Badge>
      </Group>
      {ungrouped && <Text size='xs' c='dimmed'>{ungrouped}</Text>}
      {shown.map((group, index) => {
        const members = group.map((member) => items[member]);
        const keys = members.map(keyOf);
        const all = keys.every((key) => selection.isSelected(key));
        const some = !all && keys.some((key) => selection.isSelected(key));
        return (
          <Paper key={`${threshold}-${index}`} p='xs' radius='md' bg='var(--mrx-surface-sunken)'>
            <Checkbox
              size='xs'
              mb={6}
              checked={all}
              indeterminate={some}
              onChange={() => selection.setKeys(keys, !all)}
              label={`${index === 0 ? 'Largest group' : `Group ${index + 1}`} · ${count(group.length)}`}
            />
            <Group gap={4}>{members.map((item) => tile(item, members))}</Group>
          </Paper>
        );
      })}
      {tail.length > 0 && (
        <Text size='xs' c='dimmed' ta='center'>
          {tail.length} smaller {tail.length === 1 ? 'group' : 'groups'} ({count(tailItems)}) are not shown. Move the slider left to bring them up here.
        </Text>
      )}
    </Stack>
  );
}

/**
 * One unidentified person, all of them: who they are at the top, then every face and every
 * recording they are heard in, each one pickable, and what to do with the picked ones at the foot —
 * split them off as someone new, move them to someone, or say they are not a person.
 *
 * The overview shows four glimpses, which is a preview and not evidence — recognition can fuse two
 * people on a single weak edge, and four thumbnails will never show it. So the evidence is all here,
 * and where two people are fused, "Adjust group threshold" re-clusters the faces, or the voices,
 * against each other (`subcluster-faces`, `subcluster-voices`, once) and lays them out in groups cut
 * wherever the slider says; a group's box picks all of it, for the same actions. One box names the person: a new name names them,
 * someone already named takes them in. Beside it, "Not a person" discards the whole cluster, however
 * many of its faces are loaded.
 */
export function UnknownPersonModal({ person, named, onClose, onName, onMerge, onDiscard, onFacesChanged, overLightbox = false }: Props) {
  const personPath = person?.path ?? null;
  const { faces, total, loading, loadingMore, hasMore, loadMore, error, refetch, removeFaces } = usePersonFaces(personPath);
  const { voices, total: voiceTotal, loading: voicesLoading, refetch: refetchVoices, removeVoices } = usePersonVoices(personPath);
  /** A confirm dialog inside the bar below owns Escape while it is up, and so does this one's. */
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);

  const faceGroups = useGrouping('faces', personPath);
  const voiceGroups = useGrouping('voices', personPath);

  // Picking runs over every face on show (all of them grouped, the loaded pages otherwise) and
  // every recording on show; the same face or recording is the same pick in either view.
  const shownFaces = faceGroups.grouped ? faceGroups.sub.items : faces;
  const shownVoices = voiceGroups.grouped ? voiceGroups.sub.items : voices;
  const keys = useMemo(() => [...shownFaces.map((face) => face.facePath), ...shownVoices.map((voice) => voice.voicePath)], [shownFaces, shownVoices]);
  const selection = useSelection(keys);
  const pickedFaces = useMemo(() => shownFaces.filter((face) => selection.selected.has(face.facePath)), [shownFaces, selection.selected]);
  const pickedVoices = useMemo(() => shownVoices.filter((voice) => selection.selected.has(voice.voicePath)), [shownVoices, selection.selected]);
  const pick = (key: string, event: { shiftKey: boolean }) => selection.toggle(key, { range: event.shiftKey, additive: true });

  const close = () => {
    selection.clear();
    stopClip();
    onClose();
  };

  /** Open a face's photo, the lightbox walking the faces it was shown among — a group, or all. */
  const openPhoto = (among: PersonFace[], filePath?: string) => {
    const photos = photosOf(among);
    const index = photos.findIndex((item) => item.path === filePath);
    if (index < 0) return;
    // Over the lightbox, the lightbox is the photo layer: this dialog goes before its list changes.
    if (overLightbox) close();
    openMediaAt(index, photos);
  };

  const openRecording = (filePath: string, atSeconds: number) => {
    stopClip();
    if (overLightbox) close();
    // `atSeconds` is what the lightbox seeks to on load, as a moment-level search hit does.
    openMediaAt(0, [mediaItemFrom({ path: filePath, atSeconds })]);
  };

  /**
   * Escape, in the order the reviewer means it: the photo on top of everything, then what is
   * picked, then the dialog itself.
   *
   * A window capture listener, because several listeners answer Escape (this dialog's own
   * `closeOnEscape`, the lightbox's `useHotkeys`, the lightbox modal's) and one press would
   * otherwise close both, throwing away the photo *and* the review it was opened to settle. Window
   * is the outermost target in the capture path; a document-capture listener runs after Mantine's
   * own window ones. Not installed while a confirm dialog of the bar below is up: Mantine's
   * `closeOnEscape` closes that one alone.
   */
  const onEscapeRef = useRef(() => {});
  onEscapeRef.current = () => {
    if (overLightbox) close();
    else if (isLightboxOpen.value) closeLightboxWithoutReturn();
    else if (selection.active) selection.clear();
    else close();
  };
  const confirmOpen = confirming || discarding;
  useEffect(() => {
    if (!person || confirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscapeRef.current();
    };
    globalThis.addEventListener('keydown', onKeyDown, true);
    return () => globalThis.removeEventListener('keydown', onKeyDown, true);
  }, [person, confirmOpen, overLightbox]);

  // Mantine's own hotkeys ignore text fields, so this stays out of the name box.
  useHotkeys([['mod+A', () => person && !confirmOpen && !isLightboxOpen.value && selection.selectAll()]]);

  useEffect(() => stopClip, []);

  const faceCount = total || person?.faceCount || 0;
  const voiceCount = voiceTotal || person?.voiceCount || 0;
  const allVoicesPicked = shownVoices.length > 0 && shownVoices.every((voice) => selection.isSelected(voice.voicePath));

  const discard = async () => {
    if (!person) return;
    setDiscarding(false);
    setDiscardBusy(true);
    try {
      await onDiscard(person.path);
      notify({ message: `${person.name} is not a person: removed`, color: 'green' });
      close();
    } catch (err) {
      notify({ message: err instanceof Error ? err.message : String(err), color: 'red' });
    } finally {
      setDiscardBusy(false);
    }
  };
  /** "All 8 faces and the recording", for the confirm: what loses its identity. */
  const held = [
    ...(faceCount > 0 ? [faceCount === 1 ? 'the face' : `all ${faceCount} faces`] : []),
    ...(voiceCount > 0 ? [voiceCount === 1 ? 'the recording' : `all ${voiceCount} recordings`] : []),
  ].join(' and ');
  const heldOne = faceCount + voiceCount === 1;

  const applyChange = (change: EvidenceChange | null) => {
    if (!person) return;
    if (!change) {
      // A chunked command can fail after moving some. The exact subset is unknown, so everything
      // is read again without unmounting.
      refetch();
      refetchVoices();
      if (faceGroups.grouped) faceGroups.sub.refetch();
      if (voiceGroups.grouped) voiceGroups.sub.refetch();
      onFacesChanged?.(null);
      return;
    }
    const removedFaces = change.removedFaces.map((face) => face.facePath);
    const removedVoices = change.removedVoices.map((voice) => voice.voicePath);
    const removed = new Set(removedFaces);
    removeFaces(removedFaces);
    removeVoices(removedVoices);
    selection.remove([...removedFaces, ...removedVoices]);
    // The groups were cut from the faces and voices as they were.
    if (faceGroups.grouped && removedFaces.length > 0) faceGroups.sub.refetch();
    if (voiceGroups.grouped && removedVoices.length > 0) voiceGroups.sub.refetch();
    // The overview's cards carry voices it cannot work out from here; it reads them again.
    if (removedVoices.length > 0) return onFacesChanged?.(null);
    onFacesChanged?.({
      sourcePath: person.path,
      remainingFaces: faces.filter((face) => !removed.has(face.facePath)),
      remainingCount: Math.max(0, total - removed.size),
      created: change.created,
    });
  };

  const faceTile = (face: PersonFace, size: number, among: PersonFace[]) => (
    <FaceTile
      key={face.facePath}
      face={face}
      size={size}
      picked={selection.isSelected(face.facePath)}
      picking={selection.active}
      onPick={(event) => pick(face.facePath, event)}
      onOpen={() => openPhoto(among, face.filePath)}
    />
  );

  const voiceTile = (voice: PersonVoice) => (
    <VoiceTile
      key={voice.voicePath}
      voice={voice}
      picked={selection.isSelected(voice.voicePath)}
      onPick={(event) => pick(voice.voicePath, event)}
      onOpen={voice.filePath ? () => openRecording(voice.filePath!, voice.start) : undefined}
    />
  );

  return (
    <Dialog
      opened={!!person}
      onClose={close}
      title={person?.name}
      icon='user-question'
      pattern='person'
      aside={
        <>
          {faceCount > 0 && <Badge variant='light'>{faceCount} {faceCount === 1 ? 'face' : 'faces'}</Badge>}
          {voiceCount > 0 && (
            <Badge variant='light' leftSection={<TablerIcon name='microphone' size={12} />}>
              heard in {voiceCount}
            </Badge>
          )}
        </>
      }
      size='min(1200px, 96vw)'
      // Handled above instead, so the lightbox and the picks can have it first.
      closeOnEscape={false}
    >
      <Stack gap='lg'>
        {person && (
          <Group align='flex-end' gap='xs' wrap='nowrap'>
            <Box flex={1}>
              <QuickName form path={person.path} named={named} onName={onName} onMerge={onMerge} onDone={close} />
            </Box>
            <Button
              variant='light'
              color='orange'
              leftSection={<TablerIcon name='user-x' size={16} />}
              onClick={() => setDiscarding(true)}
              loading={discardBusy}
              style={{ flexShrink: 0 }}
            >
              Not a person
            </Button>
          </Group>
        )}

        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error.message}</Alert>}

        {faceCount > 0 && (
          <Stack gap='xs'>
            <Group justify='space-between' align='center'>
              <Text size='sm' fw={600}>
                Faces
                <Text component='span' size='xs' c='dimmed' ml={6}>{faceCount}</Text>
              </Text>
              {faceCount >= 3 && <GroupSwitch grouping={faceGroups} />}
            </Group>

            {!faceGroups.grouped && (loading ? <PageLoader label='Loading faces…' /> : (
              <>
                <Group gap='xs'>{faces.map((face) => faceTile(face, CROP_SIZE, faces))}</Group>
                {hasMore && (
                  <Center>
                    <Button size='xs' variant='subtle' onClick={loadMore} loading={loadingMore}>
                      Load more ({faces.length} of {total})
                    </Button>
                  </Center>
                )}
              </>
            ))}

            {faceGroups.grouped && (
              <Groups
                grouping={faceGroups}
                loadingLabel='Comparing every face against every other'
                noun={['face', 'faces']}
                ungrouped={faceGroups.sub.withoutVector > 0
                  ? `${faceGroups.sub.withoutVector} hand-drawn ${faceGroups.sub.withoutVector === 1 ? 'tag has' : 'tags have'} no vector to compare, and ${
                    faceGroups.sub.withoutVector === 1 ? 'is' : 'are'
                  } in no group.`
                  : null}
                keyOf={(face) => face.facePath}
                selection={selection}
                tile={(face, members) => faceTile(face, GROUP_CROP_SIZE, members)}
              />
            )}
          </Stack>
        )}

        {voiceCount > 0 && (
          <Stack gap='xs'>
            <Group justify='space-between' align='center'>
              <Text size='sm' fw={600}>
                Voice
                <Text component='span' size='xs' c='dimmed' ml={6}>heard in {voiceCount} {voiceCount === 1 ? 'recording' : 'recordings'}</Text>
              </Text>
              <Group gap='md'>
                {shownVoices.length > 1 && (
                  <Button
                    size='compact-xs'
                    variant='subtle'
                    onClick={() => selection.setKeys(shownVoices.map((voice) => voice.voicePath), !allVoicesPicked)}
                  >
                    {allVoicesPicked ? 'Unpick all' : 'Pick all'}
                  </Button>
                )}
                {voiceCount >= 3 && <GroupSwitch grouping={voiceGroups} />}
              </Group>
            </Group>
            {voiceGroups.grouped
              ? (
                <Groups
                  grouping={voiceGroups}
                  loadingLabel='Comparing every voice against every other'
                  noun={['recording', 'recordings']}
                  ungrouped={voiceGroups.sub.withoutVector > 0
                    ? `${voiceGroups.sub.withoutVector} ${voiceGroups.sub.withoutVector === 1 ? 'recording has' : 'recordings have'} no voiceprint to compare, and ${
                      voiceGroups.sub.withoutVector === 1 ? 'is' : 'are'
                    } in no group.`
                    : null}
                  keyOf={(voice) => voice.voicePath}
                  selection={selection}
                  tile={voiceTile}
                />
              )
              : voicesLoading
              ? (
                <Center py='lg'>
                  <Loader size='sm' />
                </Center>
              )
              : <Group gap='xs'>{voices.map(voiceTile)}</Group>}
          </Stack>
        )}

        {
          /* At the foot of the dialog's scroll, so it stays in reach however far down the picks go. */
        }
        <Box style={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
          <EvidenceSelectionBar
            faces={pickedFaces}
            voices={pickedVoices}
            total={faceCount + voiceCount}
            named={named}
            onClear={selection.clear}
            onDialog={setConfirming}
            onDetached={applyChange}
            onDiscard={() => setDiscarding(true)}
          />
        </Box>
      </Stack>

      <Dialog opened={discarding} onClose={() => setDiscarding(false)} title='Not a person?' icon='user-x' pattern='person' size='md' floating zIndex={300}>
        <Text size='sm'>
          {held &&
            `${held[0].toUpperCase()}${held.slice(1)} ${heldOne ? 'loses its identity and is' : 'lose their identity and are'} locked, so recognition leaves ${
              heldOne ? 'it' : 'them'
            } alone from now on. `}
          <b>{person?.name}</b> is removed. The photos and recordings themselves are untouched.
        </Text>
        <DialogActions>
          <Button variant='default' onClick={() => setDiscarding(false)}>Cancel</Button>
          <Button color='orange' onClick={discard}>Not a person</Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
