import { Alert, Button, Checkbox, Radio, Slider, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import type { FileRestoreAnswer } from '@media/api';

/** The pictures `file-restore` takes: what EMS's restoration ops read. */
export const RESTORABLE = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/bmp']);

/** The steps a restoration is asked for, as the dialogs hold them. */
export type RestoreSteps = { unfade: boolean; dust: boolean; dark: boolean; fill: 'ns' | 'lama'; grain: boolean; strength: number };

/** The steps first offered: faded colours for a scan, dust and scratches always. */
export const restoreStepsFor = (digitized: boolean): RestoreSteps => ({ unfade: digitized, dust: true, dark: false, fill: 'ns', grain: false, strength: 0.5 });

/** Whether no step is asked for. */
export const nothingToRestore = (steps: RestoreSteps): boolean => !steps.unfade && !steps.dust && !steps.grain;

/** The steps as `file-restore`'s flags. */
export const restoreFlags = (steps: RestoreSteps): string =>
  [
    steps.unfade && '--unfade',
    steps.dust && '--dust',
    steps.dust && steps.dark && '--dark',
    steps.dust && steps.fill !== 'ns' && `--fill ${steps.fill}`,
    steps.grain && `--grain ${steps.strength}`,
  ].filter(Boolean).join(' ');

/** The steps to tick: faded colours, dust and scratches (darker marks too, filled quickly or with care), grain. */
export function RestoreChoices({ steps, onChange, disabled }: { steps: RestoreSteps; onChange: (steps: RestoreSteps) => void; disabled?: boolean }) {
  const set = (changes: Partial<RestoreSteps>) => onChange({ ...steps, ...changes });
  return (
    <>
      <Checkbox
        checked={steps.unfade}
        onChange={(event) => set({ unfade: event.currentTarget.checked })}
        disabled={disabled}
        label='Faded colours'
        description='Brings back the colours and contrast of a print or slide that has turned red, yellow or pale. For colour pictures.'
      />
      <Stack gap={6}>
        <Checkbox
          checked={steps.dust}
          onChange={(event) => set({ dust: event.currentTarget.checked })}
          disabled={disabled}
          label='Dust and scratches'
          description='Finds specks, scratches and cracks and fills them from what is around them. It guesses, so compare before you keep it.'
        />
        {steps.dust && (
          <Stack gap={6} pl={32}>
            <Checkbox size='xs' checked={steps.dark} onChange={(event) => set({ dark: event.currentTarget.checked })} disabled={disabled} label='Dark marks too' />
            <Radio.Group value={steps.fill} onChange={(value) => set({ fill: value as 'ns' | 'lama' })}>
              <Stack gap={4}>
                <Radio size='xs' value='ns' disabled={disabled} label='Quick fill, for dust and thin scratches' />
                <Radio size='xs' value='lama' disabled={disabled} label='Careful fill, for creases and tears' />
              </Stack>
            </Radio.Group>
          </Stack>
        )}
      </Stack>
      <Stack gap={6}>
        <Checkbox
          checked={steps.grain}
          onChange={(event) => set({ grain: event.currentTarget.checked })}
          disabled={disabled}
          label='Grain and noise'
          description='Smooths film grain and scanner noise. Grain is part of a photograph: at half strength about half of it is left.'
        />
        {steps.grain && (
          <Slider
            ml={32}
            mr='md'
            min={0.1}
            max={1}
            step={0.1}
            value={steps.strength}
            onChange={(strength) => set({ strength })}
            disabled={disabled}
            label={(value) => `${Math.round(value * 100)} %`}
            marks={[{ value: 0.5, label: 'half' }, { value: 1, label: 'all' }]}
            mb='md'
          />
        )}
      </Stack>
    </>
  );
}

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
  const [steps, setSteps] = useState<RestoreSteps>(() => restoreStepsFor(Boolean(digitized)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setSteps(restoreStepsFor(Boolean(digitized)));
    setError(null);
  }, [opened, path]);

  const nothing = nothingToRestore(steps);
  const restore = async () => {
    if (busy || nothing) return;
    setBusy(true);
    setError(null);
    try {
      onRestored(await execCommand<FileRestoreAnswer>(`file-restore ${shq(path)} ${restoreFlags(steps)}`));
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
        <RestoreChoices steps={steps} onChange={setSteps} disabled={busy} />
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
