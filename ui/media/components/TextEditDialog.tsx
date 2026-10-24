/**
 * Writing the text in a picture by hand: the picture, zoomable to read it closely, beside an
 * ordinary text box holding the text there is. Side by side on a wide screen, the picture above the
 * box on a narrow one.
 */

import { Dialog, DialogActions } from '@ein/ui/components';
import type { MediaItem } from '@ein/ui/signals';
import { Box, Button, Text, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { usePictureText } from '../hooks/usePictureText.ts';
import { ZoomableImage } from './ZoomableImage.tsx';

type TextEditDialogProps = {
  opened: boolean;
  media: MediaItem;
  reloadToken: number;
  /** The text the details carry, the start of it when `truncated`. */
  text: string;
  truncated: boolean;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
};

export function TextEditDialog({ opened, media, reloadToken, text, truncated, onSave, onClose }: TextEditDialogProps) {
  const isNarrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const current = usePictureText(media.path, text, truncated);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filled when the dialog opens and once the whole text is there; not again, or it would undo the typing.
  useEffect(() => {
    if (!opened || !current.whole) return;
    setDraft(current.text);
    setError(null);
  }, [opened, current.whole, media.path]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      opened={opened}
      onClose={onClose}
      // The lightbox's Escape closes it, and only it.
      closeOnEscape={false}
      fullScreen={isNarrow}
      size='screen'
      zIndex={300}
      title='Text in the picture'
      subtitle={media.name}
      icon='text-scan-2'
      pattern='media'
      bleed
    >
      <Box
        data-text-edit
        style={{
          display: 'flex',
          flexDirection: isNarrow ? 'column' : 'row',
          flex: 1,
          minHeight: 0,
          height: isNarrow ? undefined : 'min(78dvh, 900px)',
        }}
      >
        <Box style={{ flex: isNarrow ? '0 0 45%' : '3 1 0', minWidth: 0, minHeight: 0 }}>
          <ZoomableImage media={media} reloadToken={reloadToken} alt={media.name} />
        </Box>
        <Box style={{ flex: '2 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 'var(--mantine-spacing-md)' }}>
          <Textarea
            aria-label='Text in the picture'
            placeholder={current.whole ? 'What is written in the picture' : 'Loading the text…'}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && current.whole && !saving) void save();
            }}
            disabled={!current.whole || saving}
            data-autofocus
            styles={{
              root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
              wrapper: { flex: 1, display: 'flex', minHeight: 0 },
              input: { flex: 1, height: 'auto', minHeight: 160, fontFamily: 'var(--mrx-font-typewriter)', fontSize: 'var(--mantine-font-size-lg)' },
            }}
          />
          {error && <Text size='sm' c='red' mt='xs'>{error}</Text>}
        </Box>
      </Box>
      <DialogActions hint='Ctrl+Enter saves. Empty text removes it.'>
        <Button variant='default' onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!current.whole}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
