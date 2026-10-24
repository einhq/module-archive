import type { StagingCategoryKind, StagingCategoryStatus } from '@archive/staging/api';
import { DialogActions, TablerIcon } from '@ein/ui/components';
import { useAccessIds, useEntityComplete, useSurface } from '@ein/ui/hooks';
import { canWrite, shq } from '@ein/ui/lib';
import { currentUser, execCommand } from '@ein/ui/signals';
import { Alert, Button, Container, Group, Loader, NavLink, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { type ReactNode, useState } from 'react';
import { useParams } from 'react-router-dom';
import { refreshStagingStatus, useStagingStatus } from '../hooks/useStagingStatus.ts';
import { heldFiles, KIND_LABELS, NEW_KINDS } from '../lib/overview.ts';

/** The shell's dialog takes its frame from here; as a page, this is its heading. */
export const handle = { title: 'Category settings', icon: 'settings', pattern: 'staging', dialogSize: 'md', signedIn: true };

/**
 * `/staging/categories/:slug`: one of the reader's staging categories, what it is called, what it
 * holds and the library album its files go to by default (`staging category <name> --label --kind
 * --destination | --no-destination`); and, for an empty one other than the default, Remove
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

/** A library album a category's files go to, as the form holds it. */
type Destination = { path: string; title: string };

function SettingsForm({ category, isDefault }: { category: StagingCategoryStatus; isDefault: boolean }) {
  const surface = useSurface();
  const access = useAccessIds();
  const [label, setLabel] = useState(category.label);
  const [kind, setKind] = useState<StagingCategoryKind>(category.kind);
  const [destination, setDestination] = useState<Destination | null>(category.destination ? { path: category.destination.path, title: category.destination.title } : null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const { hits, loading } = useEntityComplete(query.trim() || undefined, ['album']);
  const albums = hits.filter((hit) => canWrite(hit.ownership, access));
  const empty = heldFiles(category.counts) === 0;

  const flags = (): string[] => {
    const changes: string[] = [];
    const named = label.trim();
    // A new kind resets the label to the kind's own unless the same call names one, so it does.
    if (kind !== category.kind) changes.push(`--kind ${shq(kind)}`, `--label ${shq(named || category.label)}`);
    else if (named && named !== category.label) changes.push(`--label ${shq(named)}`);
    if (destination === null && category.destination) changes.push('--no-destination');
    if (destination !== null && destination.path !== category.destination?.path) changes.push(`--destination ${shq(destination.path)}`);
    return changes;
  };

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
    const changes = flags();
    if (changes.length === 0) return surface.close();
    void run(`staging category ${shq(category.name)} ${changes.join(' ')}`, surface.close);
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
        <TextInput label='Called' required value={label} onChange={(event) => setLabel(event.currentTarget.value)} description={`Its folder is files/${category.name}`} />
        <Select
          label='What it holds'
          data={(isDefault ? ['inbox' as const] : NEW_KINDS).map((each) => ({ value: each, label: KIND_LABELS[each] }))}
          value={kind}
          allowDeselect={false}
          disabled={isDefault}
          description={isDefault ? 'The inbox, where uploads go unless they are put in a category.' : 'Sets how its files are treated by default.'}
          onChange={(value) => value && setKind(value as StagingCategoryKind)}
        />
        <Stack gap={4}>
          <Text size='sm' fw={500}>Files go to</Text>
          {destination
            ? (
              <Group justify='space-between' wrap='nowrap'>
                <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
                  <TablerIcon name='photo' size={16} />
                  <Text size='sm' truncate>{destination.title}</Text>
                </Group>
                <Button size='compact-xs' variant='subtle' onClick={() => setDestination(null)}>None</Button>
              </Group>
            )
            : <Text size='sm' c='dimmed'>No album by default: each group is filed where you choose.</Text>}
          <TextInput
            placeholder='Find an album'
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            rightSection={loading ? <Loader size='xs' /> : undefined}
            aria-label='Find an album its files go to'
          />
          {albums.map((hit) => (
            <NavLink
              key={hit.path}
              label={hit.name}
              description={hit.path}
              leftSection={<TablerIcon name='photo' size={16} />}
              onClick={() => {
                setDestination({ path: hit.path, title: hit.name });
                setQuery('');
              }}
            />
          ))}
        </Stack>
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
