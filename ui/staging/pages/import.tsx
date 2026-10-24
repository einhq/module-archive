import type { StagingCategoryAnswer, StagingCategoryKind } from '@archive/staging/api';
import { DialogActions, TablerIcon } from '@ein/ui/components';
import { useSurface } from '@ein/ui/hooks';
import { countOf, formatBytes, shq } from '@ein/ui/lib';
import { addToQueue, currentUser, execCommand } from '@ein/ui/signals';
import { Alert, Button, Container, FileButton, Group, Radio, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SftpPath } from '../components/SftpPath.tsx';
import { refreshStagingStatus, stagingUploadFolder, useStagingStatus } from '../hooks/useStagingStatus.ts';
import { categorySlug, freeSlug, heldFiles, KIND_LABELS, NEW_KINDS } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Import media', icon: 'cloud-upload', pattern: 'staging', dialogSize: 'md', signedIn: true };

/** The choice that makes a new category rather than naming one. */
const NEW = '\u0000new';

/** A file input that picks a folder, with everything in it. */
const FOLDER_INPUT = { webkitdirectory: '' } as ComponentProps<'input'>;

/** How many folders `files` were picked in, by the paths a folder picker gives them. */
const foldersOf = (files: File[]): number => new Set(files.map((file) => file.webkitRelativePath.split('/').slice(0, -1).join('/')).filter(Boolean)).size;

/**
 * `/staging/import`: files into one of the reader's staging categories (`?c=` chooses it; the
 * default one otherwise), or into a new one made first (`staging category --create`). Files or a
 * folder are chosen; they are queued into the category's upload folder of today, a folder keeping
 * its structure there, and the category's Files tab opens while they upload. For more files than a
 * browser should carry, the category's folder to copy them into over SFTP.
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
  const [kind, setKind] = useState<StagingCategoryKind>('google-photos');
  const [label, setLabel] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = choice !== null && (choice === NEW || categories.some((category) => category.name === choice)) ? choice : status.data?.defaultCategory ?? null;
  const making = chosen === NEW;
  const newLabel = label.trim() || KIND_LABELS[kind];
  const newName = freeSlug(categorySlug(newLabel), categories.map((category) => category.name));
  const target = making ? undefined : categories.find((category) => category.name === chosen)?.path;
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const folders = foldersOf(files);

  const upload = async () => {
    if (!chosen || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let category = categories.find((each) => each.name === chosen);
      if (making) {
        const answer = await execCommand<StagingCategoryAnswer>(`staging category ${shq(newName)} --create --kind ${shq(kind)} --label ${shq(newLabel)}`);
        refreshStagingStatus();
        category = answer.category ?? undefined;
      }
      const name = category?.name ?? newName;
      addToQueue(files, category?.uploadPath ?? stagingUploadFolder(user, name), { keepFolders: true, label: category?.label ?? newLabel });
      surface.openPage(`/staging?c=${encodeURIComponent(name)}&tab=files`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className='mrx-dialog-form'
      onSubmit={(event) => {
        event.preventDefault();
        void upload();
      }}
    >
      <Stack gap='md'>
        {(error || status.error) && <Alert color='red' variant='light'>{error ?? status.error?.message}</Alert>}
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
            <Radio value={NEW} label='New category' description='For one source kept together: an export, a box of scans, a phone.' />
          </Stack>
        </Radio.Group>
        {making && (
          <Group grow align='flex-start' gap='sm'>
            <Select
              label='What it holds'
              data={NEW_KINDS.map((each) => ({ value: each, label: KIND_LABELS[each] }))}
              value={kind}
              allowDeselect={false}
              onChange={(value) => value && setKind(value as StagingCategoryKind)}
            />
            <TextInput
              label='Called'
              placeholder={KIND_LABELS[kind]}
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
              description={newName ? `Folder files/${newName}` : 'Needs a letter or digit'}
            />
          </Group>
        )}
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
        {making
          ? (
            <Text size='sm' c='dimmed'>
              Copying a large export over SFTP instead? Make the category first, under New category on the Staging page, then copy into its folder.
            </Text>
          )
          : target && (
            <Stack gap={4}>
              <Text size='sm' c='dimmed'>Over about 10,000 files? Copy them over SFTP instead, folders and all, into</Text>
              <SftpPath path={`${target}/`} />
            </Stack>
          )}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={surface.close} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy} disabled={files.length === 0 || !chosen || (making && !newName)}>
          {files.length > 0 ? `Upload ${files.length.toLocaleString()}` : 'Upload'}
        </Button>
      </DialogActions>
    </form>
  );
}
