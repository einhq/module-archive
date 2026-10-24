import { TablerIcon } from '@ein/ui/components';
import { Alert, Button, Group, Loader, SegmentedControl, Stack, Text, UnstyledButton } from '@mantine/core';
import { type ReactNode, useEffect, useState } from 'react';
import type { ExactDuplicateScan, ExactDuplicatesOf, FuzzyDuplicateScan, FuzzyDuplicatesOf } from '@archive/media/api';
import { baseName, formatBytes, gridUrl, parentPath, shq } from '@ein/ui/lib';
import { execCommand, revealNodeInNewTab } from '@ein/ui/signals';

/** Groups drawn from a scan; the rest are counted, since a whole archive can have thousands. */
const SHOWN_GROUPS = 100;
const THUMB = 36;

type ScanMode = 'exact' | 'fuzzy';
type Loaded<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: T };
type Scan = { mode: 'exact'; result: ExactDuplicateScan } | { mode: 'fuzzy'; result: FuzzyDuplicateScan };

/**
 * A scan of a subtree walks it and looks up its media's checksums or
 * fingerprints, which takes a while on a large one. It is run only when asked
 * for, and kept for the visit: stepping onto a result and back to the
 * directory shows it again rather than scanning afresh.
 */
const scans = new Map<string, Scan>();
const scanKey = (mode: ScanMode, path: string) => `${mode} ${path}`;

/**
 * The command's own message, without the `duplicates: ` it prefixes for a
 * terminal; a file the pipeline has not reached yet is said so in words.
 */
const messageOf = (err: unknown): string => {
  const message = (err instanceof Error ? err.message : String(err)).replace(/^duplicates:\s*/, '').trim();
  if (/has no checksum/.test(message)) return 'No checksum yet: the file has not been through the pipeline.';
  if (/has no \S+ fingerprint/.test(message)) return 'No fingerprint yet: the file has not been through the pipeline.';
  return message;
};

function useCommand<T>(command: string | null): Loaded<T> | null {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    if (!command) {
      setState(null);
      return;
    }
    let live = true;
    setState({ kind: 'loading' });
    execCommand<T>(command).then(
      (value) => live && setState({ kind: 'ready', value }),
      (err) => live && setState({ kind: 'error', message: messageOf(err) }),
    );
    return () => {
      live = false;
    };
  }, [command]);
  return state;
}

/**
 * One file found, with its picture when it has one. A click shows it in a
 * new tab beside this one, so the tab the tool was run from stays where it is.
 * `under` is the scanned directory, which is left off the paths inside it.
 */
function FoundFile({ path, note, under }: { path: string; note?: string; under?: string }) {
  const [thumb, setThumb] = useState(true);
  const parent = parentPath(path);
  const where = under && (parent === under || parent.startsWith(`${under}/`)) ? parent.slice(under.length).replace(/^\//, '') || '.' : parent;
  return (
    <UnstyledButton onClick={() => revealNodeInNewTab(path)} title={path} className='mrx-nodes-found'>
      <Group gap={8} wrap='nowrap'>
        <div style={{ width: THUMB, height: THUMB, flexShrink: 0, borderRadius: 1, background: 'var(--mrx-surface-raised)', overflow: 'hidden' }}>
          {thumb && (
            <img
              src={gridUrl(path, true)}
              alt=''
              loading='lazy'
              onError={() => setThumb(false)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          )}
        </div>
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size='sm' ff='monospace' truncate>{baseName(path)}</Text>
          <Text size='xs' ff='monospace' c='dimmed' truncate>{where}</Text>
        </Stack>
        {note && <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{note}</Text>}
      </Group>
    </UnstyledButton>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <Stack gap={4}>
    <Text size='xs' c='dimmed' fw={600} tt='uppercase'>{title}</Text>
    {children}
  </Stack>
);

function Status<T>({ state, empty, children }: { state: Loaded<T> | null; empty: (value: T) => boolean; children: (value: T) => ReactNode }) {
  if (!state || state.kind === 'loading') return <Loader size='xs' />;
  if (state.kind === 'error') return <Text size='xs' c='dimmed'>{state.message}</Text>;
  if (empty(state.value)) return <Text size='xs' c='dimmed'>None found.</Text>;
  return <>{children(state.value)}</>;
}

const percent = (similarity: number) => `${Math.round(similarity * 100)}%`;

/**
 * One file's copies: those with its checksum, and — for a picture, a video or
 * a recording — those whose perceptual fingerprint lies close, which catches a
 * resized or re-encoded copy. Both are looked up as soon as the file is shown;
 * each is one query.
 */
function FileDuplicates({ path, mimetype }: { path: string; mimetype?: string }) {
  const media = /^(image|video|audio)\//.test(mimetype ?? '');
  const exact = useCommand<ExactDuplicatesOf>(`duplicates ${shq(path)}`);
  const fuzzy = useCommand<FuzzyDuplicatesOf>(media ? `duplicates --fuzzy ${shq(path)}` : null);
  const identical = new Set(exact?.kind === 'ready' ? exact.value.duplicates : []);

  return (
    <Stack gap='md'>
      <Section title='Identical'>
        <Status state={exact} empty={(value) => value.duplicates.length === 0}>
          {(value) => value.duplicates.map((each) => <FoundFile key={each} path={each} />)}
        </Status>
      </Section>
      {media && (
        <Section title='Similar'>
          <Status state={fuzzy} empty={(value) => value.duplicates.every((each) => identical.has(each.path))}>
            {(value) =>
              value.duplicates
                .filter((each) => !identical.has(each.path))
                .map((each) => <FoundFile key={each.path} path={each.path} note={percent(each.similarity)} />)}
          </Status>
        </Section>
      )}
    </Stack>
  );
}

/**
 * Media under a node with a copy anywhere, found on request. The identical
 * scan is asked `--against /`: on its own it keeps only copies that are both
 * inside the subtree, while the similar scan keeps any pair with one end in it.
 */
function SubtreeDuplicates({ path }: { path: string }) {
  const [mode, setMode] = useState<ScanMode>('exact');
  const [scan, setScan] = useState<Loaded<Scan> | null>(null);

  useEffect(() => {
    const kept = scans.get(scanKey(mode, path));
    setScan(kept ? { kind: 'ready', value: kept } : null);
  }, [mode, path]);

  const run = async () => {
    const key = scanKey(mode, path);
    setScan({ kind: 'loading' });
    try {
      const value: Scan = mode === 'exact'
        ? { mode, result: await execCommand<ExactDuplicateScan>(`duplicates ${shq(path)} --against /`) }
        : { mode, result: await execCommand<FuzzyDuplicateScan>(`duplicates --fuzzy ${shq(path)}`) };
      scans.set(key, value);
      setScan((current) => current?.kind === 'loading' ? { kind: 'ready', value } : current);
    } catch (err) {
      setScan({ kind: 'error', message: messageOf(err) });
    }
  };

  const groups = scan?.kind === 'ready'
    ? scan.value.mode === 'exact'
      ? scan.value.result.groups.map((group) => ({
        key: group.sha256,
        title: `${group.count} copies · ${formatBytes(group.size)} each`,
        paths: group.paths.map((each) => typeof each === 'string' ? each : each.path),
      }))
      : scan.value.result.clusters.map((cluster) => ({
        key: cluster.members[0],
        title: `${cluster.members.length} similar · up to ${percent(cluster.topSimilarity)}`,
        paths: cluster.members,
      }))
    : [];
  const summary = scan?.kind === 'ready'
    ? scan.value.mode === 'exact'
      ? `${scan.value.result.totalGroups} ${scan.value.result.totalGroups === 1 ? 'group' : 'groups'}; ${formatBytes(scan.value.result.totalReclaimable)} could be freed.`
      : `${scan.value.result.totalClusters} ${scan.value.result.totalClusters === 1 ? 'group' : 'groups'} of similar pictures, videos or recordings.`
    : null;

  return (
    <Stack gap='sm'>
      <Text size='xs' c='dimmed'>Pictures, videos and recordings under this node that have a copy, here or anywhere else in the archive.</Text>
      <Group gap='xs' wrap='nowrap'>
        <SegmentedControl
          size='xs'
          style={{ flex: 1 }}
          value={mode}
          onChange={(value) => setMode(value as ScanMode)}
          data={[{ value: 'exact', label: 'Identical' }, { value: 'fuzzy', label: 'Similar' }]}
        />
        <Button size='compact-sm' leftSection={<TablerIcon name='search' size={14} />} onClick={run} loading={scan?.kind === 'loading'}>
          {scan?.kind === 'ready' ? 'Again' : 'Find'}
        </Button>
      </Group>
      {scan?.kind === 'error' && (
        <Alert color='red' variant='light' icon={<TablerIcon name='alert-triangle' size={16} />}>
          {scan.message}
        </Alert>
      )}
      {summary && <Text size='sm'>{summary}</Text>}
      {groups.slice(0, SHOWN_GROUPS).map((group) => (
        <Section key={group.key} title={group.title}>
          {group.paths.map((each) => <FoundFile key={each} path={each} under={path} />)}
        </Section>
      ))}
      {groups.length > SHOWN_GROUPS && <Text size='xs' c='dimmed'>The first {SHOWN_GROUPS} of {groups.length}.</Text>}
    </Stack>
  );
}

/**
 * The Duplicates tool: for a file, its copies; for anything else, the copies
 * found under it. A result opens in the node explorer in a new tab with the file
 * selected, where this tool then shows that file's own copies.
 */
export function NodeDuplicates({ path, type, mimetype }: { path: string; type: string; mimetype?: string }) {
  return type === 'file' ? <FileDuplicates key={path} path={path} mimetype={mimetype} /> : <SubtreeDuplicates key={path} path={path} />;
}
