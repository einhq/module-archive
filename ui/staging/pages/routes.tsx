import { stagingRoots } from '@archive/staging/paths';
import { EntityDetailHeader, NodeBrowser } from '@ein/ui/components';
import { currentUser } from '@ein/ui/signals';
import { Alert, Box, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useNavigate } from 'react-router-dom';
import { GpxDetails } from '../../location/components/GpxDetails.tsx';
import { isGpx, RouteImport } from '../../location/components/RouteImport.tsx';
import { refreshStagingStatus } from '../hooks/useStagingStatus.ts';

export const handle = { fullBleed: true, signedIn: true };

const SUBTITLE =
  'These GPX files do not name a camera the archive knows. Select the ones one camera recorded, choose that camera, and their routes join its track. The panel says what the file you are on holds.';

/**
 * `/staging/routes`: the GPX files waiting in the reader's staging area (`routes/`, where
 * `track-stage` keeps a staged one that names no single camera it knows), whichever category they
 * were dropped on, in the Nodes page's listing below the header and filling the rest of the page.
 * Its side panel imports the selected files into the camera chosen for them, over what the
 * current file says of itself (`gpx-info`).
 */
export default function RoutesPage() {
  useSignals();
  const navigate = useNavigate();
  const user = currentUser.value?.username;
  if (!user) return <Alert color='yellow' m='lg'>Sign in to give routes their camera.</Alert>;
  return (
    <Box style={{ height: 'calc(100dvh - var(--app-shell-header-height))', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <EntityDetailHeader
        eyebrow='Staging'
        title='Routes waiting for a camera'
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>}
        flowContent
        actions={{ items: [{ label: 'Back to staging', icon: 'arrow-left', onClick: () => navigate('/staging') }] }}
      />
      <Box style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <NodeBrowser
          path={stagingRoots(user).routesPath}
          actions={({ selection, directory }) => <RouteImport selection={selection} directory={directory} onImported={refreshStagingStatus} />}
          details={({ path, entry }) => entry?.node.type === 'file' && isGpx(path) ? <GpxDetails path={path} /> : undefined}
        />
      </Box>
    </Box>
  );
}
