import type { StagingCategoryAnswer, StagingCategoryStatus } from '@archive/staging/api';
import { appBackup, appBackupSet, appInfo, type EinAppBackupInto, shq } from '@ein/ui/lib';
import { currentUser, execCommand, notify } from '@ein/ui/signals';
import { Select } from '@mantine/core';
import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useState } from 'react';
import { refreshStagingStatus, useStagingStatus } from '../hooks/useStagingStatus.ts';
import { categorySlug, freeSlug, PHONE_KINDS } from '../lib/overview.ts';

/** The choice that makes a new category for the phone rather than naming one. */
const NEW = '\u0000new';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The categories a phone's photos may go into: those that hold a phone's first, then the rest, as the area lists them. */
const byPhoneFirst = (categories: StagingCategoryStatus[]): StagingCategoryStatus[] => [
  ...categories.filter((category) => PHONE_KINDS.includes(category.kind)),
  ...categories.filter((category) => !PHONE_KINDS.includes(category.kind)),
];

/**
 * `/staging/app-backup`, the EiN app's `app.backup` panel on its App page: which of the reader's
 * staging categories the phone's photo backup sends into, or a new `phone` category called after
 * the phone (`staging category --create`), handed to the app (`appBackupSet`). What it sends then
 * waits there to be sorted, as an upload does.
 */
export default function AppBackupPanel() {
  useSignals();
  const user = currentUser.value?.username;
  return user ? <Chooser user={user} /> : null;
}

function Chooser({ user }: { user: string }) {
  const status = useStagingStatus(user);
  const categories = byPhoneFirst(status.data?.categories ?? []);
  const [into, setInto] = useState<EinAppBackupInto>();
  const [phone, setPhone] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    appBackup().then((backup) => setInto(backup.into), () => {});
    appInfo().then((info) => setPhone(info.device), () => {});
  }, []);

  const chosen = categories.find((category) => category.path === into?.dir);
  const newLabel = phone ?? 'Phone';
  const newName = freeSlug(categorySlug(newLabel), categories.map((category) => category.name)) || freeSlug('phone', categories.map((category) => category.name));

  const choose = async (value: string | null) => {
    if (value === null) return;
    setBusy(true);
    try {
      let category = categories.find((each) => each.name === value);
      if (value === NEW) {
        const answer = await execCommand<StagingCategoryAnswer>(`staging category ${shq(newName)} --create --kind phone --label ${shq(newLabel)}`);
        refreshStagingStatus();
        category = answer.category ?? undefined;
      }
      if (!category) return;
      const backup = await appBackupSet({ into: { dir: category.path, label: category.label } });
      setInto(backup.into);
    } catch (error) {
      notify({ message: messageOf(error), color: 'red' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Select
      label='Back up into'
      description={chosen
        ? `A staging category: what the phone sends waits there, in files/${chosen.name}, until you sort it.`
        : 'A staging category, where what the phone sends waits until you sort it.'}
      placeholder={into ? into.label : 'Choose a category'}
      data={[
        ...categories.map((category) => ({ value: category.name, label: category.label })),
        { value: NEW, label: `New category: ${newLabel}` },
      ]}
      value={chosen?.name ?? null}
      allowDeselect={false}
      disabled={busy || status.loading}
      onChange={(value) => void choose(value)}
      error={status.error?.message}
      comboboxProps={{ withinPortal: true }}
    />
  );
}
