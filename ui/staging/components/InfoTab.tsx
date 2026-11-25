import type { StagingCategoryStatus } from '@archive/staging/api';
import { Stack, Text } from '@mantine/core';
import { PhoneBackup } from './PhoneBackup.tsx';
import { SftpPath } from './SftpPath.tsx';

/** A section's head, in the style of the Sort tab's columns. */
const Head = ({ children }: { children: string }) => <Text size='xs' fw={700} tt='uppercase' c='dimmed'>{children}</Text>;

/**
 * How files get into `category`: its folder under `files/`, the path to copy them to over SFTP,
 * and what a phone's backup app is given to send its new photos there.
 */
export function InfoTab({ category }: { category: StagingCategoryStatus }) {
  return (
    <Stack gap='lg' px='md' maw={720}>
      <Stack gap={4}>
        <Head>Folder</Head>
        <Text size='sm'>
          {category.label} is the folder <Text span ff='monospace' size='sm'>files/{category.name}</Text>{' '}
          of your staging area. Upload to it from this page, or drop files anywhere on it.
        </Text>
      </Stack>
      <Stack gap={4}>
        <Head>SFTP</Head>
        <Text size='sm'>Tens of thousands of files, such as an export or a box of scans, are best copied over SFTP, into</Text>
        <SftpPath path={`${category.path}/`} />
      </Stack>
      <Stack gap={4}>
        <Head>Phone backup</Head>
        <PhoneBackup path={category.path} label={category.label} />
      </Stack>
    </Stack>
  );
}
