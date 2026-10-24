import { Alert, Button, Group, Loader, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import { ALBUMS_ROOT } from '@archive/paths';
import { CoverAvatar, Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { useAccessIds, useEntityComplete } from '@ein/ui/hooks';
import { canWrite } from '@ein/ui/lib';

/** The album picked: one that is there, or a new one to make under `title` at `path`. */
export type AlbumChoice = { path: string; title: string; create: boolean };

type Props = {
  opened: boolean;
  title: string;
  subtitle?: string;
  /** Offer a new album under the name typed. */
  allowNew?: boolean;
  /** A few albums to offer before anything is typed: the recent ones. */
  suggested?: { path: string; title: string }[];
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onPick: (choice: AlbumChoice) => void;
};

/**
 * Pick a library album: find one by name, take one of the suggested ones (digits pick them), or
 * name a new one. Only albums the reader may change are offered; one whose name is typed exactly
 * is listed even when it is not, as view only, so the reader sees why no new album of that name is
 * offered.
 */
export function AlbumPickerDialog({ opened, title, subtitle, allowNew = true, suggested = [], busy = false, error, onClose, onPick }: Props) {
  const access = useAccessIds();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (opened) setQuery('');
  }, [opened]);
  const words = query.trim();
  const { hits, loading } = useEntityComplete(opened && words ? words : undefined, ['album']);
  const isExact = (name: string) => name.toLocaleLowerCase() === words.toLocaleLowerCase();
  const exact = hits.some((hit) => isExact(hit.name));
  const shown = hits
    .map((hit) => ({ hit, writable: canWrite(hit.ownership, access) }))
    .filter(({ hit, writable }) => writable || isExact(hit.name));

  return (
    <Dialog
      opened={opened}
      onClose={() => !busy && onClose()}
      title={title}
      subtitle={subtitle}
      icon='library-plus'
      pattern='album'
      size='md'
    >
      <Stack gap='sm'>
        <TextInput
          data-autofocus
          placeholder={allowNew ? 'Find an album, or name a new one' : 'Find an album'}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            const digit = Number(event.key);
            if (!words && Number.isInteger(digit) && digit >= 1 && digit <= suggested.length) {
              event.preventDefault();
              onPick({ ...suggested[digit - 1], create: false });
            }
          }}
          leftSection={<TablerIcon name='search' size={16} />}
          rightSection={loading ? <Loader size={14} /> : undefined}
        />
        {/* Room for a few hits from the start, so the dialog does not grow under the pointer as they come. */}
        <Stack gap={2} mih={232}>
          {!words && suggested.length === 0 && <Text size='sm' c='dimmed' px='xs'>Type part of an album's name.</Text>}
          {!words && suggested.map((album, index) => (
            <UnstyledButton
              key={album.path}
              className='mrx-pick-row'
              disabled={busy}
              onClick={() => onPick({ ...album, create: false })}
            >
              <Group gap='sm' wrap='nowrap'>
                <CoverAvatar path={album.path} size={36} radius='sm' fallback={<TablerIcon name='photo' size={18} />} />
                <Text size='sm' truncate style={{ flex: 1 }}>{album.title}</Text>
                <Text size='xs' c='dimmed'>{index + 1}</Text>
              </Group>
            </UnstyledButton>
          ))}
          {shown.map(({ hit, writable }) => (
            <UnstyledButton
              key={hit.path}
              className='mrx-pick-row'
              disabled={busy || !writable}
              onClick={() => onPick({ path: hit.path, title: hit.name, create: false })}
            >
              <Group gap='sm' wrap='nowrap'>
                <CoverAvatar path={hit.path} size={36} radius='sm' fallback={<TablerIcon name='photo' size={18} />} />
                <Text size='sm' truncate c={writable ? undefined : 'dimmed'} style={{ flex: 1 }}>{hit.name}</Text>
                {!writable && (
                  <Group gap={4} wrap='nowrap' c='dimmed'>
                    <TablerIcon name='lock' size={14} />
                    <Text size='xs'>View only</Text>
                  </Group>
                )}
              </Group>
            </UnstyledButton>
          ))}
        </Stack>
        {error && <Alert color='red' variant='light' icon={<TablerIcon name='alert-circle' size={16} />}>{error}</Alert>}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        {allowNew && words && !exact && (
          <Button
            leftSection={<TablerIcon name='plus' size={16} />}
            loading={busy}
            onClick={() => onPick({ path: `${ALBUMS_ROOT}/${words.replaceAll('/', '-')}`, title: words, create: true })}
            style={{ minWidth: 0 }}
          >
            <Text span inherit truncate>New album “{words}”</Text>
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
