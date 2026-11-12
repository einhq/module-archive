import { Alert, Button, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import type { MediaItem } from '@ein/ui/signals';
import type { FileRestoreAnswer } from '@media/api';
import { fillPainted } from '../lib/restore-fill.ts';
import type { MaskStroke } from '../lib/restore-mask.ts';
import { BrushBar, MarksBrush } from './MarksBrush.tsx';

type Props = {
  opened: boolean;
  onClose: () => void;
  /** The picture, as the lightbox shows it. */
  media: MediaItem;
  /** How the picture is turned and flopped to be shown. */
  angle: number;
  mirror: boolean;
  /** The picture's size as stored. */
  width: number;
  height: number;
  /** The copy written, once `file-restore` has answered. */
  onRestored: (answer: FileRestoreAnswer) => void;
};

/**
 * Blemishes painted over a picture — a spot, a stain, a tear — and filled from what is around them
 * by `file-restore --mask --fill lama`. The picture itself is never changed: the result is a copy
 * kept among its versions, as a restoration is.
 */
export function BlemishDialog({ opened, onClose, media, angle, mirror, width, height, onRestored }: Props) {
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [mode, setMode] = useState<MaskStroke['mode']>('paint');
  const [radius, setRadius] = useState(0.01);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setStrokes([]);
    setMode('paint');
    setError(null);
  }, [opened, media.path]);

  const fill = async () => {
    if (busy || strokes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      onRestored(
        await fillPainted({
          path: media.path,
          width,
          height,
          angle,
          mirror,
          strokes,
          flags: ['--fill', 'lama'],
        }),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened={opened}
      onClose={() => !busy && onClose()}
      title='Remove a blemish'
      subtitle={media.name}
      icon='wand'
      pattern='media'
      size='screen'
    >
      <Stack gap='md'>
        <Text size='sm' c='dimmed'>
          Paint over a spot, a stain or a tear, and it is filled from what is around it. The picture is not changed: the copy is kept beside it, among its versions.
        </Text>
        <BrushBar
          mode={mode}
          onMode={setMode}
          radius={radius}
          onRadius={setRadius}
          onUndo={strokes.length > 0 ? () => setStrokes(strokes.slice(0, -1)) : undefined}
          disabled={busy}
        />
        <MarksBrush src={media.fullUrl} srcSet={media.srcSet} strokes={strokes} onStrokes={setStrokes} mode={mode} radius={radius} disabled={busy} />
        {busy && <Text size='sm' c='dimmed'>Filling. A large scan takes a minute or two.</Text>}
        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button loading={busy} disabled={strokes.length === 0} onClick={() => void fill()}>Fill</Button>
      </DialogActions>
    </Dialog>
  );
}
