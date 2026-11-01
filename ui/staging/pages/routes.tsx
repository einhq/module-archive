import { stagingRoots } from '@archive/staging/paths';
import { EntityDetailHeader } from '@ein/ui/components';
import { currentUser } from '@ein/ui/signals';
import { Alert, Box, Text } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useNavigate } from 'react-router-dom';
import { StagedRoutes } from '../../location/components/StagedRoutes.tsx';
import { refreshStagingStatus } from '../hooks/useStagingStatus.ts';

export const handle = { fullBleed: true, signedIn: true };

const SUBTITLE = 'These GPX files do not name a device the archive knows. Tick the ones one device recorded, choose that device, and their routes join its track.';

/**
 * `/staging/routes`: the GPX files waiting in the reader's staging area (`routes/`, where
 * `track-stage` keeps a staged one that names no single device it knows), whichever category they
 * were dropped on, to give each the device that recorded it.
 */
export default function RoutesPage() {
  useSignals();
  const navigate = useNavigate();
  const user = currentUser.value?.username;
  if (!user) return <Alert color='yellow' m='lg'>Sign in to give routes their device.</Alert>;
  return (
    <>
      <EntityDetailHeader
        eyebrow='Staging'
        title='Routes waiting for a device'
        pattern='mixed'
        subtitle={<Text size='sm' c='gray.2'>{SUBTITLE}</Text>}
        flowContent
        actions={{ items: [{ label: 'Back to staging', icon: 'arrow-left', onClick: () => navigate('/staging') }] }}
      />
      <Box p='lg'>
        <StagedRoutes routes={stagingRoots(user).routesPath} onImported={refreshStagingStatus} />
      </Box>
    </>
  );
}
