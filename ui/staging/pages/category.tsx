import type { StagingCategoryStatus } from '@archive/staging/api';
import { DialogActions, TablerIcon } from '@ein/ui/components';
import { useSurface } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { currentUser, execCommand } from '@ein/ui/signals';
import { Alert, Button, Container, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useState } from 'react';
import { useParams } from 'react-router-dom';
import { refreshStagingStatus, useStagingStatus } from '../hooks/useStagingStatus.ts';
import { heldFiles } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Edit category', icon: 'pencil', pattern: 'staging', dialogSize: 'md', signedIn: true };

/**
 * `/staging/categories/:slug`: the name of one of the reader's staging categories
 * (`staging category <name> --label`), and, at the left of the dialog's buttons for any but the
 * default, Remove (`--remove`), which only an empty one allows.
 */
export default function EditCategoryPage() {
  useSignals();
  const user = currentUser.value?.username;
  const { slug = '' } = useParams();
  return (
    <Frame>
      {user ? <Edit user={user} slug={slug} /> : <Alert color='yellow'>Sign in to change your private staging area.</Alert>}
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

function Edit({ user, slug }: { user: string; slug: string }) {
  const status = useStagingStatus(user);
  if (status.error) return <Alert color='red' variant='light'>{status.error.message}</Alert>;
  if (!status.data) return <Loader size='sm' />;
  const category = status.data.categories.find((each) => each.name === slug);
  if (!category) return <Alert color='yellow' variant='light'>You have no staging category {slug}.</Alert>;
  return <EditForm key={category.name} category={category} isDefault={category.name === status.data.defaultCategory} />;
}

function EditForm({ category, isDefault }: { category: StagingCategoryStatus; isDefault: boolean }) {
  const surface = useSurface();
  const [label, setLabel] = useState(category.label);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const empty = heldFiles(category.counts) === 0;

  const run = async (doing: 'save' | 'remove', command: string, then: () => void) => {
    setBusy(doing);
    setError(null);
    try {
      await execCommand(command);
      refreshStagingStatus();
      then();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const save = () => {
    const named = label.trim();
    if (!named || named === category.label) return surface.close();
    void run('save', `staging category ${shq(category.name)} --label ${shq(named)}`, surface.close);
  };

  return (
    <form
      className='mrx-dialog-form'
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Stack gap='md'>
        {error && <Alert color='red' variant='light'>{error}</Alert>}
        <TextInput label='Name' required value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
        {!isDefault && !empty && <Text size='xs' c='dimmed'>Only an empty category can be removed: move or discard its files first.</Text>}
      </Stack>
      <DialogActions>
        {!isDefault && (
          <Button
            variant='light'
            color='red'
            mr='auto'
            leftSection={<TablerIcon name='trash' size={16} />}
            loading={busy === 'remove'}
            disabled={!empty || busy === 'save'}
            onClick={() => void run('remove', `staging category ${shq(category.name)} --remove`, () => surface.openPage('/staging'))}
          >
            Remove
          </Button>
        )}
        <Button variant='default' onClick={surface.close} disabled={busy !== null}>Cancel</Button>
        <Button type='submit' loading={busy === 'save'} disabled={!label.trim() || busy === 'remove'}>Save</Button>
      </DialogActions>
    </form>
  );
}
