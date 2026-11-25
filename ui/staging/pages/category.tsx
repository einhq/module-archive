import type { StagingCategoryStatus } from '@archive/staging/api';
import { DialogActions, TablerIcon } from '@ein/ui/components';
import { useSurface } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { currentUser, execCommand } from '@ein/ui/signals';
import { Alert, Button, Container, Group, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useState } from 'react';
import { useParams } from 'react-router-dom';
import { refreshStagingStatus, useStagingStatus } from '../hooks/useStagingStatus.ts';
import { heldFiles } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Category settings', icon: 'settings', pattern: 'staging', dialogSize: 'md', signedIn: true };

/**
 * `/staging/categories/:slug`: the name of one of the reader's staging categories
 * (`staging category <name> --label`), and, for an empty one other than the default, Remove
 * (`--remove`).
 */
export default function CategorySettingsPage() {
  useSignals();
  const user = currentUser.value?.username;
  const { slug = '' } = useParams();
  return (
    <Frame>
      {user ? <Settings user={user} slug={slug} /> : <Alert color='yellow'>Sign in to change your private staging area.</Alert>}
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

function Settings({ user, slug }: { user: string; slug: string }) {
  const status = useStagingStatus(user);
  if (status.error) return <Alert color='red' variant='light'>{status.error.message}</Alert>;
  if (!status.data) return <Loader size='sm' />;
  const category = status.data.categories.find((each) => each.name === slug);
  if (!category) return <Alert color='yellow' variant='light'>You have no staging category {slug}.</Alert>;
  return <SettingsForm key={category.name} category={category} isDefault={category.name === status.data.defaultCategory} />;
}

function SettingsForm({ category, isDefault }: { category: StagingCategoryStatus; isDefault: boolean }) {
  const surface = useSurface();
  const [label, setLabel] = useState(category.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const empty = heldFiles(category.counts) === 0;

  const run = async (command: string, then: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await execCommand(command);
      refreshStagingStatus();
      then();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const save = () => {
    const named = label.trim();
    if (!named || named === category.label) return surface.close();
    void run(`staging category ${shq(category.name)} --label ${shq(named)}`, surface.close);
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
        <TextInput label='Name' required value={label} onChange={(event) => setLabel(event.currentTarget.value)} description={`Its folder is files/${category.name}`} />
        {!isDefault && (
          <Stack gap={4}>
            {removing
              ? (
                <Group gap='xs'>
                  <Text size='sm'>Remove {category.label}?</Text>
                  <Button size='xs' color='red' loading={busy} onClick={() => void run(`staging category ${shq(category.name)} --remove`, () => surface.openPage('/staging'))}>
                    Remove
                  </Button>
                  <Button size='xs' variant='default' onClick={() => setRemoving(false)}>Keep it</Button>
                </Group>
              )
              : (
                <Group>
                  <Button size='xs' variant='subtle' color='red' leftSection={<TablerIcon name='trash' size={14} />} disabled={!empty} onClick={() => setRemoving(true)}>
                    Remove category
                  </Button>
                </Group>
              )}
            {!empty && <Text size='xs' c='dimmed'>Only an empty category can be removed: move or discard its files first.</Text>}
          </Stack>
        )}
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={surface.close} disabled={busy}>Cancel</Button>
        <Button type='submit' loading={busy && !removing} disabled={!label.trim()}>Save</Button>
      </DialogActions>
    </form>
  );
}
