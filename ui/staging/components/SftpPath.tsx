import { Anchor } from '@mantine/core';
import { Link } from 'react-router-dom';
import { CopyValue } from './CopyValue.tsx';

/** The guide's section on copying files in over SFTP. */
const SFTP_GUIDE = '/docs/shell/ssh-sftp#copy-files-with-sftp';

/**
 * A staging folder to copy files into over SFTP or scp, with a button that copies the path and a
 * link to the guide's page on how.
 */
export function SftpPath({ path }: { path: string }) {
  return (
    <CopyValue value={path} label='Copy the path'>
      <Anchor component={Link} to={SFTP_GUIDE} size='sm' style={{ whiteSpace: 'nowrap' }}>How</Anchor>
    </CopyValue>
  );
}
