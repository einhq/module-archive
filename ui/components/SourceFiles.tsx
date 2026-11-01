import { Anchor, Group, Text } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import { fileUrl, formatBytes } from '@ein/ui/lib';
import type { SourceFile } from '@archive/sources/api';

/**
 * The files a node was read from (`source-list`), one row each: the file to download, and its
 * size. A link whose file is gone says so.
 */
export function SourceFiles({ files }: { files: SourceFile[] }) {
  return (
    <>
      {files.map((file) => (
        <Group key={file.path} gap={6} wrap='nowrap' justify='space-between'>
          <Group gap={6} wrap='nowrap' style={{ minWidth: 0 }}>
            <TablerIcon name='file-text' size={15} color='var(--mantine-color-dimmed)' style={{ flexShrink: 0 }} />
            {file.missing
              ? <Text size='sm' c='dimmed' truncate>{file.name}</Text>
              : <Anchor href={fileUrl(file.path)} download={file.name} size='sm' truncate>{file.name}</Anchor>}
          </Group>
          <Text size='xs' c='dimmed' style={{ flexShrink: 0 }}>{file.missing ? 'missing' : formatBytes(file.size)}</Text>
        </Group>
      ))}
    </>
  );
}
