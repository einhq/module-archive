import type { StagingCategoryStatus } from '@archive/staging/api';
import { SimpleGrid, Text } from '@mantine/core';
import { InfoFact, InfoSection } from '../../components/InfoSection.tsx';
import { PhoneBackup } from './PhoneBackup.tsx';
import { SftpPath } from './SftpPath.tsx';

/**
 * How files get into `category`, a box for each way: its folder under `files/` and uploading from
 * the page, the path to copy them to over SFTP, and what a phone's backup app is given to send its
 * new photos there.
 */
export function InfoTab({ category }: { category: StagingCategoryStatus }) {
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing='md' px='md' maw={1100}>
      <InfoSection title='Folder'>
        <InfoFact label='Name'>{category.label}</InfoFact>
        <InfoFact label='Folder'>
          <Text span ff='monospace' size='sm'>files/{category.name}</Text>
        </InfoFact>
        <InfoFact label='Upload'>From this page, or drop files anywhere on it.</InfoFact>
      </InfoSection>
      <InfoSection title='SFTP'>
        <Text size='sm' c='dimmed'>For tens of thousands of files, such as an export or a box of scans.</Text>
        <InfoFact label='Copy into'>
          <SftpPath path={`${category.path}/`} />
        </InfoFact>
      </InfoSection>
      <InfoSection title='Phone backup'>
        <PhoneBackup path={category.path} label={category.label} />
      </InfoSection>
    </SimpleGrid>
  );
}
