import type { StagingCategoryStatus, StagingMoveResult } from '@archive/staging/api';
import type { FindEntry, MvAnswer } from '@ein/api';
import { Dialog, DialogActions, TablerIcon } from '@ein/ui/components';
import { useCommand } from '@ein/ui/hooks';
import { shq } from '@ein/ui/lib';
import { execCommand, notify } from '@ein/ui/signals';
import { Alert, Anchor, Breadcrumbs, Button, Loader, NavLink, ScrollArea, Select, Stack, Text, TextInput } from '@mantine/core';
import { useMemo, useState } from 'react';
import { crumbs, folderPath, isFolderName, moveBlocked } from '../lib/folders.ts';

type Props = {
  /** What moves: folders and files of a category. */
  paths: string[];
  /** What the dialog calls them: a folder's name, or "3 items". */
  what: string;
  categories: StagingCategoryStatus[];
  /** The category they are in now. */
  from: StagingCategoryStatus;
  /** Whether the move is to another category ("Move to category…") rather than to a folder of this one. */
  toCategory: boolean;
  /** The category chosen when the dialog opens, by name; the first other one (or this one) by default. */
  initialCategory?: string;
  onClose: () => void;
  /** Called once anything has moved. */
  onMoved: () => void;
};

/**
 * Move folders and files to a folder of a category, with every link to them and below them
 * re-pointed: within the category by `mv -n`, so its suggested groups keep finding them; to
 * another by `staging move`, which first takes them out of this category's groups, which hold only
 * what is in it. Pick the category, step down to a folder, or name a new one there. A name already
 * taken where they go is left where it was, and said.
 */
export function MoveDialog({ paths, what, categories, from, toCategory, initialCategory, onClose, onMoved }: Props) {
  const others = categories.filter((category) => category.name !== from.name);
  const offered = toCategory ? others : categories;
  const [categoryName, setCategoryName] = useState(
    offered.find((each) => each.name === initialCategory)?.name ?? (toCategory ? others[0]?.name ?? from.name : from.name),
  );
  const [dir, setDir] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const category = categories.find((each) => each.name === categoryName) ?? from;
  const location = folderPath(category.path, dir);
  const folders = useCommand<FindEntry[]>(`find ${shq(location)} -mindepth 1 -maxdepth 1 -type d`);
  const subfolders = useMemo(() => (folders.data ?? []).toSorted((a, b) => a.name.localeCompare(b.name)), [folders.data]);

  const folderName = newFolder.trim();
  const target = folderName ? `${location}/${folderName}` : location;
  const blocked = folderName && !isFolderName(folderName) ? 'name' : moveBlocked(target, paths);
  const targetName = [category.label, ...crumbs(dir).map((crumb) => crumb.name), ...(folderName ? [folderName] : [])].join(' › ');

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      if (folderName) await execCommand(`mkdir -p ${shq(target)}`);
      // To another category through staging, which takes them out of this one's groups first.
      const answer = category.name === from.name
        ? await execCommand<MvAnswer>(`mv -n ${paths.map(shq).join(' ')} ${shq(target)}`)
        : await execCommand<StagingMoveResult>(`staging move ${paths.map(shq).join(' ')} ${shq(target)}`);
      onMoved();
      onClose();
      if (answer.failed.length > 0) {
        notify({
          message: `Moved ${answer.moved} of ${paths.length} into ${targetName}; ${answer.failed.length} could not: ${answer.failed[0].error}`,
          color: 'yellow',
        });
      } else notify({ message: `Moved ${what} into ${targetName}`, color: 'green' });
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
      title={toCategory ? 'Move to category' : 'Move to folder'}
      subtitle={what}
      icon={toCategory ? 'category' : 'folder-symlink'}
      pattern='staging'
      size='md'
    >
      <Stack gap='sm'>
        {error && <Alert color='red' variant='light'>{error}</Alert>}
        <Select
          label='Category'
          data={offered.map((each) => ({ value: each.name, label: each.label }))}
          value={categoryName}
          allowDeselect={false}
          onChange={(value) => {
            if (!value) return;
            setCategoryName(value);
            setDir('');
          }}
        />
        <Breadcrumbs separator='›'>
          <Anchor component='button' type='button' size='sm' onClick={() => setDir('')}>{category.label}</Anchor>
          {crumbs(dir).map((crumb) => <Anchor key={crumb.dir} component='button' type='button' size='sm' onClick={() => setDir(crumb.dir)}>{crumb.name}</Anchor>)}
        </Breadcrumbs>
        <ScrollArea.Autosize mah={240} type='auto'>
          {folders.loading && !folders.data
            ? <Loader size='sm' />
            : subfolders.length === 0
            ? <Text size='sm' c='dimmed'>No folders here.</Text>
            : subfolders.map((folder) => (
              <NavLink
                key={folder.path}
                label={folder.name}
                leftSection={<TablerIcon name='folder' size={16} />}
                rightSection={<TablerIcon name='chevron-right' size={14} />}
                // A folder that moves cannot take itself in.
                disabled={paths.includes(folder.path)}
                onClick={() => setDir(dir ? `${dir}/${folder.name}` : folder.name)}
              />
            ))}
        </ScrollArea.Autosize>
        <TextInput
          label='Into a new folder here'
          placeholder='Optional'
          value={newFolder}
          onChange={(event) => setNewFolder(event.currentTarget.value)}
          error={blocked === 'name' ? 'A folder name is one name, without /' : undefined}
        />
        <Text size='xs' c='dimmed'>
          {blocked === 'into-itself'
            ? 'A folder cannot be moved into itself.'
            : blocked === 'already-there'
            ? 'They are there already.'
            : `Into ${targetName}. Links to them, in albums and suggested groups, follow them.`}
        </Text>
      </Stack>
      <DialogActions>
        <Button variant='default' onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void move()} loading={busy} disabled={blocked !== undefined}>Move here</Button>
      </DialogActions>
    </Dialog>
  );
}
