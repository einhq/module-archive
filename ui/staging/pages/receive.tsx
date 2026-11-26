import { useSurface } from '@ein/ui/hooks';
import { addToQueue, currentUser, takeSharedFiles } from '@ein/ui/signals';
import { Alert, Loader } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef, useState } from 'react';
import { useStagingStatus } from '../hooks/useStagingStatus.ts';

/** The shell's dialog takes its frame from here, for the moment the files are queued. */
export const handle = { title: 'Upload', icon: 'upload', pattern: 'staging', dialogSize: 'sm', signedIn: true };

/**
 * `/staging/receive`, the `share.receive` panel: the files another app shared to EiN are queued
 * into today's upload folder of the reader's default staging category, and that category's page
 * opens while they upload.
 */
export default function ReceivePage() {
  useSignals();
  const user = currentUser.value?.username;
  if (!user) return <Alert color='yellow'>Sign in to upload into your private staging area.</Alert>;
  return <Receive user={user} />;
}

function Receive({ user }: { user: string }) {
  const surface = useSurface();
  const status = useStagingStatus(user);
  const [files] = useState<File[]>(takeSharedFiles);
  const queued = useRef(false);
  const target = status.data?.categories.find((category) => category.name === status.data?.defaultCategory);

  useEffect(() => {
    if (!target || queued.current) return;
    queued.current = true;
    if (files.length > 0) addToQueue(files, target.uploadPath, { label: target.label });
    surface.openPage(`/staging?c=${encodeURIComponent(target.name)}`);
  }, [target]);

  if (status.error) return <Alert color='red' variant='light'>{status.error.message}</Alert>;
  return <Loader size='sm' />;
}
