/**
 * Face boxes drawn over the lightbox image.
 *
 * Boxes are fractions of the display frame, which is exactly what every derivative rendition
 * renders — so no dimensions are needed to place them. The catch is
 * `objectFit: contain`: the rendered picture is smaller than the element that holds it, and a
 * percentage against the element box would put every face in the wrong place. The rendered
 * content rect is therefore measured from the media's intrinsic size and the overlay is
 * positioned on *that*, recomputed whenever either can change.
 *
 * Every detected face is drawn, named or not: an unnamed one is the prompt to go and name
 * someone. Nothing is painted until a face is hovered, though — boxes standing over every
 * face are permanent clutter on the photo. They stay as invisible hit targets, and hovering
 * one (or a name in the sidebar) fades in that one alone; `pinned` keeps them all up, which
 * is also how they are reachable without a pointer.
 */

import { TablerIcon } from '@ein/ui/components';
import { ActionIcon, Box, Button, Group, Popover, TextInput } from '@mantine/core';
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { useContentRect } from '../hooks/useContentRect.ts';
import type { FaceBox, MediaFace } from '../hooks/useMediaDetails.ts';
import { type DrawPoint, editFaceBox, type FaceBoxEdit, faceBoxFromDrag, sameFaceBox } from '../lib/face-draw.ts';

/** What the overlay needs about one face, whoever it belongs to. */
type FaceMark = {
  key: string;
  facePath: string;
  box: FaceBox;
  label: string;
  /** Person node path — present for a named face, absent for an unidentified one. */
  personPath?: string;
  personId?: string;
  personHoverKey?: string;
  named: boolean;
  /** A detected face that takes part in recognition; false for a tag (drawn dashed). */
  hasFace: boolean;
};

/** What a dashed box is, for its tooltip. */
const TAG_TITLE = 'Tag: a box with a name, not used to recognise faces';

type FaceOverlayProps = {
  /** The <img> or <video> the boxes belong over. */
  mediaRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  faces: FaceMark[];
  /** Draw the boxes even when nothing is hovered — the toolbar/`f` toggle. */
  pinned: boolean;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
  /** Navigate to a person's page; given the route, the same one the sidebar's names use. */
  onOpenPerson: (route: string) => void;
  onNamePerson: (personPath: string, name: string) => Promise<void>;
  /** Slideshow mode keeps pinned names but removes boxes and interactions. */
  labelsOnly?: boolean;
  /** Mirror the slideshow image motion so labels stay attached to faces. */
  motionClassName?: string;
  motionRunning?: boolean;
  /**
   * The lightbox zoom the overlay's parent is scaled by. The boxes are fractions of the
   * picture so they follow for free; borders, labels and handles are counter-scaled so a
   * 2px outline does not become a 10px one, and pointer positions are read back in layout
   * pixels, which is what the face-draw arithmetic and `rect` are in.
   */
  scale?: number;
  /** Desktop edit mode: the whole rendered picture becomes a drag surface. */
  drawing?: boolean;
  saving?: boolean;
  onCreateFace?: (box: FaceBox) => Promise<void>;
  onUpdateFace?: (facePath: string, box: FaceBox) => Promise<void>;
  onRemoveFace?: (facePath: string) => Promise<void>;
  /** Edit mode: ask who the selected face is. */
  onChangePerson?: (facePath: string) => void;
  onDraftChange?: (ready: boolean) => void;
};

/** The per-face response flattened into the one shape the overlay draws. */
export function toFaceMarks(mediaFaces: MediaFace[]): FaceMark[] {
  return mediaFaces.map((face) => ({
    key: face.unnamed ? `u-${face.faceId}` : `f-${face.faceId}`,
    facePath: face.facePath,
    box: face.faceBox,
    label: face.personName ?? 'Unassigned',
    personPath: face.personPath,
    personId: face.personId,
    personHoverKey: face.personPath ? faceKeyForPerson(face.personPath) : undefined,
    named: Boolean(face.personName && !face.unnamed),
    hasFace: face.hasFace,
  }));
}

function NameFacePopover({ mark, onName, children }: { mark: FaceMark; onName: (name: string) => Promise<void>; children: React.ReactNode }) {
  const [opened, setOpened] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await onName(value.trim());
      setOpened(false);
      setValue('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover opened={opened} onChange={setOpened} position='bottom' withArrow shadow='md' trapFocus>
      <Popover.Target>
        <Box onClick={() => setOpened((o) => !o)} style={{ width: '100%', height: '100%', cursor: 'pointer' }}>
          {children}
        </Box>
      </Popover.Target>
      <Popover.Dropdown p='xs'>
        <Group gap='xs' wrap='nowrap'>
          <TextInput
            size='xs'
            placeholder='Who is this?'
            value={value}
            autoFocus
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <ActionIcon size='sm' onClick={submit} loading={saving} disabled={!value.trim()} aria-label={`Name ${mark.label}`}>
            <TablerIcon name='check' size={14} />
          </ActionIcon>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}

export function FaceOverlay(
  {
    mediaRef,
    faces,
    pinned,
    hoveredKey,
    onHover,
    onOpenPerson,
    onNamePerson,
    labelsOnly = false,
    motionClassName,
    motionRunning = true,
    scale = 1,
    drawing = false,
    saving = false,
    onCreateFace,
    onUpdateFace,
    onRemoveFace,
    onChangePerson,
    onDraftChange,
  }: FaceOverlayProps,
) {
  const rect = useContentRect(mediaRef);
  type DraftDrag = { pointerId: number; start: DrawPoint; current: DrawPoint; edit: FaceBoxEdit | 'draw'; initialBox?: FaceBox };
  type FaceDraft = { box: FaceBox; face?: FaceMark };
  const dragRef = useRef<DraftDrag | null>(null);
  const [drag, setDrag] = useState<DraftDrag | null>(null);
  const [pendingDraft, setPendingDraft] = useState<FaceDraft | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);

  useEffect(() => {
    if (drawing) return;
    dragRef.current = null;
    setDrag(null);
    setPendingDraft(null);
    setRemoveArmed(false);
    onDraftChange?.(false);
  }, [drawing, onDraftChange]);

  if (!rect || (faces.length === 0 && !drawing)) return null;

  // Pinned, drawing and the slideshow show every face; otherwise only the hovered one is drawn.
  const allShown = labelsOnly || drawing || pinned;
  const pointIn = (event: ReactPointerEvent<HTMLElement>): DrawPoint => {
    // The bounding rect is in transformed screen pixels; `rect` is not.
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
  };
  const px = (value: number) => value / scale;
  const draftBox = pendingDraft?.box ?? (drag?.edit === 'draw' ? faceBoxFromDrag(drag.start, drag.current, rect, 0) : null);
  // The selected face as it is now, so a change of person shows while it stays selected.
  const draftFace = pendingDraft?.face && (faces.find((face) => face.facePath === pendingDraft.face!.facePath) ?? pendingDraft.face);

  const startDrawing = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drawing || saving || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-face-draft-action]')) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointIn(event);
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-face-handle]')?.dataset.faceHandle as FaceBoxEdit | undefined;
    const onDraft = (event.target as HTMLElement).closest('[data-face-draft]');
    const facePath = (event.target as HTMLElement).closest<HTMLElement>('[data-face-path]')?.dataset.facePath;
    const selectedFace = facePath ? faces.find((face) => face.facePath === facePath) : undefined;
    const initialBox = handle || onDraft ? pendingDraft?.box : selectedFace?.box;
    const edit = initialBox ? handle ?? 'move' : 'draw';
    if (pendingDraft && edit === 'draw') return;
    if (selectedFace && selectedFace.facePath) {
      setPendingDraft({ box: selectedFace.box, face: selectedFace });
      setRemoveArmed(false);
      onDraftChange?.(true);
    }
    const next: DraftDrag = { pointerId: event.pointerId, start: point, current: point, edit, initialBox };
    dragRef.current = next;
    setDrag(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrawing = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!drawing || !current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    const next = { ...current, current: pointIn(event) };
    dragRef.current = next;
    setDrag(next);
    if (current.edit !== 'draw' && current.initialBox) {
      const box = editFaceBox(current.initialBox, current.start, next.current, rect, current.edit);
      setPendingDraft((draft) => draft ? { ...draft, box } : draft);
    }
  };
  const finishDrawing = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!drawing || !current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointIn(event);
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.edit !== 'draw' && current.initialBox) {
      const box = editFaceBox(current.initialBox, current.start, point, rect, current.edit);
      setPendingDraft((draft) => draft ? { ...draft, box } : draft);
      return;
    }
    const box = faceBoxFromDrag(current.start, point, rect);
    if (!box) return;
    setPendingDraft({ box });
    setRemoveArmed(false);
    onDraftChange?.(true);
  };
  const saveDraft = async () => {
    if (!pendingDraft) return;
    try {
      if (pendingDraft.face?.facePath) {
        if (!onUpdateFace) return;
        // Selecting a face to change who it is leaves its box where it was: nothing to save.
        if (!sameFaceBox(pendingDraft.box, pendingDraft.face.box)) await onUpdateFace(pendingDraft.face.facePath, pendingDraft.box);
      } else {
        if (!onCreateFace) return;
        await onCreateFace(pendingDraft.box);
      }
      setPendingDraft(null);
      setRemoveArmed(false);
      onDraftChange?.(false);
    } catch {
      // The owner renders the command error; keep the editable draft available for a retry.
    }
  };
  const cancelDraft = () => {
    dragRef.current = null;
    setDrag(null);
    setPendingDraft(null);
    setRemoveArmed(false);
    onDraftChange?.(false);
  };
  const removeDraft = async () => {
    const facePath = pendingDraft?.face?.facePath;
    if (!facePath || !onRemoveFace) return;
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }
    try {
      await onRemoveFace(facePath);
      setPendingDraft(null);
      setRemoveArmed(false);
      onDraftChange?.(false);
    } catch {
      // The owner renders the command error; keep the face selected for a retry.
    }
  };

  return (
    <Box
      data-face-overlay
      data-labels-only={labelsOnly || undefined}
      data-face-drawing={drawing || undefined}
      className={motionClassName}
      // The overlay itself must not eat clicks meant for the video controls underneath; only
      // the boxes take pointer events back.
      style={{
        position: 'absolute',
        // The slideshow crossfade keeps its incoming photo at z-index 1. Keep the face
        // layer above that photo as well as the outgoing frame beneath it.
        zIndex: 2,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: drawing ? 'auto' : 'none',
        cursor: drawing ? 'crosshair' : undefined,
        touchAction: drawing ? 'none' : undefined,
        userSelect: drawing ? 'none' : undefined,
        animationPlayState: motionRunning ? 'running' : 'paused',
      }}
      onPointerDown={startDrawing}
      onPointerMove={moveDrawing}
      onPointerUp={finishDrawing}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDrag(null);
      }}
    >
      {faces.map((face) => {
        const active = hoveredKey === face.key || hoveredKey === face.personHoverKey;
        // By path: the key changes with the person, when a face is named or loses its name.
        const selected = pendingDraft?.face?.facePath === face.facePath;
        const shown = allShown || active;
        const label = (
          <Box
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: `translateX(-50%) scale(${px(1)})`,
              transformOrigin: 'top center',
              marginTop: 4,
              padding: '1px 6px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              fontSize: 12,
              lineHeight: 1.5,
              background: 'var(--mrx-scrim)',
              color: face.named ? 'white' : 'var(--mantine-color-dimmed)',
              opacity: !shown ? 0 : active ? 1 : labelsOnly ? 0.85 : 0.55,
              transition: 'opacity 120ms',
            }}
          >
            {face.label}
          </Box>
        );

        const boxStyle: React.CSSProperties = {
          position: 'absolute',
          left: `${face.box.x * 100}%`,
          top: `${face.box.y * 100}%`,
          width: `${face.box.width * 100}%`,
          height: `${face.box.height * 100}%`,
          // Invisible until something is hovered, but always a hit target — that is what makes
          // an unmarked photo reveal its faces when the pointer wanders over one.
          border: labelsOnly
            ? `${px(2)}px solid transparent`
            : `${px(2)}px ${face.hasFace ? 'solid' : 'dashed'} ${!shown ? 'transparent' : active ? 'var(--mrx-accent)' : 'rgba(255,255,255,0.7)'}`,
          borderRadius: px(3),
          boxShadow: !labelsOnly && active ? '0 0 0 9999px rgba(0,0,0,0.25)' : undefined,
          pointerEvents: labelsOnly ? 'none' : 'auto',
          cursor: labelsOnly ? undefined : drawing ? 'move' : 'pointer',
          visibility: selected ? 'hidden' : undefined,
          // Entering slideshow must drop the boxes immediately; carrying the normal
          // border transition over would leave a brief outline around each label.
          transition: labelsOnly ? 'none' : 'border-color 120ms, box-shadow 120ms',
          // A photo's faces arrive a moment after the photo itself; ease them in rather than pop.
          animation: 'mrx-fade-in 150ms ease-out',
        };

        return (
          <Box
            data-face-mark={face.key}
            data-face-path={face.facePath || undefined}
            data-tag={face.hasFace ? undefined : true}
            title={face.hasFace || labelsOnly ? undefined : TAG_TITLE}
            key={face.key}
            style={boxStyle}
            onMouseEnter={() => onHover(face.key)}
            onMouseLeave={() => onHover(null)}
          >
            {drawing ? label : labelsOnly ? label : face.named
              ? (
                <Box
                  // The route takes the person's directory name. Neither `personPath` itself (a VFS
                  // path no page answers to) nor `personId` (the node's ULID, which the person page
                  // cannot look up) will do.
                  onClick={() => face.personPath && onOpenPerson(`/people/${encodeURIComponent(face.personPath.split('/').pop() ?? face.personPath)}`)}
                  style={{ width: '100%', height: '100%' }}
                >
                  {label}
                </Box>
              )
              : face.personPath
              ? (
                <NameFacePopover mark={face} onName={(name) => onNamePerson(face.personPath!, name)}>
                  {label}
                </NameFacePopover>
              )
              : label}
          </Box>
        );
      })}
      {drawing && draftBox && (
        <Box
          data-face-draft
          style={{
            position: 'absolute',
            left: `${draftBox.x * 100}%`,
            top: `${draftBox.y * 100}%`,
            width: `${draftBox.width * 100}%`,
            height: `${draftBox.height * 100}%`,
            border: `${px(2)}px solid var(--mrx-accent)`,
            borderRadius: px(3),
            background: 'rgba(0, 0, 0, 0.18)',
            boxShadow: `0 0 0 ${px(1)}px rgba(0, 0, 0, 0.65)`,
            cursor: pendingDraft ? 'move' : 'crosshair',
          }}
        >
          {pendingDraft && (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((handle) => {
            const positions: Record<Exclude<FaceBoxEdit, 'move'>, React.CSSProperties> = {
              nw: { left: 0, top: 0 },
              n: { left: '50%', top: 0 },
              ne: { left: '100%', top: 0 },
              e: { left: '100%', top: '50%' },
              se: { left: '100%', top: '100%' },
              s: { left: '50%', top: '100%' },
              sw: { left: 0, top: '100%' },
              w: { left: 0, top: '50%' },
            };
            const cursors: Record<Exclude<FaceBoxEdit, 'move'>, string> = {
              nw: 'nwse-resize',
              n: 'ns-resize',
              ne: 'nesw-resize',
              e: 'ew-resize',
              se: 'nwse-resize',
              s: 'ns-resize',
              sw: 'nesw-resize',
              w: 'ew-resize',
            };
            return (
              <Box
                key={handle}
                data-face-handle={handle}
                style={{
                  position: 'absolute',
                  ...positions[handle],
                  width: px(12),
                  height: px(12),
                  border: `${px(2)}px solid var(--mrx-accent)`,
                  borderRadius: '50%',
                  background: 'white',
                  transform: 'translate(-50%, -50%)',
                  cursor: cursors[handle],
                }}
              />
            );
          })}
          {pendingDraft && (
            <Group
              data-face-draft-action
              gap={4}
              wrap='nowrap'
              style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                zIndex: 1,
                marginTop: 8,
                transform: `translateX(-50%) scale(${px(1)})`,
                transformOrigin: 'top center',
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Button size='compact-xs' leftSection={<TablerIcon name='check' size={13} />} loading={saving} onClick={() => void saveDraft()}>
                Done
              </Button>
              <Button size='compact-xs' variant='default' leftSection={<TablerIcon name='x' size={13} />} disabled={saving} onClick={cancelDraft}>
                Cancel
              </Button>
              {draftFace && onChangePerson && (
                <Button
                  size='compact-xs'
                  variant='default'
                  leftSection={<TablerIcon name='user-edit' size={13} />}
                  title='Change who this is'
                  disabled={saving}
                  onClick={() => onChangePerson(draftFace.facePath)}
                >
                  {draftFace.label}
                </Button>
              )}
              {pendingDraft.face && (
                <Button size='compact-xs' variant={removeArmed ? 'filled' : 'light'} color='red' disabled={saving} onClick={() => void removeDraft()}>
                  {removeArmed ? 'Confirm remove' : 'Remove'}
                </Button>
              )}
            </Group>
          )}
        </Box>
      )}
    </Box>
  );
}

/** Exported for the sidebar, so hovering a name lights up the same box. */
export const faceKeyForPerson = (personPath: string) => `p-${personPath}`;
