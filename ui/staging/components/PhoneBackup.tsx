import { appBackup, appBackupSet, davUrl, inEinApp } from '@ein/ui/lib';
import { notify } from '@ein/ui/signals';
import { Anchor, Button, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { InfoFact } from '../../components/InfoSection.tsx';
import { CopyValue } from './CopyValue.tsx';

/** The guide's section on a phone that backs itself up. */
const PHONE_GUIDE = '/docs/guide/phone#back-up-your-phone-automatically';

/** The administrators' section on serving EiN over HTTPS. */
const HTTPS_GUIDE = '/docs/admin/network#put-ein-behind-https';

/**
 * How a phone sends its new photos into the category at `path` (called `label`) by itself. In the
 * EiN app, a button that turns the app's photo backup on to send here; its App page has the rest.
 * Elsewhere, what a backup app is given: EiN's WebDAV address and the category's folder, a row each
 * of an Info section with a button that copies it. Such an app takes WebDAV over HTTPS only, so on a
 * page reached over plain HTTP it says what is missing.
 */
export function PhoneBackup({ path, label }: { path: string; label: string }) {
  if (inEinApp()) return <AppBackupHere path={path} label={label} />;
  const secure = location.protocol === 'https:';
  return (
    <>
      <Text size='sm' c='dimmed'>Let an app on your phone send its new photos here by itself, over WebDAV.</Text>
      <InfoFact label='Address'>
        <CopyValue value={`${location.origin}${davUrl()}`} label='Copy the address' />
      </InfoFact>
      <InfoFact label='Folder'>
        <CopyValue value={`${path}/`} label='Copy the folder'>
          <Anchor component={Link} to={PHONE_GUIDE} size='sm' style={{ whiteSpace: 'nowrap' }}>How</Anchor>
        </CopyValue>
      </InfoFact>
      {!secure && (
        <Text size='sm' c='dimmed'>
          A phone app needs EiN at an address that begins with https://, which your administrator gives you. <Anchor component={Link} to={HTTPS_GUIDE} size='sm'>HTTPS</Anchor>
        </Text>
      )}
    </>
  );
}

/** The app's photo backup into this category: whether it sends here, and a button that turns it on to send here. */
function AppBackupHere({ path, label }: { path: string; label: string }) {
  const [into, setInto] = useState<string | null>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    appBackup().then((backup) => setInto(backup.into?.dir ?? null), () => setInto(null));
  }, []);

  const choose = async () => {
    setBusy(true);
    try {
      setInto((await appBackupSet({ into: { dir: path, label }, enabled: true })).into?.dir ?? null);
    } catch (error) {
      notify({ message: error instanceof Error ? error.message : String(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };

  if (into === undefined) return null;
  return (
    <Stack gap={4} align='flex-start'>
      {into === path
        ? <Text size='sm' c='dimmed'>This phone backs up its photos here.</Text>
        : <Button variant='default' loading={busy} onClick={() => void choose()}>Back up this phone here</Button>}
      <Anchor component={Link} to='/app' size='sm'>Photo backup in App</Anchor>
    </Stack>
  );
}
