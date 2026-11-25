import { DialogActions, TablerIcon } from '@ein/ui/components';
import { useSurface } from '@ein/ui/hooks';
import { countOf, formatBytes } from '@ein/ui/lib';
import { addToQueue, currentUser, takeSharedFiles } from '@ein/ui/signals';
import { Alert, Anchor, Button, Container, FileButton, Group, Radio, Stack, Text, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStagingStatus } from '../hooks/useStagingStatus.ts';
import { heldFiles } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Import media', icon: 'cloud-upload', pattern: 'staging', dialogSize: 'md', signedIn: true };

/** A file input that picks a folder, with everything in it. */
const FOLDER_INPUT = { webkitdirectory: '' } as ComponentProps<'input'>;

/** How many folders `files` were picked in, by the paths a folder picker gives them. */
const foldersOf = (files: File[]): number => new Set(files.map((file) => file.webkitRelativePath.split('/').slice(0, -1).join('/')).filter(Boolean)).size;

/**
 * `/staging/import`: files into one of the reader's staging categories (`?c=` chooses it; the
 * default one otherwise). Files or a folder are chosen, or come chosen when another app shared
 * them to EiN (the `share.receive` panel); they are queued into the category's upload folder of
 * today, a folder keeping its structure there, and the category's Files tab opens while they
 * upload. For more files than a browser should carry, a way to the category's Info tab.
 */
export default function ImportPage() {
  useSignals();
  const user = currentUser.value?.username;
  return (
    <Frame>
      {user ? <Import user={user} /> : <Alert color='yellow'>Sign in to import into your private staging area.</Alert>}
    </Frame>
  );
}

/** In the shell's dialog as it is; as a page, under the route's title. */
function Frame({ children }: { children: ReactNode }) {
  const surface = useSurface();
  if (surface.kind !== 'page') return <>{children}</>;
  return (
    <Container size='sm' py='xl'>
      <Title order={2} mb='lg'>{handle.title}</Title>
      {children}
    </Container>
  );
}

function Import({ user }: { user: string }) {
  const surface = useSurface();
  const [params] = useSearchParams();
  const status = useStagingStatus(user);
  const categories = status.data?.categories ?? [];
  const [choice, setChoice] = useState<string | null>(params.get('c'));
  const [files, setFiles] = useState<File[]>(takeSharedFiles);

  const chosen = choice !== null && categories.some((category) => category.name === choice) ? choice : status.data?.defaultCategory ?? null;
  const target = categories.find((category) => category.name === chosen);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const folders = foldersOf(files);

  const upload = () => {
    if (!target || files.length === 0) return;
    addToQueue(files, target.uploadPath, { keepFolders: true, label: target.label });
    surface.openPage(`/staging?c=${encodeURIComponent(target.name)}`);
  };

  return (
    <form
      className='mrx-dialog-form'
      onSubmit={(event) => {
        event.preventDefault();
        upload();
      }}
    >
      <Stack gap='md'>
        {status.error && <Alert color='red' variant='light'>{status.error.message}</Alert>}
        <Radio.Group label='Into which category?' value={chosen} onChange={setChoice}>
          <Stack gap='xs' mt='xs'>
            {categories.map((category) => (
              <Radio
                key={category.name}
                value={category.name}
                label={category.label}
                description={`${countOf(heldFiles(category.counts), 'file', 'files')} · files/${category.name}`}
              />
            ))}
          </Stack>
        </Radio.Group>
        <Stack gap={4}>
          <Group gap='sm'>
            <FileButton onChange={setFiles} multiple>
              {(props) => <Button {...props} variant='default' leftSection={<TablerIcon name='files' size={16} />}>Choose files</Button>}
            </FileButton>
            <FileButton onChange={setFiles} multiple inputProps={FOLDER_INPUT}>
              {(props) => <Button {...props} variant='default' leftSection={<TablerIcon name='folder-open' size={16} />}>Choose a folder</Button>}
            </FileButton>
          </Group>
          <Text size='sm' c='dimmed'>
            {files.length > 0
              ? `${countOf(files.length, 'file', 'files')}${folders > 0 ? ` in ${countOf(folders, 'folder', 'folders')}` : ''}, ${formatBytes(bytes)}`
              : 'Or drop files or folders on the Staging page. Folders keep their structure, and their names help grouping.'}
          </Text>
        </Stack>
        {target && (
          <Text size='sm' c='dimmed'>
            Over about 10,000 files, or a phone that backs itself up? See{' '}
            <Anchor component='button' type='button' size='sm' onClick={() => surface.openPage(`/staging?c=${encodeURIComponent(target.name)}&tab=info`)}>Info</Anchor>.
          </Text>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={surface.close}>Cancel</Button>
        <Button type='submit' disabled={files.length === 0 || !target}>
          {files.length > 0 ? `Upload ${files.length.toLocaleString()}` : 'Upload'}
        </Button>
      </DialogActions>
    </form>
  );
}
