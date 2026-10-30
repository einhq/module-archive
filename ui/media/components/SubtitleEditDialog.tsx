/**
 * Correcting what is said in a video or a recording: the player beside the list of its lines, each
 * with its times and its words. Side by side on a wide screen, the player above the list on a
 * narrow one.
 *
 * The player has a transport of its own and leaves the lightbox's playhead alone (`publish: false`);
 * it starts where the lightbox's player was, which it pauses. The line being said is drawn over the
 * picture as it reads now, edits and all, highlighted in the list, and followed there while nothing
 * in the list has the focus. The timeline under the picture shows where every line lies.
 *
 * The keys work from inside a line's text too, so the words can be typed while it plays: with Alt,
 * which typing does not use, and Ctrl+Space. Outside a text field the player's own keys (Space, k,
 * j, l) work without it.
 */

import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { useShortcutHelp } from '@ein/ui/hooks';
import { bust, displayDims, fileUrl, gridUrl, posterUrl, VIDEO_SOURCE_TYPE } from '@ein/ui/lib';
import type { MediaItem } from '@ein/ui/signals';
import { ActionIcon, Badge, Box, Button, Group, Loader, ScrollArea, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { memo, type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaSpeaker } from '@archive/media/api';
import { useMediaTransport } from '../hooks/useMediaTransport.ts';
import type { PlayerTranscript } from '../hooks/useSubtitles.ts';
import { useTranscriptCues } from '../hooks/useTranscriptCues.ts';
import {
  addCueAt,
  cueProblem,
  cuesToVtt,
  type DraftCue,
  draftFrom,
  endCueAt,
  formatCueTime,
  joinWithNext,
  parseCueTime,
  removeCue,
  splitCue,
  startCueAt,
  updateCue,
} from '../lib/subtitle-edit.ts';
import { attachSpeakers, cueAt, speakerColor, speakerLabel } from '../lib/vtt.ts';
import { Scrubber } from './Scrubber.tsx';

/** What j, l and their Alt forms move the playhead by, in seconds: a few words. */
const NUDGE_SECONDS = 2;

const SHORTCUTS = [
  { keys: 'Ctrl+Space', label: 'Play or pause, also while typing (Alt+K, or Space outside a text field)' },
  { keys: 'Alt+J', label: `Back ${NUDGE_SECONDS} seconds` },
  { keys: 'Alt+L', label: `Forward ${NUDGE_SECONDS} seconds` },
  { keys: 'Alt+P', label: 'Play the line, from its start to its end' },
  { keys: 'Alt+I', label: 'The line starts at the playhead' },
  { keys: 'Alt+O', label: 'The line ends at the playhead' },
  { keys: 'Alt+N', label: 'A new line at the playhead' },
  { keys: 'Alt+S', label: 'Split the line at the cursor' },
  { keys: 'Alt+↑', label: 'The line before' },
  { keys: 'Alt+↓', label: 'The line after' },
  { keys: 'Ctrl+Enter', label: 'Save' },
];

const isTextField = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/** Where a plain key is someone's: a field's text, or a button's own Space. */
const takesPlainKeys = (target: EventTarget | null): boolean => isTextField(target) || target instanceof HTMLButtonElement || target instanceof HTMLSelectElement;

type SubtitleEditDialogProps = {
  opened: boolean;
  media: MediaItem;
  /** The lightbox's cache-buster for this file's renditions and transcript. */
  reloadToken: number;
  /** The transcript's language and voices when it has lines; without it the editor starts empty. */
  transcript?: PlayerTranscript;
  /** Write the lines, as WebVTT. */
  onSave: (vtt: string) => Promise<void>;
  onClose: () => void;
};

export function SubtitleEditDialog({ opened, media, reloadToken, transcript, onSave, onClose }: SubtitleEditDialogProps) {
  const isNarrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  // The editor asks before unsaved lines are thrown away, whichever way the dialog is closed.
  const closeRef = useRef<(() => void) | null>(null);
  const [count, setCount] = useState<number | null>(null);

  return (
    <Dialog
      opened={opened}
      onClose={() => (closeRef.current ?? onClose)()}
      // The editor's own Escape, which asks first when there are changes.
      closeOnEscape={false}
      fullScreen={isNarrow}
      size='screen'
      zIndex={300}
      title='Subtitles'
      subtitle={media.name}
      icon='badge-cc'
      pattern='media'
      aside={count !== null && <Badge variant='light' color='gray'>{count === 1 ? '1 line' : `${count} lines`}</Badge>}
      bleed
    >
      {opened && (
        <SubtitleEditor
          key={media.path}
          media={media}
          reloadToken={reloadToken}
          transcript={transcript}
          narrow={isNarrow}
          onSave={onSave}
          onClose={onClose}
          onCount={setCount}
          closeRef={closeRef}
        />
      )}
    </Dialog>
  );
}

type SubtitleEditorProps = Omit<SubtitleEditDialogProps, 'opened'> & {
  narrow: boolean;
  onCount: (count: number | null) => void;
  closeRef: MutableRefObject<(() => void) | null>;
};

function SubtitleEditor({ media, reloadToken, transcript, narrow, onSave, onClose, onCount, closeRef }: SubtitleEditorProps) {
  useShortcutHelp('Subtitles', SHORTCUTS);
  const isVideo = media.type === 'video';
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((el: HTMLMediaElement | null) => void (mediaRef.current = el), []);

  // Where the lightbox's player stands, read once and paused: the editor carries on from there.
  const [startAt] = useState(() => {
    const players = document.querySelectorAll<HTMLMediaElement>('[data-lightbox-media-path] video, [data-lightbox-media-path] audio');
    let at = 0;
    for (const player of players) {
      at = Math.max(at, player.currentTime);
      player.pause();
    }
    return at;
  });
  const transport = useMediaTransport(mediaRef, { fallbackDuration: media.duration, startAt, publish: false });
  const { playing, position, duration, toggle, seek, skip } = transport;
  // The playhead to the frame, for the actions that set a time: `position` lags by a `timeupdate`.
  const positionRef = useRef(position);
  positionRef.current = position;
  const now = useCallback(() => mediaRef.current?.currentTime ?? positionRef.current, []);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [follow, setFollow] = useState(false);

  const { cues, failed } = useTranscriptCues(transcript ? bust(`${fileUrl(media.path)}/metadata/transcript`, reloadToken) : null);
  const [draft, setDraft] = useState<DraftCue[] | null>(transcript ? null : []);
  const [original, setOriginal] = useState(() => cuesToVtt([]));
  useEffect(() => {
    if (draft !== null || !cues) return;
    const lines = draftFrom(cues);
    setDraft(lines);
    setOriginal(cuesToVtt(lines));
    setSelectedId(cueAt(lines, startAt)?.id ?? null);
    setFollow(true);
  }, [cues, draft, startAt]);
  // The latest lines, for the callbacks the rows hold, so a row is not drawn again for an edit to another.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const vtt = useMemo(() => draft ? cuesToVtt(draft) : original, [draft, original]);
  const dirty = vtt !== original;
  const blocked = draft?.some((cue) => cueProblem(cue)?.blocking) ?? false;
  useEffect(() => onCount(draft ? draft.length : null), [draft, onCount]);
  useEffect(() => () => onCount(null), [onCount]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const requestClose = useCallback(() => {
    if (dirty && !saving) setConfirming(true);
    else onClose();
  }, [dirty, saving, onClose]);
  closeRef.current = requestClose;
  useEffect(() => () => void (closeRef.current = null), [closeRef]);

  const save = useCallback(async () => {
    if (!draft || blocked || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(vtt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSaving(false);
    }
  }, [draft, blocked, saving, onSave, vtt]);

  // The text boxes by line, to put the focus and read the caret.
  const fields = useRef(new Map<number, HTMLTextAreaElement>());
  const rowsRef = useRef(new Map<number, HTMLDivElement>());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const registerField = useCallback((id: number, el: HTMLTextAreaElement | null) => void (el ? fields.current.set(id, el) : fields.current.delete(id)), []);
  const registerRow = useCallback((id: number, el: HTMLDivElement | null) => void (el ? rowsRef.current.set(id, el) : rowsRef.current.delete(id)), []);
  const [focusId, setFocusId] = useState<number | null>(null);
  // Bring a line into view in the list alone: `scrollIntoView` would scroll the dialog as well.
  const reveal = useCallback((id: number) => {
    const row = rowsRef.current.get(id);
    const viewport = viewportRef.current;
    if (!row || !viewport) return;
    const top = row.offsetTop;
    if (top < viewport.scrollTop || top + row.offsetHeight > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: top - viewport.clientHeight / 3, behavior: 'smooth' });
    }
  }, []);
  useEffect(() => {
    if (focusId === null) return;
    const field = fields.current.get(focusId);
    if (!field) return;
    field.focus({ preventScroll: true });
    reveal(focusId);
    setFocusId(null);
  }, [focusId, draft, reveal]);

  // The line under the playhead, followed in the list while nothing in it has the focus.
  const active = draft ? cueAt(draft, position) : undefined;
  useEffect(() => {
    if (!active || !(playing || follow)) return;
    const focused = document.activeElement;
    if (focused instanceof Element && viewportRef.current?.contains(focused)) return;
    reveal(active.id);
    setFollow(false);
  }, [active?.id, playing, follow, reveal]);

  // Playing one line stops at its end.
  const stopAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) {
      stopAtRef.current = null;
      return;
    }
    let frame = requestAnimationFrame(function check() {
      const el = mediaRef.current;
      if (el && stopAtRef.current !== null && el.currentTime >= stopAtRef.current) {
        stopAtRef.current = null;
        el.pause();
      }
      frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const edit = useCallback((change: (lines: DraftCue[]) => DraftCue[] | null) => {
    const lines = draftRef.current;
    if (!lines) return;
    const changed = change(lines);
    if (changed) setDraft(changed);
  }, []);

  const playLine = useCallback((id: number) => {
    const cue = draftRef.current?.find((line) => line.id === id);
    const el = mediaRef.current;
    if (!cue || !el) return;
    setSelectedId(id);
    seek(cue.start);
    stopAtRef.current = cue.end;
    if (el.paused) toggle();
  }, [seek, toggle]);

  const seekTo = useCallback((id: number) => {
    const cue = draftRef.current?.find((line) => line.id === id);
    if (cue) seek(cue.start);
  }, [seek]);

  const addLine = useCallback(() => {
    const lines = draftRef.current;
    if (!lines) return;
    const added = addCueAt(lines, now(), duration);
    setDraft(added.cues);
    setSelectedId(added.id);
    setFocusId(added.id);
  }, [now, duration]);

  const split = useCallback((id: number) => {
    const lines = draftRef.current;
    const field = fields.current.get(id);
    if (!lines) return;
    const caret = field && document.activeElement === field ? field.selectionStart : (lines.find((line) => line.id === id)?.text.length ?? 0) / 2;
    const result = splitCue(lines, id, Math.round(caret), now());
    if (!result) return;
    setDraft(result.cues);
    setSelectedId(result.id);
    setFocusId(result.id);
  }, [now]);

  const join = useCallback((id: number) => {
    edit((lines) => joinWithNext(lines, id));
    setFocusId(id);
  }, [edit]);

  const remove = useCallback((id: number) => {
    const lines = draftRef.current;
    if (!lines) return;
    const index = lines.findIndex((line) => line.id === id);
    const neighbour = lines[index + 1] ?? lines[index - 1];
    setDraft(removeCue(lines, id));
    setSelectedId(neighbour?.id ?? null);
    if (neighbour) setFocusId(neighbour.id);
  }, []);

  const setText = useCallback((id: number, text: string) => edit((lines) => updateCue(lines, id, { text })), [edit]);
  const setStart = useCallback((id: number, at: number) => edit((lines) => startCueAt(lines, id, at)), [edit]);
  const setEnd = useCallback((id: number, at: number) => edit((lines) => endCueAt(lines, id, at)), [edit]);
  const startHere = useCallback((id: number) => setStart(id, now()), [setStart, now]);
  const endHere = useCallback((id: number) => setEnd(id, now()), [setEnd, now]);

  const step = useCallback((by: number) => {
    const lines = draftRef.current;
    if (!lines?.length) return;
    const index = lines.findIndex((line) => line.id === selectedId);
    const next = lines[index < 0 ? (by > 0 ? 0 : lines.length - 1) : Math.min(Math.max(index + by, 0), lines.length - 1)];
    setSelectedId(next.id);
    setFocusId(next.id);
    if (mediaRef.current?.paused) seek(next.start);
  }, [selectedId, seek]);

  // On the window rather than the dialog, so the keys work wherever the focus is: a deleted line's
  // button takes it with it, out of the dialog.
  const onKeyDown = (event: KeyboardEvent) => {
    const act = (run: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    };
    if (event.key === 'Escape') return act(confirming ? () => setConfirming(false) : requestClose);
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') return act(() => void save());
    if (event.ctrlKey && !event.altKey && event.code === 'Space') return act(toggle);

    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const alt = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (plain && !takesPlainKeys(event.target)) {
      if (event.code === 'Space' || event.code === 'KeyK') return act(toggle);
      if (event.code === 'KeyJ') return act(() => skip(-NUDGE_SECONDS));
      if (event.code === 'KeyL') return act(() => skip(NUDGE_SECONDS));
    }
    if (!alt) return;
    // `code`, not `key`: on a Mac, Option turns the letter into another character.
    switch (event.code) {
      case 'KeyK':
        return act(toggle);
      case 'KeyJ':
        return act(() => skip(-NUDGE_SECONDS));
      case 'KeyL':
        return act(() => skip(NUDGE_SECONDS));
      case 'KeyN':
        return act(addLine);
      case 'ArrowUp':
        return act(() => step(-1));
      case 'ArrowDown':
        return act(() => step(1));
    }
    if (selectedId === null) return;
    switch (event.code) {
      case 'KeyP':
        return act(() => playLine(selectedId));
      case 'KeyI':
        return act(() => startHere(selectedId));
      case 'KeyO':
        return act(() => endHere(selectedId));
      case 'KeyS':
        return act(() => split(selectedId));
    }
  };
  const keyRef = useRef(onKeyDown);
  keyRef.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyRef.current(event);
    globalThis.addEventListener('keydown', listener);
    return () => globalThis.removeEventListener('keydown', listener);
  }, []);

  const speakers = transcript?.speakers ?? [];
  const spoken = useMemo(() => draft ? attachSpeakers(draft, speakers) : null, [draft, speakers]);
  const namedVoices = speakers.length >= 2;
  const playerHeight = narrow ? (isVideo ? '32dvh' : '120px') : undefined;

  const player = (
    <Box style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: narrow ? '0 0 auto' : '3 1 0', minWidth: 0 }}>
      <Box
        onClick={toggle}
        style={{
          position: 'relative',
          flex: narrow ? undefined : 1,
          height: playerHeight ?? (isVideo ? undefined : 160),
          minHeight: 0,
          background: 'black',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
      >
        {isVideo
          ? (
            <video
              ref={attachMedia}
              playsInline
              preload='auto'
              poster={bust(posterUrl(media.path, media.type, media.hasDerivatives, displayDims(media)), reloadToken)}
              onContextMenu={(event) => event.preventDefault()}
              style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
            >
              <source src={bust(media.fullUrl, reloadToken)} type={media.hasDerivatives ? VIDEO_SOURCE_TYPE : undefined} />
            </video>
          )
          : (
            <>
              <audio ref={attachMedia} preload='auto' src={bust(media.fullUrl, reloadToken)} />
              <Box
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: `url(${bust(gridUrl(media.path, media.hasDerivatives), reloadToken)})`,
                  backgroundSize: '100% 100%',
                  opacity: 0.35,
                }}
              />
            </>
          )}
        {active?.text.trim() && (
          <Box
            aria-live='polite'
            style={{
              position: 'absolute',
              left: '50%',
              bottom: isVideo ? '8%' : '50%',
              transform: isVideo ? 'translateX(-50%)' : 'translate(-50%, 50%)',
              width: 'max-content',
              maxWidth: '90%',
              textAlign: 'center',
              lineHeight: 1.35,
              fontSize: narrow ? 16 : 20,
              pointerEvents: 'none',
            }}
          >
            <Box
              component='span'
              style={{
                padding: '0.1em 0.4em',
                borderRadius: 4,
                background: 'rgba(0, 0, 0, 0.6)',
                color: 'white',
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {active.text}
            </Box>
          </Box>
        )}
      </Box>
      <Group gap={4} px='sm' py={6} wrap='nowrap'>
        <Tooltip label={playing ? 'Pause (Ctrl+Space)' : 'Play (Ctrl+Space)'} withinPortal zIndex={400}>
          <ActionIcon variant='subtle' size='lg' onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            <TablerIcon name={playing ? 'player-pause' : 'player-play'} size={22} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={`Back ${NUDGE_SECONDS} seconds (Alt+J)`} withinPortal zIndex={400}>
          <ActionIcon variant='subtle' size='lg' onClick={() => skip(-NUDGE_SECONDS)} aria-label={`Back ${NUDGE_SECONDS} seconds`}>
            <TablerIcon name='arrow-back-up' size={20} />
          </ActionIcon>
        </Tooltip>
        <Text size='sm' ff='monospace' style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {formatCueTime(position)} / {formatCueTime(duration)}
        </Text>
        <Box style={{ flex: 1 }} />
        <Tooltip label='A new line at the playhead (Alt+N)' withinPortal zIndex={400}>
          <Button variant='light' size='xs' leftSection={<TablerIcon name='text-plus' size={16} />} onClick={addLine} disabled={!draft}>
            Add line
          </Button>
        </Tooltip>
      </Group>
      <Scrubber
        transport={transport}
        style={{
          position: 'relative',
          height: 28,
          margin: '0 var(--mantine-spacing-sm) var(--mantine-spacing-sm)',
          borderRadius: 4,
          background: 'var(--mantine-color-default-hover)',
        }}
      >
        {duration > 0 && spoken?.map((cue) => (
          <Box
            key={cue.id}
            aria-hidden
            style={{
              position: 'absolute',
              top: 4,
              bottom: 4,
              left: `${(cue.start / duration) * 100}%`,
              width: `max(2px, ${((cue.end - cue.start) / duration) * 100}%)`,
              borderRadius: 2,
              background: `var(--mantine-color-${speakerColor(cue.speaker?.speaker)}-${cue.id === selectedId ? 5 : 3})`,
              outline: cue.id === selectedId ? '2px solid var(--mantine-color-text)' : undefined,
              opacity: cue.id === active?.id || cue.id === selectedId ? 1 : 0.6,
            }}
          />
        ))}
        <Box
          aria-hidden
          style={{ position: 'absolute', top: 0, bottom: 0, width: 2, left: 'calc(var(--progress, 0) * 100%)', background: 'var(--mantine-color-red-6)' }}
        />
      </Scrubber>
    </Box>
  );

  const list = (
    <Box
      style={{
        flex: narrow ? 1 : '2 1 0',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: narrow ? undefined : '1px solid var(--mantine-color-default-border)',
      }}
    >
      {failed
        ? <Text size='sm' c='red' p='md'>The transcript could not be read.</Text>
        : !spoken
        ? <Loader size='sm' m='md' />
        : spoken.length === 0
        ? (
          <Text size='sm' c='dimmed' p='md'>
            No lines yet. Play to where something is said and add a line there.
          </Text>
        )
        : (
          <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef} type='auto' offsetScrollbars>
            <Box py={4} style={{ position: 'relative' }}>
              {spoken.map((cue, index) => (
                <CueRow
                  key={cue.id}
                  cue={cue}
                  speaker={cue.speaker}
                  showSpeaker={namedVoices && (index === 0 || spoken[index - 1].speaker?.speaker !== cue.speaker?.speaker)}
                  selected={cue.id === selectedId}
                  active={cue.id === active?.id}
                  last={index === spoken.length - 1}
                  registerRow={registerRow}
                  registerField={registerField}
                  onSelect={setSelectedId}
                  onSeek={seekTo}
                  onPlay={playLine}
                  onText={setText}
                  onStart={setStart}
                  onEnd={setEnd}
                  onStartHere={startHere}
                  onEndHere={endHere}
                  onSplit={split}
                  onJoin={join}
                  onRemove={remove}
                />
              ))}
            </Box>
          </ScrollArea>
        )}
    </Box>
  );

  return (
    <>
      <Box
        data-subtitle-edit
        style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', flex: 1, minHeight: 0, height: narrow ? undefined : 'min(80dvh, 900px)' }}
      >
        {player}
        {list}
      </Box>
      {error && <Text size='sm' c='red' px='md' pb='xs'>{error}</Text>}
      {confirming
        ? (
          <DialogActions hint='Your changes to the subtitles are not saved.'>
            <Button variant='default' onClick={() => setConfirming(false)} data-autofocus>Keep editing</Button>
            <Button color='red' onClick={onClose}>Discard</Button>
          </DialogActions>
        )
        : (
          <DialogActions
            hint={narrow ? 'Empty lines are left out.' : 'Ctrl+Space plays or pauses, Alt+P plays the line, Alt+I and Alt+O set its start and end. ? lists every key.'}
          >
            <Button variant='default' onClick={requestClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => void save()} loading={saving} disabled={!draft || !dirty || blocked}>Save</Button>
          </DialogActions>
        )}
    </>
  );
}

type CueRowProps = {
  cue: DraftCue;
  speaker?: MediaSpeaker;
  showSpeaker: boolean;
  selected: boolean;
  active: boolean;
  last: boolean;
  registerRow: (id: number, el: HTMLDivElement | null) => void;
  registerField: (id: number, el: HTMLTextAreaElement | null) => void;
  onSelect: (id: number) => void;
  onSeek: (id: number) => void;
  onPlay: (id: number) => void;
  onText: (id: number, text: string) => void;
  onStart: (id: number, at: number) => void;
  onEnd: (id: number, at: number) => void;
  onStartHere: (id: number) => void;
  onEndHere: (id: number) => void;
  onSplit: (id: number) => void;
  onJoin: (id: number) => void;
  onRemove: (id: number) => void;
};

/**
 * One line: its times, who says it, and its words. The line being said is tinted, the one being
 * edited outlined, with the buttons that act on it. A click beside the fields goes to its start.
 */
const CueRow = memo(function CueRow(props: CueRowProps) {
  const { cue, speaker, showSpeaker, selected, active, last, registerRow, registerField, onSelect, onSeek, onPlay, onText, onStart, onEnd } = props;
  const problem = cueProblem(cue);
  const action = (label: string, icon: string, run: (id: number) => void, disabled = false, color?: string) => (
    <Tooltip label={label} withinPortal zIndex={400}>
      <ActionIcon variant='subtle' size='sm' color={color} onClick={() => run(cue.id)} disabled={disabled} aria-label={label}>
        <TablerIcon name={icon} size={16} />
      </ActionIcon>
    </Tooltip>
  );

  return (
    <Box
      ref={useCallback((el: HTMLDivElement | null) => registerRow(cue.id, el), [registerRow, cue.id])}
      data-cue={cue.id}
      onFocusCapture={() => onSelect(cue.id)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onSelect(cue.id);
          onSeek(cue.id);
        }
      }}
      px='sm'
      py={6}
      mx={4}
      my={2}
      style={{
        borderRadius: 'var(--mantine-radius-sm)',
        borderLeft: `3px solid var(--mantine-color-${speakerColor(speaker?.speaker)}-${speaker ? 5 : 3})`,
        background: active ? 'var(--mantine-color-default-hover)' : undefined,
        outline: selected ? '1px solid var(--mantine-primary-color-filled)' : undefined,
      }}
    >
      {/* The buttons go to a row of their own where the times would not fit beside them. */}
      <Group gap={6} wrap='wrap' mb={4}>
        <Tooltip label='Play the line (Alt+P)' withinPortal zIndex={400}>
          <ActionIcon variant='subtle' size='sm' onClick={() => onPlay(cue.id)} aria-label='Play the line'>
            <TablerIcon name='player-play' size={16} />
          </ActionIcon>
        </Tooltip>
        <CueTime label='Start' value={cue.start} onCommit={(at) => onStart(cue.id, at)} />
        <Text size='xs' c='dimmed'>–</Text>
        <CueTime label='End' value={cue.end} onCommit={(at) => onEnd(cue.id, at)} invalid={problem?.blocking} />
        {showSpeaker && speaker && (
          <Badge size='xs' variant='light' color={speakerColor(speaker.speaker)} style={{ flexShrink: 1, minWidth: 0 }}>
            {speakerLabel(speaker)}
          </Badge>
        )}
        {selected && (
          <Group gap={0} wrap='nowrap' ml='auto'>
            {action('Start at the playhead (Alt+I)', 'arrow-bar-to-left', props.onStartHere)}
            {action('End at the playhead (Alt+O)', 'arrow-bar-to-right', props.onEndHere)}
            {action('Split at the cursor (Alt+S)', 'cut', props.onSplit)}
            {action('Join with the next line', 'arrows-join', props.onJoin, last)}
            {action('Delete the line', 'trash', props.onRemove, false, 'red')}
          </Group>
        )}
      </Group>
      <Textarea
        ref={useCallback((el: HTMLTextAreaElement | null) => registerField(cue.id, el), [registerField, cue.id])}
        aria-label={`Line at ${formatCueTime(cue.start)}`}
        value={cue.text}
        onChange={(event) => onText(cue.id, event.currentTarget.value)}
        // A line break would end the cue: Enter is left to the dialog's keys, and a pasted one becomes a space.
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) event.preventDefault();
        }}
        autosize
        minRows={1}
        size='sm'
        variant='filled'
        placeholder='What is said'
        error={problem && !problem.blocking ? problem.text : undefined}
      />
      {problem?.blocking && <Text size='xs' c='red' mt={2}>{problem.text}</Text>}
    </Box>
  );
});

/** A line's start or end, typed as a time and taken when the field is left or Enter pressed. */
function CueTime({ label, value, onCommit, invalid }: { label: string; value: number; onCommit: (at: number) => void; invalid?: boolean }) {
  const shown = formatCueTime(value);
  const [text, setText] = useState(shown);
  const [wrong, setWrong] = useState(false);
  useEffect(() => {
    setText(shown);
    setWrong(false);
  }, [shown]);

  const commit = () => {
    // Untouched, the time stays exact: the field shows it to the tenth only.
    if (text === shown) return;
    const at = parseCueTime(text);
    if (at === null) {
      setWrong(true);
      return;
    }
    onCommit(at);
  };

  return (
    <TextInput
      aria-label={label}
      value={text}
      onChange={(event) => {
        setText(event.currentTarget.value);
        setWrong(false);
      }}
      onBlur={() => {
        commit();
        if (parseCueTime(text) === null) setText(shown);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          commit();
        }
      }}
      size='xs'
      w={78}
      style={{ flexShrink: 0 }}
      error={wrong || invalid}
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontVariantNumeric: 'tabular-nums', textAlign: 'center', paddingInline: 4 } }}
    />
  );
}
