/**
 * What may be done to the file the lightbox shows: edit it, share it, put it in an album, draw its
 * faces, write its text or subtitles, restore it, remove a blemish, turn or mirror it. The floating
 * toolbar shows them as icons over the picture and holds the dialogs they open. A restored copy
 * shown beside the picture (`useRestoredCompare`) is also the details panel's, from its versions.
 */

import { type ReactNode, useRef, useState } from 'react';
import { type MediaItem, notify, openShareModal, shareModalPath } from '@ein/ui/signals';
import type { FileRestoreAnswer } from '@media/api';
import type { MediaVersion, OrientationChange, UseMediaDetailsResult } from '../hooks/useMediaDetails.ts';
import { MediaEditModal } from './MediaEditModal.tsx';
import { RESTORABLE, RestoreDialog } from './RestoreDialog.tsx';
import { RestoredCompare } from './RestoredCompare.tsx';
import { BlemishDialog } from './BlemishDialog.tsx';
import { useAddToAlbum } from './AddToAlbumAction.tsx';

/** One action: a toolbar icon. `checked` marks a mode that is on. */
type FileAction = { key: string; icon: string; label: string; onClick: () => void; disabled?: boolean; checked?: boolean };

export type FileActionsOptions = {
  media: MediaItem;
  result: UseMediaDetailsResult;
  /** The narrow layout, which has no face drawing. */
  mobile?: boolean;
  canEdit: boolean;
  /** The picture the add-to-album action puts in an album; absent for the guest. */
  addToAlbumPath?: string;
  canOrient: boolean;
  orienting: boolean;
  onTurn: (change: OrientationChange) => Promise<void>;
  addingFace?: boolean;
  /** Desktop-only hand-off: the lightbox image itself owns the draw gesture. */
  onAddFace?: () => void;
  /** Open the editor of the text in the picture: given for a photo the reader may change. */
  onEditText?: () => void;
  /** Open the subtitle editor: given for a video or a recording the reader may change. */
  onEditSubtitles?: () => void;
};

type FileActions = {
  actions: FileAction[];
  /** The dialogs the actions open, to be rendered beside whatever lists them. */
  dialogs: ReactNode;
  /** A dialog of theirs is open, which has the keys. */
  layer: boolean;
};

type RestoredCompareState = {
  /** Show a restored copy beside the picture, or close it. */
  compare: (version: MediaVersion | null) => void;
  /** What a restoration of `from` that has finished does: its copy beside the picture, or a note. */
  restored: (from: string) => (answer: FileRestoreAnswer, shown?: boolean) => void;
  /** The comparison, to be rendered beside whatever opens it. */
  dialog: ReactNode;
  /** It is open, which has the keys. */
  open: boolean;
};

const reportError = (message: string | null) => {
  if (message) notify({ message, color: 'red' });
};

/** A restored copy of the shown file beside the picture, and what a finished restoration does. */
export function useRestoredCompare({ media, result, canEdit }: { media: MediaItem; result: UseMediaDetailsResult; canEdit: boolean }): RestoredCompareState {
  const { details } = result;
  const [comparing, setComparing] = useState<MediaVersion | null>(null);
  /** The picture shown, for a restoration that finishes to know whether it is still the one shown. */
  const pathRef = useRef(media.path);
  pathRef.current = media.path;
  const [shownPath, setShownPath] = useState(media.path);
  if (shownPath !== media.path) {
    setShownPath(media.path);
    setComparing(null);
  }

  /**
   * A restoration done: its copy beside the picture, when that is still the one shown; a note
   * otherwise, since the lightbox has moved on while it ran.
   */
  const restored = (from: string) => (answer: FileRestoreAnswer, shown = false) => {
    if (pathRef.current !== from) {
      notify({ message: `The restored copy of ${from.split('/').pop()} is ready among its versions` });
      return;
    }
    void result.refetch();
    setComparing({
      name: answer.name,
      path: answer.path,
      mimetype: answer.path.endsWith('.tif') ? 'image/tiff' : 'image/png',
      thumbnails: true,
      ...(shown ? { shown: true as const } : {}),
      restored: {
        steps: answer.restoration.steps.map((step) => ({ op: step.op, params: step.params })),
        at: answer.restoration.at,
        ...(answer.restoration.marked !== undefined ? { marked: answer.restoration.marked } : {}),
        ...(answer.mask ? { mask: answer.mask } : {}),
        ...(answer.marks ? { marks: answer.marks } : {}),
      },
    });
  };

  const dialog = (
    <RestoredCompare
      version={comparing}
      original={media}
      angle={details?.angle ?? 0}
      mirror={details?.mirror ?? false}
      canEdit={canEdit}
      onClose={() => setComparing(null)}
      onDiscarded={() => void result.refetch()}
      onReplaced={restored(media.path)}
      onShown={() => void result.refetch()}
    />
  );
  return { compare: setComparing, restored, dialog, open: comparing !== null };
}

export function useFileActions(options: FileActionsOptions): FileActions {
  const { media, result, mobile = false, canEdit, addToAlbumPath, canOrient, orienting, onTurn, addingFace = false, onAddFace, onEditText, onEditSubtitles } = options;
  const { details, setDescription } = result;
  const [editing, setEditing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [blemishing, setBlemishing] = useState(false);
  const { restored, dialog: compareDialog, open: comparing } = useRestoredCompare({ media, result, canEdit });
  const album = useAddToAlbum(addToAlbumPath ? [addToAlbumPath] : [], reportError);
  const [shownPath, setShownPath] = useState(media.path);
  if (shownPath !== media.path) {
    setShownPath(media.path);
    setEditing(false);
    setRestoring(false);
    setBlemishing(false);
  }

  const restorable = canEdit && media.type === 'photo' && RESTORABLE.has(details?.mimetype ?? '');
  const actions: FileAction[] = [];
  if (canEdit) {
    actions.push({ key: 'edit', icon: 'pencil', label: 'Edit', disabled: !details, onClick: () => setEditing(true) });
    actions.push({ key: 'share', icon: 'share', label: 'Share', onClick: () => openShareModal(media.path) });
  }
  if (addToAlbumPath) actions.push({ key: 'album', icon: 'library-plus', label: 'Add to album', onClick: album.open });
  if (canEdit && !mobile && (media.type === 'photo' || media.type === 'video') && onAddFace) {
    actions.push({ key: 'faces', icon: 'user-square-rounded', label: 'Edit faces', checked: addingFace, onClick: onAddFace });
  }
  if (canEdit && onEditText) {
    actions.push({ key: 'text', icon: 'text-scan-2', label: details?.content ? 'Edit text' : 'Add text', disabled: !details, onClick: onEditText });
  }
  if (canEdit && onEditSubtitles) {
    actions.push({ key: 'subtitles', icon: 'badge-cc', label: details?.hasTranscript ? 'Edit subtitles' : 'Add subtitles', disabled: !details, onClick: onEditSubtitles });
  }
  if (restorable) actions.push({ key: 'restore', icon: 'wand', label: 'Restore…', onClick: () => setRestoring(true) });
  if (restorable && details?.width && details.height) actions.push({ key: 'blemish', icon: 'brush', label: 'Remove a blemish…', onClick: () => setBlemishing(true) });
  if (canEdit && canOrient) {
    actions.push({ key: 'rotate-left', icon: 'rotate-2', label: 'Rotate left', disabled: orienting, onClick: () => void onTurn({ rotate: 'ccw' }) });
    actions.push({ key: 'rotate-right', icon: 'rotate-clockwise-2', label: 'Rotate right', disabled: orienting, onClick: () => void onTurn({ rotate: 'cw' }) });
    actions.push({
      key: 'mirror',
      icon: 'flip-vertical',
      label: 'Mirror horizontally',
      checked: details?.mirror ?? false,
      disabled: orienting,
      onClick: () => void onTurn({ mirror: 'toggle' }),
    });
  }

  const dialogs = (
    <>
      {addToAlbumPath && album.dialog}
      <RestoreDialog
        opened={restoring}
        onClose={() => setRestoring(false)}
        path={media.path}
        digitized={details?.digitized}
        onRestored={restored(media.path)}
      />
      {blemishing && details?.width && details.height && (
        <BlemishDialog
          opened
          onClose={() => setBlemishing(false)}
          media={media}
          angle={details.angle}
          mirror={details.mirror}
          width={details.width}
          height={details.height}
          onRestored={restored(media.path)}
        />
      )}
      {compareDialog}
      {details && (
        <MediaEditModal
          opened={editing}
          onClose={() => setEditing(false)}
          details={details}
          setDescription={setDescription}
          onSaved={result.refetch}
        />
      )}
    </>
  );

  const sharing = shareModalPath.value === media.path;
  return { actions, dialogs, layer: editing || restoring || blemishing || comparing || sharing || album.opened };
}
