import { Box, Button, Group, SimpleGrid, Stack, Switch, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions } from '@ein/ui/components';
import { bust, fileUrl, mediaItemFrom, shq, versionOf } from '@ein/ui/lib';
import { execCommand, type MediaItem } from '@ein/ui/signals';
import type { MediaVersion } from '@archive/media/api';
import type { FileRestoreAnswer } from '@media/api';
import { fillPainted } from '../lib/restore-fill.ts';
import { againFlags, type MaskStroke } from '../lib/restore-mask.ts';
import { BrushBar, MarksBrush } from './MarksBrush.tsx';

/** What each restoration op did, as a person names it. */
const STEP_NAMES: Record<string, string> = {
  'image.unfade': 'faded colours',
  'image.defects': 'dust and scratches',
  'image.inpaint': 'dust and scratches',
  'image.denoise': 'grain',
};

/** The steps a restored copy went through, in words, once each. */
export const restoredSteps = (steps: { op: string; params: Record<string, unknown> }[]): string =>
  [...new Set(steps.map((step) => step.op === 'image.inpaint' && step.params.given ? 'marks painted by hand' : STEP_NAMES[step.op] ?? step.op))].join(', ');

type Props = {
  /** The restored copy compared; null keeps the dialog closed. */
  version: MediaVersion | null;
  /** The picture it was restored from, as the lightbox shows it. */
  original: MediaItem;
  /** How the picture is turned and flopped to be shown. */
  angle: number;
  mirror: boolean;
  onClose: () => void;
  /** After the copy is deleted. */
  onDiscarded: () => void;
  /** After the copy is made again from corrected marks, and the one compared deleted. */
  onReplaced: (answer: FileRestoreAnswer) => void;
};

/** One picture at the column's width, its own height, and over it, when given, the marks in red. */
function Picture({ src, srcSet, marks, label }: { src: string; srcSet?: string; marks?: string; label: string }) {
  return (
    <Stack gap={6}>
      <Box pos='relative' style={{ lineHeight: 0 }}>
        <img src={src} srcSet={srcSet || undefined} sizes='50vw' alt={label} style={{ width: '100%', height: 'auto', borderRadius: 'var(--mantine-radius-sm)' }} />
        {marks && (
          <Box
            pos='absolute'
            inset={0}
            style={{
              background: 'var(--mantine-color-red-6)',
              maskImage: `url(${marks})`,
              maskMode: 'luminance',
              maskSize: '100% 100%',
              WebkitMaskImage: `url(${marks})`,
              WebkitMaskSize: '100% 100%',
              pointerEvents: 'none',
            }}
          />
        )}
      </Box>
      <Text size='sm' c='dimmed'>{label}</Text>
    </Stack>
  );
}

/**
 * A restored copy beside the picture it was made from, to keep or discard. The marks that were
 * filled can be laid over the original in red: the defect finder guesses, and what it took for
 * damage — a button, a highlight in an eye — is painted over in the copy. They can be corrected
 * with a brush, erased where they are wrong and painted where damage was missed, and the copy made
 * again from them, in place of this one. Discarding deletes the copy; keeping leaves it among the
 * picture's versions.
 */
export function RestoredCompare({ version, original, angle, mirror, onClose, onDiscarded, onReplaced }: Props) {
  const [marks, setMarks] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [mode, setMode] = useState<MaskStroke['mode']>('erase');
  const [radius, setRadius] = useState(0.006);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMarks(false);
    setCorrecting(false);
    setStrokes([]);
    setError(null);
  }, [version?.path]);

  if (!version) return null;
  const restored = mediaItemFrom({
    path: version.path,
    mimetype: version.mimetype ?? 'image/png',
    width: original.width,
    height: original.height,
    angle: original.angle,
    hasDerivatives: version.thumbnails === true,
  });
  const marksUrl = version.restored?.marks ? bust(fileUrl(version.restored.marks), versionOf(version.path)) : undefined;
  const maskUrl = version.restored?.mask ? bust(fileUrl(version.restored.mask), versionOf(version.path)) : undefined;
  const marked = version.restored?.marked;
  const correctable = Boolean(marksUrl && maskUrl && version.restored?.steps.some((step) => step.op === 'image.inpaint'));

  const fillAgain = async () => {
    if (!version.restored || !maskUrl) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await fillPainted({
        path: original.path,
        angle,
        mirror,
        base: maskUrl,
        strokes,
        flags: againFlags(version.restored.steps),
      });
      await execCommand(`rm -r ${shq(version.path)}`);
      onReplaced(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      await execCommand(`rm -r ${shq(version.path)}`);
      onDiscarded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      opened
      onClose={() => !busy && onClose()}
      size='screen'
      title='Restored copy'
      subtitle={version.restored ? restoredSteps(version.restored.steps) : version.name}
      icon='wand'
      pattern='media'
    >
      <Stack gap='md'>
        {correcting
          ? (
            <>
              <Text size='sm' c='dimmed'>
                Erase the marks over what is not damage, paint over damage that was missed, then fill again. The new copy takes this one's place.
              </Text>
              <BrushBar
                mode={mode}
                onMode={setMode}
                radius={radius}
                onRadius={setRadius}
                onUndo={strokes.length > 0 ? () => setStrokes(strokes.slice(0, -1)) : undefined}
                disabled={busy}
              />
              <MarksBrush
                src={original.fullUrl}
                srcSet={original.srcSet}
                marks={marksUrl}
                strokes={strokes}
                onStrokes={setStrokes}
                mode={mode}
                radius={radius}
                disabled={busy}
              />
              {busy && <Text size='sm' c='dimmed'>Filling. A large scan takes a minute or two.</Text>}
            </>
          )
          : (
            <>
              {marksUrl && (
                <Switch
                  checked={marks}
                  onChange={(event) => setMarks(event.currentTarget.checked)}
                  label={`Show what was taken for damage${marked !== undefined ? ` (${(marked * 100).toFixed(marked < 0.01 ? 2 : 1)} % of the picture)` : ''}`}
                />
              )}
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing='md'>
                <Picture src={original.fullUrl} srcSet={original.srcSet} marks={marks ? marksUrl : undefined} label='Original' />
                <Picture src={restored.fullUrl} srcSet={restored.srcSet} label={version.name} />
              </SimpleGrid>
            </>
          )}
        {error && <Text size='sm' c='red'>{error}</Text>}
      </Stack>
      {correcting
        ? (
          <DialogActions>
            <Button variant='default' mr='auto' onClick={() => setCorrecting(false)} disabled={busy}>Back</Button>
            <Button loading={busy} disabled={strokes.length === 0} onClick={() => void fillAgain()}>Fill again</Button>
          </DialogActions>
        )
        : (
          <DialogActions>
            <Group gap='xs' mr='auto'>
              <Button component='a' variant='default' href={fileUrl(version.path)} download={version.name}>Download</Button>
              {correctable && <Button variant='default' onClick={() => setCorrecting(true)} disabled={busy}>Correct the marks</Button>}
            </Group>
            <Button variant='default' color='red' loading={busy} onClick={() => void discard()}>Discard</Button>
            <Button onClick={onClose} disabled={busy}>Keep</Button>
          </DialogActions>
        )}
    </Dialog>
  );
}
