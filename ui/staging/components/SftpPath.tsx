import { TablerIcon } from '@ein/ui/components';
import { DOCS_GUIDE_PATH } from '@ein/paths';
import { ActionIcon, Anchor, Code, CopyButton, Group, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';

/** The guide's page on copying files in over SFTP. */
const SFTP_GUIDE = `/docs/${encodeURIComponent(`${DOCS_GUIDE_PATH}/ssh-sftp.md`)}`;

/**
 * A staging folder to copy files into over SFTP or scp, with a button that copies the path and a
 * link to the guide's page on how.
 */
export function SftpPath({ path }: { path: string }) {
  return (
    <Group gap='xs' wrap='nowrap'>
      <Code style={{ overflowWrap: 'anywhere' }}>{path}</Code>
      <CopyButton value={path}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : 'Copy the path'}>
            <ActionIcon variant='subtle' color={copied ? 'teal' : 'gray'} onClick={copy} aria-label='Copy the path'>
              <TablerIcon name={copied ? 'check' : 'copy'} size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
      <Anchor component={Link} to={SFTP_GUIDE} size='sm' style={{ whiteSpace: 'nowrap' }}>How</Anchor>
    </Group>
  );
}
