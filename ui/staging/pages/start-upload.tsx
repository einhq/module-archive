import { openDialog } from '@ein/ui/signals';
import { Button } from '@mantine/core';

/**
 * The home page's way to begin while its News is empty (a `home.start` panel, for the signed in):
 * a button that opens Import media, where pictures go into Staging.
 */
export default function StartUpload() {
  return <Button variant='light' onClick={() => openDialog('/staging/import')}>Import media</Button>;
}
