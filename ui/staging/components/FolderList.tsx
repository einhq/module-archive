import { TablerIcon } from '@ein/ui/components';
import { formatBytes, type NodeChildEntry, shq } from '@ein/ui/lib';
import { execCommand } from '@ein/ui/signals';
import { Alert, Anchor, Button, Checkbox, Group, Loader, Table, Text } from '@mantine/core';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/** Entries per `ls` page. */
const PAGE = 200;

type Props = {
  /** The folder listed. */
  dir: string;
  /** Changed when what the folder holds changed, so it is listed again. */
  reloadToken: number;
  /** A folder in it was opened, by name. */
  onOpen: (name: string) => void;
  /** What can be done to the selected entries, by path. A change to them comes back as `reloadToken`. */
  actions: (paths: string[]) => ReactNode;
};

/** What an entry is, in a few words: a folder and what it holds, or a file's type. */
const kindOf = (entry: NodeChildEntry): string => {
  if (entry.node.type === 'directory') return entry.childCount === 1 ? 'folder, 1 item' : `folder, ${entry.childCount.toLocaleString()} items`;
  return entry.node.attrs.mimetype ?? entry.node.type;
};

/**
 * One folder's entries as a list, every file whatever its type (`ls -l --limit 200 --after`), a
 * page at a time in name order: where a PDF, a sidecar or any other file that is not media can be
 * seen, selected and moved or discarded. A folder opens on its name.
 */
export function FolderList({ dir, reloadToken, onOpen, actions }: Props) {
  const [entries, setEntries] = useState<NodeChildEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const run = useRef(0);

  const load = useCallback(async (after: string | undefined) => {
    const current = ++run.current;
    setLoading(true);
    try {
      const page = await execCommand<NodeChildEntry[]>(`ls -l ${shq(dir)} --limit ${PAGE}${after === undefined ? '' : ` --after ${shq(after)}`}`);
      if (current !== run.current) return;
      setEntries((held) => after === undefined ? page : [...held, ...page]);
      setMore(page.length === PAGE);
      setError(null);
    } catch (err) {
      if (current === run.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === run.current) setLoading(false);
    }
  }, [dir]);

  useEffect(() => {
    setSelected(new Set());
    void load(undefined);
  }, [load, reloadToken]);

  const toggle = (name: string) =>
    setSelected((held) => {
      const next = new Set(held);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const all = entries.length > 0 && entries.every((entry) => selected.has(entry.name));
  const paths = entries.filter((entry) => selected.has(entry.name)).map((entry) => `${dir}/${entry.name}`);

  if (error) return <Alert color='red' variant='light'>{error}</Alert>;
  if (loading && entries.length === 0) return <Loader size='sm' />;
  if (entries.length === 0) return <Text size='sm' c='dimmed'>This folder is empty.</Text>;

  return (
    <>
      <Group justify='space-between' gap='xs' mih={30}>
        <Text size='sm' c='dimmed'>{paths.length > 0 ? `${paths.length.toLocaleString()} selected` : `${entries.length.toLocaleString()}${more ? '+' : ''} items`}</Text>
        {paths.length > 0 && (
          <Group gap='xs'>
            {actions(paths)}
            <Button size='xs' variant='subtle' onClick={() => setSelected(new Set())}>Clear</Button>
          </Group>
        )}
      </Group>
      <Table.ScrollContainer minWidth={420}>
        <Table verticalSpacing={4} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={36}>
                <Checkbox
                  aria-label='Select all listed'
                  checked={all}
                  indeterminate={!all && paths.length > 0}
                  onChange={() => setSelected(all ? new Set() : new Set(entries.map((entry) => entry.name)))}
                />
              </Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Kind</Table.Th>
              <Table.Th ta='right'>Size</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((entry) => {
              const folder = entry.node.type === 'directory';
              return (
                <Table.Tr key={entry.name}>
                  <Table.Td>
                    <Checkbox aria-label={`Select ${entry.name}`} checked={selected.has(entry.name)} onChange={() => toggle(entry.name)} />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap='nowrap'>
                      <TablerIcon name={folder ? 'folder' : 'file'} size={16} />
                      {folder
                        ? <Anchor component='button' type='button' size='sm' onClick={() => onOpen(entry.name)}>{entry.name}</Anchor>
                        : <Text size='sm' style={{ overflowWrap: 'anywhere' }}>{entry.name}</Text>}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size='xs' c='dimmed'>{kindOf(entry)}</Text>
                  </Table.Td>
                  <Table.Td ta='right'>
                    <Text size='xs' c='dimmed'>{folder ? '' : formatBytes(entry.node.attrs.size)}</Text>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {more && (
        <Group justify='center'>
          <Button size='xs' variant='default' loading={loading} onClick={() => void load(entries.at(-1)?.name)}>Show more</Button>
        </Group>
      )}
    </>
  );
}
