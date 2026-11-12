import { Box, Button, Group, SimpleGrid, Stack, Switch, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions } from '@ein/ui/components';
import { bust, fileUrl, mediaItemFrom, shq, versionOf } from '@ein/ui/lib';
import { execCommand, type MediaItem } from '@ein/ui/signals';
import type { MediaVersion } from '@archive/media/api';

/** What each restoration op did, as a person names it. */
const STEP_NAMES: Record<string, string> = {
  'image.unfade': 'faded colours',
  'image.defects': 'dust and scratches',
  'image.inpaint': 'dust and scratches',
  'image.denoise': 'grain',
};

/** The steps a restored copy went through, in words, once each. */
export const restoredSteps = (ops: string[]): string => [...new Set(ops.map((op) => STEP_NAMES[op] ?? op))].join(', ');

type Props = {
  /** The restored copy compared; null keeps the dialog closed. */
  version: MediaVersion | null;
  /** The picture it was restored from, as the lightbox shows it. */
  original: MediaItem;
  onClose: () => void;
  /** After the copy is deleted. */
  onDiscarded: () => void;
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
 * A restored copy beside the picture it was made from, to keep or discard. The defect finder's
 * marks can be laid over the original in red: it guesses, and what it took for damage — a button,
 * a highlight in an eye — is painted over in the copy. Discarding deletes the copy; keeping leaves
 * it among the picture's versions.
 */
export function RestoredCompare({ version, original, onClose, onDiscarded }: Props) {
  const [marks, setMarks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMarks(false);
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
  const marked = version.restored?.marked;

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
      subtitle={version.restored ? restoredSteps(version.restored.ops) : version.name}
      icon='wand'
      pattern='media'
    >
      <Stack gap='md'>
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
        {error && <Text size='sm' c='red'>{error}</Text>}
      </Stack>
      <DialogActions>
        <Group gap='xs' mr='auto'>
          <Button component='a' variant='default' href={fileUrl(version.path)} download={version.name}>Download</Button>
        </Group>
        <Button variant='default' color='red' loading={busy} onClick={() => void discard()}>Discard</Button>
        <Button onClick={onClose} disabled={busy}>Keep</Button>
      </DialogActions>
    </Dialog>
  );
}
