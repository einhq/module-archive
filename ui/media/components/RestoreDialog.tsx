import { Alert, Button, Checkbox, Radio, Slider, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { FileRestoreAnswer } from '@media/api';

/** The pictures `file-restore` takes: what EMS's restoration ops read. */
export const RESTORABLE = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/bmp']);

type Props = {
  opened: boolean;
  onClose: () => void;
  path: string;
  /** A scan: its faded colours and its dust are what is offered first. */
  digitized?: boolean;
  /** The copy written, once `file-restore` has answered. */
  onRestored: (answer: FileRestoreAnswer) => void;
};

/**
 * What to restore in a picture, asked before `file-restore` runs: faded colours, dust and scratches
 * (darker marks too, filled quickly or with care), grain. The picture itself is never changed: the
 * result is a copy kept among its versions. It takes from seconds to a few minutes, by the size of
 * the picture and the steps, and the dialog waits for it.
 */
export function RestoreDialog({ opened, onClose, path, digitized, onRestored }: Props) {
  const [unfade, setUnfade] = useState(true);
  const [dust, setDust] = useState(true);
  const [dark, setDark] = useState(false);
  const [fill, setFill] = useState<'ns' | 'lama'>('ns');
  const [grain, setGrain] = useState(false);
  const [strength, setStrength] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setUnfade(Boolean(digitized));
    setDust(true);
    setDark(false);
    setFill('ns');
    setGrain(false);
    setStrength(0.5);
    setError(null);
  }, [opened, path]);

  const nothing = !unfade && !dust && !grain;
  const restore = async () => {
    if (busy || nothing) return;
    setBusy(true);
    setError(null);
    const flags = [
      unfade && '--unfade',
      dust && '--dust',
      dust && dark && '--dark',
      dust && fill !== 'ns' && `--fill ${fill}`,
      grain && `--grain ${strength}`,
    ].filter(Boolean).join(' ');
    try {
      onRestored(await execCommand<FileRestoreAnswer>(`file-restore ${shq(path)} ${flags}`));
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
      title='Restore'
      subtitle={path.split('/').pop()}
      icon='wand'
      pattern='media'
      size='md'
      onSubmit={restore}
    >
      <Stack gap='md'>
        <Text size='sm' c='dimmed'>
          The picture is not changed: the restored copy is kept beside it, among its versions, to compare and keep or discard.
        </Text>
        <Checkbox
          checked={unfade}
          onChange={(event) => setUnfade(event.currentTarget.checked)}
          disabled={busy}
          label='Faded colours'
          description='Brings back the colours and contrast of a print or slide that has turned red, yellow or pale. For colour pictures.'
        />
        <Stack gap={6}>
          <Checkbox
            checked={dust}
            onChange={(event) => setDust(event.currentTarget.checked)}
            disabled={busy}
            label='Dust and scratches'
            description='Finds specks, scratches and cracks and fills them from what is around them. It guesses, so compare before you keep it.'
          />
          {dust && (
            <Stack gap={6} pl={32}>
              <Checkbox size='xs' checked={dark} onChange={(event) => setDark(event.currentTarget.checked)} disabled={busy} label='Dark marks too' />
              <Radio.Group value={fill} onChange={(value) => setFill(value as 'ns' | 'lama')}>
                <Stack gap={4}>
                  <Radio size='xs' value='ns' disabled={busy} label='Quick fill, for dust and thin scratches' />
                  <Radio size='xs' value='lama' disabled={busy} label='Careful fill, for creases and tears' />
                </Stack>
              </Radio.Group>
            </Stack>
          )}
        </Stack>
        <Stack gap={6}>
          <Checkbox
            checked={grain}
            onChange={(event) => setGrain(event.currentTarget.checked)}
            disabled={busy}
            label='Grain and noise'
            description='Smooths film grain and scanner noise. Grain is part of a photograph: at half strength about half of it is left.'
          />
          {grain && (
            <Slider
              ml={32}
              mr='md'
              min={0.1}
              max={1}
              step={0.1}
              value={strength}
              onChange={setStrength}
              disabled={busy}
              label={(value) => `${Math.round(value * 100)} %`}
              marks={[{ value: 0.5, label: 'half' }, { value: 1, label: 'all' }]}
              mb='md'
            />
          )}
        </Stack>
        {busy && <Text size='sm' c='dimmed'>Restoring. A large scan takes a minute or two.</Text>}
        {error && <Alert color='red' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={nothing}>Restore</Button>
      </DialogActions>
    </Dialog>
  );
}
