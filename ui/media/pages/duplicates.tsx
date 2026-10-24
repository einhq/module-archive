import { Text } from '@mantine/core';
import { PageLoader } from '@ein/ui/components';
import { useNodeStat } from '@ein/ui/hooks';
import { useSearchParams } from 'react-router-dom';
import { NodeDuplicates } from '../components/NodeDuplicates.tsx';

/**
 * A node's copies (`?path=<node>`): for a file, those with its checksum and, for media, its
 * fingerprint; for anything else, the copies found under it on request. The node explorer shows
 * it as a tool (`archive.duplicates`, a `nodes.tools` panel in archive's `nav.json`), given the
 * row it is on; opened by its URL it is a page of its own.
 */
export default function DuplicatesPage() {
  const [params] = useSearchParams();
  const path = params.get('path') ?? '';
  const { stat, statPath, error } = useNodeStat(path || null);

  if (!path) return <Text size='sm' c='dimmed'>No node given.</Text>;
  if (error) return <Text size='sm' c='dimmed'>{error.message}</Text>;
  if (!stat || statPath !== path) return <PageLoader />;
  const mimetype = typeof stat.node.attrs.mimetype === 'string' ? stat.node.attrs.mimetype : undefined;
  return <NodeDuplicates path={path} type={stat.node.type} mimetype={mimetype} />;
}
